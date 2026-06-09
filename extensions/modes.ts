/**
 * pi-plan extension
 *
 * Adds three operating modes to pi:
 *   - Cmd (default): pi works normally - user asks, ai executes.
 *   - Plan: ai writes a markdown plan into `~/.pi/agent/plans/` (the plan folder).
 *           No bash / write / edit outside of `~/.pi/agent/plans/` is allowed.
 *           pi can later read & execute that plan in Cmd mode.
 *   - Ask:  ai just answers. No bash. No edits. No writes. Pure chat.
 *
 * Cycle modes with: Shift+Tab
 * The current mode is shown in the status bar, just before the model entry,
 * on the right-hand side.
 *
 * Commands:
 *   /mode            -> show current mode
 *   /mode cmd        -> switch to Cmd mode
 *   /mode plan       -> switch to Plan mode
 *   /mode ask        -> switch to Ask mode
 *   /plans           -> list existing plans in ~/.pi/agent/plans/
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chainEditor } from "./_editor-chain.ts";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, Key, Markdown, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Mode = "command" | "plan" | "ask";

const MODES: Mode[] = ["command", "plan", "ask"];

const MODE_LABEL: Record<Mode, string> = {
	command: "cmd",
	plan: "plan",
	ask: "ask",
};

const MODE_LABEL_TITLE: Record<Mode, string> = {
	command: "Cmd",
	plan: "Plan",
	ask: "Ask",
};

// ─── All custom colors in one place ──────────────────────────────────
// Each entry has a theme token (used with theme.fg()) and an optional hex
// value for custom colors that we register at runtime.
const COLORS = {
	// Mode label & input border per mode
	cmd:             { token: "piPlanCmdMode",            hex: "#979BA1", fallback: "dim"          }, // light gray
	plan:            { token: "accent"                                                             }, // cyan (built-in)
	ask:             { token: "success"                                                             }, // green (built-in)

	// Bash-prefix mode (when input starts with `!`)
	bash:            { token: "piPlanBashCommand",         hex: "#E5C07B", fallback: "warning"      }, // muted amber

	// Thinking-level custom colors (registered at runtime)
	thinkingLow:     { token: "piPlanThinkingLow",         hex: "#56B6C2", fallback: "thinkingMedium" }, // muted teal
	thinkingBright:  { token: "piPlanThinkingBrightest",   hex: "#ff79e1", fallback: "thinkingXhigh"  }, // bright pink/magenta
} as const;

const MODE_COLOR: Record<Mode, string> = {
	command: COLORS.cmd.token,
	plan: COLORS.plan.token,
	ask: COLORS.ask.token,
};



// Tools considered "mutating" - blocked in Ask mode, restricted in Plan mode.
const MUTATING_TOOLS = new Set(["bash", "write", "edit", "multi_edit"]);
// Tools that only write/modify - always blocked in Ask mode.
const WRITE_ONLY_TOOLS = new Set(["write", "edit", "multi_edit"]);

// Bash commands considered safe (read-only) in Ask mode.
const SAFE_BASH_PREFIXES = [
	"grep", "rg", "find", "ls", "cat", "head", "tail", "wc",
	"file", "which", "where", "type", "dir", "tree", "echo",
	"pwd", "realpath", "stat", "du", "df", "env", "printenv",
	"git log", "git show", "git diff", "git status", "git branch",
	"git rev-parse", "git ls-files", "git blame",
];

function isSafeBashCommand(command: string): boolean {
	const trimmed = command.trim();
	return SAFE_BASH_PREFIXES.some((prefix) => {
		if (trimmed === prefix) return true;
		if (trimmed.startsWith(prefix + " ")) return true;
		if (trimmed.startsWith(prefix + "\t")) return true;
		return false;
	});
}

function plansDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "plans");
}

function ensurePlansDir(): string {
	const dir = plansDir();
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function isInsidePlansDir(targetPath: string): boolean {
	const abs = path.resolve(targetPath);
	const dir = path.resolve(plansDir());
	const rel = path.relative(dir, abs);
	return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function listPlans(): string[] {
	const dir = plansDir();
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort();
}

function buildRefinePlanPrompt(planFile: string): string {
	return (
		`Let's refine the plan at ${planFile}: ` +
		"Ask me for the missing details needed to refine the plan together. Do not rewrite the plan yet and do not make assumptions. " +
		"Ask clear, concrete questions and wait for my answers before drafting any plan changes.\n"
	);
}

function buildSuggestSpecificChangesPrompt(planFile: string, suggestion: string): string {
	return [
		`Apply these specific suggested changes to the plan at ${planFile}.`,
		"Read the existing plan first, update that same plan file, and do not ask follow-up questions unless the suggestion is impossible to apply safely.",
		"After updating the plan, briefly summarize what changed.",
		"",
		"Specific suggestion:",
		suggestion,
	].join("\n");
}

type KeybindingMatcher = {
	matches: (keyData: string, keybindingId: string) => boolean;
};

type PlanAction =
	| "Open plan for review"
	| "Refine with Q&A session"
	| "Suggest specific changes"
	| "Accept plan and build";

class PostPlanActionDialog {
	focused = true;
	private readonly actions: PlanAction[] = [
		"Open plan for review",
		"Refine with Q&A session",
		"Suggest specific changes",
		"Accept plan and build",
	];
	private selectedIndex = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: any,
		private readonly keybindings: KeybindingMatcher,
		private readonly onDone: (choice: PlanAction | undefined) => void,
	) {}

	handleInput(keyData: string): void {
		if (this.keybindings.matches(keyData, "tui.select.cancel")) {
			this.onDone(undefined);
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.up") || matchesKey(keyData, Key.up)) {
			this.selectedIndex = this.selectedIndex === 0 ? this.actions.length - 1 : this.selectedIndex - 1;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.down") || matchesKey(keyData, Key.down)) {
			this.selectedIndex = this.selectedIndex === this.actions.length - 1 ? 0 : this.selectedIndex + 1;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.confirm") || matchesKey(keyData, Key.enter)) {
			this.onDone(this.actions[this.selectedIndex]);
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const border = this.theme.fg("border", "─".repeat(Math.max(1, width)));
		const push = (line = "") => lines.push(truncateToWidth(line, width));

		push(border);
		push();
		push(this.theme.fg("accent", this.theme.bold("Plan saved! What would you like to do?")));
		push();

		for (let i = 0; i < this.actions.length; i++) {
			const selected = i === this.selectedIndex;
			const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
			const label = this.theme.fg(selected ? "accent" : "text", this.actions[i]);
			push(prefix + label);
		}

		push();
		push(this.theme.fg("dim", "↑↓ navigate • enter select • esc cancel"));
		push(border);
		return lines;
	}

	invalidate(): void {}
}

class SpecificSuggestionDialog implements Component, Focusable {
	private readonly input = new Input();
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		private readonly tui: TUI,
		private readonly theme: any,
		private readonly keybindings: KeybindingMatcher,
		private readonly onDone: (suggestion: string | undefined) => void,
	) {
		this.input.onSubmit = (value) => this.onDone(value);
		this.input.onEscape = () => this.onDone(undefined);
	}

	handleInput(keyData: string): void {
		if (this.keybindings.matches(keyData, "tui.select.cancel")) {
			this.onDone(undefined);
			return;
		}
		this.input.handleInput(keyData);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const border = this.theme.fg("border", "─".repeat(Math.max(1, width)));
		const push = (line = "") => lines.push(truncateToWidth(line, width));

		push(border);
		push();
		push(this.theme.fg("accent", this.theme.bold("Suggest specific changes")));
		push();
		for (const line of this.input.render(width)) {
			push(line);
		}
		push();
		push(this.theme.fg("dim", "enter submit • esc cancel"));
		push(border);
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
	}
}

class PlanReviewDialog {
	focused = true;
	private markdown: Markdown;
	private scrollOffset = 0;
	private viewHeight = 0;
	private totalLines = 0;
	private readonly planTitle: string;
	private readonly reviewContent: string;
	private readonly sectionHeadings: Set<string>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: any,
		private readonly keybindings: KeybindingMatcher,
		private readonly planFile: string,
		private readonly content: string,
		private readonly onClose: () => void,
	) {
		this.planTitle = this.extractPlanTitle();
		this.reviewContent = this.stripTitleFromContent();
		this.sectionHeadings = this.extractSectionHeadings();
		this.markdown = new Markdown(this.reviewContent, 0, 0, getMarkdownTheme());
	}

	private extractPlanTitle(): string {
		const heading = this.content.match(/^#\s+(.+)\s*$/m)?.[1]?.trim();
		if (heading) return heading;
		return path.basename(this.planFile, path.extname(this.planFile));
	}

	private stripTitleFromContent(): string {
		const withoutTitle = this.content.replace(/^#\s+.+\s*\r?\n?/, "").replace(/^\s*\r?\n/, "");
		const compactHeadings = withoutTitle.replace(/^(#{2,6}\s+.+)\r?\n[ \t]*\r?\n/gm, "$1\n");
		return compactHeadings.trim().length > 0 ? compactHeadings : "_No plan content._";
	}

	private extractSectionHeadings(): Set<string> {
		const headings = new Set<string>();
		const pattern = /^#{2,6}\s+(.+)\s*$/gm;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(this.reviewContent)) !== null) {
			const heading = match[1]?.trim();
			if (heading) headings.add(heading);
		}
		return headings;
	}

	private stripAnsi(text: string): string {
		return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
	}

	private compactRenderedHeadingSpacing(lines: string[]): string[] {
		if (this.sectionHeadings.size === 0) return lines;
		const compacted: string[] = [];
		for (const line of lines) {
			const previous = compacted[compacted.length - 1];
			const previousText = previous ? this.stripAnsi(previous).trim() : "";
			const currentText = this.stripAnsi(line).trim();
			if (!currentText && previousText && this.sectionHeadings.has(previousText)) {
				continue;
			}
			compacted.push(line);
		}
		return compacted;
	}

	handleInput(keyData: string): void {
		if (this.keybindings.matches(keyData, "tui.select.cancel")) {
			this.onClose();
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.up") || matchesKey(keyData, Key.up)) {
			this.scrollBy(-1);
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.down") || matchesKey(keyData, Key.down)) {
			this.scrollBy(1);
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.pageUp")) {
			this.scrollBy(-this.viewHeight || -1);
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.pageDown")) {
			this.scrollBy(this.viewHeight || 1);
		}
	}

	render(width: number): string[] {
		const maxHeight = this.getMaxHeight();
		const innerWidth = Math.max(10, width - 2);
		const chromeLines = 7; // top/title/path/separator/footer/separator/bottom
		const contentHeight = Math.max(1, maxHeight - chromeLines);

		let markdownWidth = Math.max(1, innerWidth - 4);
		let markdownLines = this.compactRenderedHeadingSpacing(this.markdown.render(markdownWidth));
		let hasScrollableContent = markdownLines.length > contentHeight;
		if (hasScrollableContent) {
			markdownWidth = Math.max(1, innerWidth - 5);
			markdownLines = this.compactRenderedHeadingSpacing(this.markdown.render(markdownWidth));
			hasScrollableContent = markdownLines.length > contentHeight;
		}

		this.totalLines = markdownLines.length;
		this.viewHeight = contentHeight;
		const maxScroll = Math.max(0, this.totalLines - contentHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visibleLines = markdownLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		const borderColor = (text: string) => this.theme.fg("dim", text);
		const boxLine = (content: string): string => {
			const truncated = truncateToWidth(content, innerWidth);
			const padding = Math.max(0, innerWidth - visibleWidth(truncated));
			return borderColor("│") + truncated + " ".repeat(padding) + borderColor("│");
		};
		const contentBoxLine = (content: string, rowIndex: number): string => {
			if (!hasScrollableContent) return boxLine(content);
			const contentWidth = Math.max(1, innerWidth - 1);
			const truncated = truncateToWidth(content, contentWidth);
			const padding = Math.max(0, contentWidth - visibleWidth(truncated));
			return borderColor("│") + truncated + " ".repeat(padding) + this.getScrollIndicatorForRow(rowIndex, contentHeight) + borderColor("│");
		};
		const separator = (): string => borderColor(`├${"─".repeat(innerWidth)}┤`);

		const title = this.theme.fg("accent", this.planTitle);
		const pathLabel = this.theme.fg("muted", this.planFile);
		const footer = [
			this.theme.fg("dim", "↑↓ scroll"),
			this.theme.fg("dim", "pgup/pgdn page"),
			this.theme.fg("dim", "esc back"),
		].join(this.theme.fg("muted", " • "));

		const output: string[] = [];
		output.push(borderColor(`╭${"─".repeat(innerWidth)}╮`));
		output.push(boxLine(`  ${title}`));
		output.push(boxLine(`  ${pathLabel}`));
		output.push(separator());
		const lineContentWidth = hasScrollableContent ? Math.max(1, innerWidth - 5) : Math.max(1, innerWidth - 4);
		for (let i = 0; i < contentHeight; i++) {
			const line = visibleLines[i] ?? "";
			output.push(contentBoxLine(`  ${truncateToWidth(line, lineContentWidth)}`, i));
		}
		output.push(separator());
		output.push(boxLine(`  ${footer}`));
		output.push(borderColor(`╰${"─".repeat(innerWidth)}╯`));
		return output.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.markdown = new Markdown(this.reviewContent, 0, 0, getMarkdownTheme());
	}

	private getMaxHeight(): number {
		const rows = this.tui.terminal.rows || 24;
		// Fill the screen area above pi's footer/status line instead of using a compact editor dialog.
		return Math.max(10, rows - 4);
	}

	private getScrollIndicatorForRow(rowIndex: number, trackHeight: number): string {
		if (this.totalLines <= this.viewHeight || trackHeight <= 0) return " ";
		const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
		const thumbHeight = Math.max(1, Math.round((this.viewHeight / this.totalLines) * trackHeight));
		const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
		const thumbTop = maxScroll === 0
			? 0
			: Math.round((this.scrollOffset / maxScroll) * maxThumbTop);
		const isThumbRow = rowIndex >= thumbTop && rowIndex < thumbTop + thumbHeight;
		return isThumbRow ? this.theme.fg("accent", "┃") : this.theme.fg("dim", "│");
	}

	private scrollBy(delta: number): void {
		const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, maxScroll));
		this.tui.requestRender();
	}
}

export default function piPlanExtension(pi: ExtensionAPI): void {
	let mode: Mode = "command";
	let activeTui: TUI | undefined;
	let lastWrittenPlanFile: string | null = null;
	let postPlanPromptScheduled = false;
	let pendingAutoAnswerForRefine = false;
	let pendingAutoAnswerPlanFile: string | null = null;
	let cachedRefineQuestions: any[] | null = null;
	let cachedRefineQuestionsPlanFile: string | null = null;
	let autoAnswerScheduled = false;
	let editorDraftIsBash = false;

	// ---- status bar ----
	// Use a key that sorts BEFORE "model" alphabetically so the mode badge
	// appears to the left of the model entry on the right side of the bar.
	// (pi orders status entries by registration order; we register early on
	// session_start to be safe, and use a stable key.)
	const STATUS_KEY = "aaa-pi-plan-mode";

	function renderStatus(ctx: ExtensionContext): void {
		const label = editorDraftIsBash ? "bash" : MODE_LABEL[mode];
		let painted = label;
		try {
			painted = editorDraftIsBash
				? ctx.ui.theme.fg(COLORS.bash.token, label)
				: ctx.ui.theme.fg(MODE_COLOR[mode], label);
		} catch {
			/* theme not ready - fall back to plain */
		}
		ctx.ui.setStatus(STATUS_KEY, painted);
	}

	function persist(): void {
		pi.appendEntry("pi-plan-mode", { mode });
	}

	function setMode(next: Mode, ctx: ExtensionContext, _announce = true): void {
		if (next === mode) return;
		mode = next;
		renderStatus(ctx);
		persist();
		activeTui?.requestRender();
		ctx.ui.notify(`Switched to ${MODE_LABEL_TITLE[mode]} mode`);
	}

	function cycleMode(ctx: ExtensionContext): void {
		const idx = MODES.indexOf(mode);
		const next = MODES[(idx + 1) % MODES.length];
		setMode(next, ctx);
	}

	// ---- shortcut: Shift+Tab ----
	// Note: also unbind `app.thinking.cycle` in ~/.pi/agent/keybindings.json
	// so Shift+Tab doesn't double-fire the built-in thinking-level cycler.
	pi.registerShortcut("shift+tab", {
		description: "Cycle pi-plan mode (Cmd / Plan / Ask)",
		handler: async (ctx) => cycleMode(ctx),
	});

	// ---- /mode cmd ----
	pi.registerCommand("mode", {
		description: "Show or switch pi-plan mode (cmd | plan | ask)",
		getArgumentCompletions: (prefix: string) => {
			const items = MODES.map((m) => ({ value: MODE_LABEL[m], label: MODE_LABEL[m] }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();
			if (!arg) {
				ctx.ui.notify(`Current mode: ${MODE_LABEL[mode]}`, "info");
				return;
			}
			const next = arg === "cmd" ? "command" : arg;
			if (!MODES.includes(next as Mode)) {
				ctx.ui.notify(`Unknown mode '${arg}'. Use: cmd, plan, ask`, "error");
				return;
			}
			setMode(next as Mode, ctx);
		},
	});

	// ---- /plans command ----
	pi.registerCommand("plans", {
		description: "List plans saved under ~/.pi/agent/plans/",
		handler: async (_args, ctx) => {
			const plans = listPlans();
			if (plans.length === 0) {
				ctx.ui.notify("No plans yet. Switch to Plan mode (Shift+Tab) and ask pi for a plan.", "info");
				return;
			}
			ctx.ui.notify(`Plans (${plans.length}):\n${plans.map((p) => `  • ${p}`).join("\n")}`, "info");
		},
	});

	// ---- gate tool calls based on mode ----
	// (Note: bash/edit/write blocking enforces what the system-prompt directive
	// merely advises - the LLM cannot bypass the gate even if it ignores prose.)
	pi.on("tool_call", async (event, ctx) => {
		if (mode === "command") return;

		const toolName = event.toolName;

		if (mode === "ask") {
			// Always block write/edit tools.
			if (WRITE_ONLY_TOOLS.has(toolName)) {
				return {
					block: true,
					reason: `Ask mode is active - the assistant must answer without running '${toolName}'. Switch modes with Shift+Tab (or /mode cmd) to allow it.`,
				};
			}
			// Allow bash only for read-only/search commands.
			if (toolName === "bash") {
				const cmd = (event.input as { command?: string }).command ?? "";
				if (!isSafeBashCommand(cmd)) {
					return {
						block: true,
						reason: `Ask mode is active - only read-only commands (grep, find, ls, git log, etc.) are allowed. Switch modes with Shift+Tab (or /mode cmd) to run '${cmd.split(" ")[0]}'.`,
					};
				}
			}
			return;
		}

		// mode === "plan"
		// In Plan mode the assistant may read/search the codebase freely,
		// but is only allowed to create/refine Markdown plans under ~/.pi/agent/plans/.
		if (toolName === "bash") {
			return {
				block: true,
				reason: "Plan mode: bash is disabled. Use the write tool to save your plan into ~/.pi/agent/plans/<name>.md instead.",
			};
		}
		if (toolName === "edit" || toolName === "multi_edit") {
			const target = (event.input as { path?: string; file_path?: string }).path
				?? (event.input as { path?: string; file_path?: string }).file_path;
			if (!target || !isInsidePlansDir(target)) {
				return {
					block: true,
					reason: "Plan mode: edits are only allowed inside ~/.pi/agent/plans/. Use this to refine an existing plan there.",
				};
			}
			// Track refined plan files too, so the post-plan prompt appears after edits,
			// not only after first-time writes.
			lastWrittenPlanFile = target;
			return;
		}
		if (toolName === "write") {
			const target = (event.input as { path?: string; file_path?: string }).path
				?? (event.input as { path?: string; file_path?: string }).file_path;
			if (!target || !isInsidePlansDir(target)) {
				return {
					block: true,
					reason: "Plan mode: write is only allowed under ~/.pi/agent/plans/. Use a path like ~/.pi/agent/plans/<name>.md",
				};
			}
			// Make sure the directory exists so write doesn't fail.
			ensurePlansDir();
			// Track the written plan file for the post-agent review prompt.
			lastWrittenPlanFile = target;
			return;
		}
	});

	// ---- reset plan file tracking on each agent run ----
	pi.on("agent_start", async (_event, _ctx) => {
		lastWrittenPlanFile = null;
	});

	async function showPostPlanPrompt(planFile: string, ctx: ExtensionContext): Promise<void> {
		renderStatus(ctx);
		while (mode === "plan") {
			renderStatus(ctx);
			const choice = await ctx.ui.custom<PlanAction | undefined>((tui, theme, keybindings, done) => {
				return new PostPlanActionDialog(tui, theme, keybindings, done);
			});

			if (choice === "Open plan for review") {
				try {
					const content = fs.readFileSync(planFile, "utf8");
					await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
						return new PlanReviewDialog(tui, theme, keybindings, planFile, content, () => done());
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Could not open plan for review: ${message}`, "error");
				}
				continue;
			}

			if (choice === "Refine with Q&A session") {
				pendingAutoAnswerForRefine = true;
				pendingAutoAnswerPlanFile = planFile;
				if (cachedRefineQuestionsPlanFile === planFile && cachedRefineQuestions?.length) {
					pendingAutoAnswerForRefine = false;
					pendingAutoAnswerPlanFile = null;
					await runAnswerForRefine(ctx, planFile);
					return;
				}
				await pi.sendUserMessage(buildRefinePlanPrompt(planFile));
				return;
			}

			if (choice === "Suggest specific changes") {
				const suggestion = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
					return new SpecificSuggestionDialog(tui, theme, keybindings, done);
				});
				if (!suggestion?.trim()) {
					continue;
				}
				await pi.sendUserMessage(buildSuggestSpecificChangesPrompt(planFile, suggestion.trim()));
				return;
			}

			if (choice === "Accept plan and build") {
				setMode("command", ctx, false);
				await pi.sendUserMessage(`Execute the plan at ${planFile}. Read it first, then follow its Steps section.`);
				return;
			}

			// If undefined (Escape), do nothing — stay in plan mode
			return;
		}
	}

	function schedulePostPlanPrompt(planFile: string, ctx: ExtensionContext): void {
		if (postPlanPromptScheduled) return;
		postPlanPromptScheduled = true;

		const waitForFinished = () => {
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				setTimeout(waitForFinished, 100);
				return;
			}

			void (async () => {
				try {
					if (mode === "plan") {
						await showPostPlanPrompt(planFile, ctx);
					}
				} finally {
					postPlanPromptScheduled = false;
				}
			})();
		};

		setTimeout(waitForFinished, 0);
	}

	async function runAnswerForRefine(ctx: ExtensionContext, planFile: string): Promise<void> {
		if (mode !== "plan") return;
		const answerHandler = (globalThis as any).__piAnswerHandler;
		if (typeof answerHandler !== "function") {
			ctx.ui.notify("Could not auto-open answer UI: /answer handler is not loaded", "error");
			return;
		}
		const result = await answerHandler(ctx, {
			cancelMessage: false,
			cancelControlLabel: "back to plan",
			statusLabel: "plan",
			questions: cachedRefineQuestionsPlanFile === planFile ? cachedRefineQuestions ?? undefined : undefined,
			onQuestions: (questions: any[]) => {
				cachedRefineQuestions = questions;
				cachedRefineQuestionsPlanFile = planFile;
			},
		});
		if (result === "submitted") {
			cachedRefineQuestions = null;
			cachedRefineQuestionsPlanFile = null;
		}
		if (result === "cancelled" && mode === "plan") {
			await showPostPlanPrompt(planFile, ctx);
		}
	}

	function scheduleAutoAnswerForRefine(ctx: ExtensionContext, planFile: string): void {
		if (autoAnswerScheduled) return;
		autoAnswerScheduled = true;

		const waitForFinished = () => {
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				setTimeout(waitForFinished, 100);
				return;
			}

			void (async () => {
				try {
					await runAnswerForRefine(ctx, planFile);
				} finally {
					autoAnswerScheduled = false;
				}
			})();
		};

		setTimeout(waitForFinished, 0);
	}

	// ---- post-plan review prompt ----
	pi.on("agent_end", async (_event, ctx) => {
		if (mode !== "plan") return;

		if (pendingAutoAnswerForRefine) {
			pendingAutoAnswerForRefine = false;
			const planFile = pendingAutoAnswerPlanFile;
			pendingAutoAnswerPlanFile = null;
			if (planFile) {
				scheduleAutoAnswerForRefine(ctx, planFile);
			}
			return;
		}

		if (!lastWrittenPlanFile) return;

		const planFile = lastWrittenPlanFile;
		lastWrittenPlanFile = null;

		// `agent_end` fires before the session fully leaves its streaming state.
		// If the post-plan dialog is shown immediately, selecting "Accept plan and build"
		// can race with the still-processing agent turn and trigger:
		// "Agent is already processing. Specify streamingBehavior...".
		// Defer the dialog until pi reports that the agent is completely idle.
		schedulePostPlanPrompt(planFile, ctx);
	});

	// ---- inject per-mode guidance for the LLM via the system prompt ----
	// We append to event.systemPrompt instead of injecting a visible message,
	// so nothing shows up above the prompt input.
	pi.on("before_agent_start", async (event, ctx) => {
		ensurePlansDir();
		const plans = listPlans();
		const planList = plans.length > 0 ? plans.map((p) => `  - ~/.pi/agent/plans/${p}`).join("\n") : "  (none yet)";

		let directive: string;
		if (mode === "ask") {
			directive = [
				"[PI-PLAN MODE: ASK]",
				"You are in Ask mode. Answer the user's question conversationally.",
				"Do NOT call write, edit, or any tool that modifies the system.",
				"You MAY use read-only tools to search and gather information:",
				"  - read (to view files)",
				"  - bash with: grep, rg, find, ls, cat, head, tail, wc, tree, git log/diff/status/show/branch/blame",
				"Do NOT use bash for anything that writes, creates, deletes, or modifies files.",
				"Prefer answering from your own knowledge first; search only when needed for accuracy.",
			].join("\n");
		} else if (mode === "plan") {
			directive = [
				"[PI-PLAN MODE: PLAN]",
				"You are in Plan mode. Your job is to PRODUCE OR REFINE A PLAN, not to execute it.",
				"",
				"Rules:",
				"  - Do NOT run bash.",
				"  - Do NOT edit or write any file outside of `~/.pi/agent/plans/`.",
				"  - You MAY use read/search tools to investigate the codebase and existing plan files.",
				"  - When creating a new plan, save it as Markdown using the `write` tool to:",
				"      ~/.pi/agent/plans/<short-kebab-case-name>.md",
				"  - When refining an existing plan, read the plan first and update that same file under `~/.pi/agent/plans/` using `edit` or `write`.",
				"  - If the user asks to refine a plan but missing details would materially change the plan, ask clear questions and wait for answers before editing.",
				"  - The plan file should contain:",
				"      # Title",
				"      ## Goal        (1-3 sentences)",
				"      ## Context     (key files / constraints)",
				"      ## Steps       (numbered, actionable, ordered)",
				"      ## Verification (how to confirm success)",
				"  - After saving or refining, briefly tell the user the plan path and a short summary.",
				"  - The user will be prompted to open the plan for review, refine and suggest changes, or accept and build.",
				"",
				"Existing plans in this project:",
				planList,
			].join("\n");
		} else {
			// cmd mode
			directive = [
				"[PI-PLAN MODE: CMD]",
				"You have full tool access. Execute the user's request normally.",
				"",
				"If the user refers to 'the plan' or 'my plan', look under `~/.pi/agent/plans/`:",
				planList,
				"Read the relevant plan file and follow its Steps section.",
			].join("\n");
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${directive}`,
		};
	});

	// ---- mirror the per-thinking-level border color onto the thinking text ----
	// pi normally paints the editor border using the `thinking<Level>` theme
	// color but renders thinking traces themselves with the single `thinkingText`
	// color. We override `thinkingText` at runtime so it matches the current
	// thinking level, giving the same visual hierarchy in the thinking blocks.
	//
	// Color shift: each level borrows the *next* level's color, and `xhigh`
	// uses an even brighter custom color. This makes the lower levels easier
	// to distinguish.
	const THINKING_LEVEL_TOKEN: Record<string, string> = {
		off: "thinkingOff",
		minimal: "thinkingLow",
		low: COLORS.thinkingLow.token,
		medium: "thinkingHigh",
		high: "thinkingXhigh",
		xhigh: COLORS.thinkingBright.token,
	};

	// Inject custom colors into the active theme's fgColors map so
	// `theme.fg(<token>, ...)` works just like any built-in token.
	function installBrightestColor(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			const theme = ctx.ui.theme as unknown as {
				fgColors?: Map<string, string>;
				mode?: string;
			};
			if (!theme?.fgColors) return;
			const toAnsi = (hex: string, fallbackToken: string): string => {
				const h = hex.slice(1);
				const r = parseInt(h.slice(0, 2), 16);
				const g = parseInt(h.slice(2, 4), 16);
				const b = parseInt(h.slice(4, 6), 16);
				return theme.mode === "truecolor"
					? `\x1b[38;2;${r};${g};${b}m`
					: theme.fgColors?.get(fallbackToken) ?? "";
			};
			// Register all custom colors from the COLORS table
			for (const entry of [
				COLORS.thinkingBright,
				COLORS.thinkingLow,
				COLORS.cmd,
				COLORS.bash,
			] as const) {
				if (!("hex" in entry)) continue;
				const ansi = toAnsi(entry.hex, entry.fallback);
				if (ansi) theme.fgColors.set(entry.token, ansi);
			}
			// Built-in user-bash execution blocks use the `bashMode` color for
			// their borders and `$ command` header. Align those with our muted
			// amber warning instead of the default green.
			const bashAnsi = theme.fgColors.get(COLORS.bash.token);
			if (bashAnsi) theme.fgColors.set("bashMode", bashAnsi);
		} catch { /* theme shape changed - silently ignore */ }
	}

	// We resolve the thinking-text color *dynamically* at render time, rather
	// than baking it in once. Pi may change the active thinking level at
	// various points (settings load, model switch, Shift+Tab, /model picker)
	// without firing the events we listen to in the right order, so the only
	// reliable approach is to re-evaluate every time `theme.fg("thinkingText",
	// ...)` is called and forward to the matching `thinking<Level>` color.
	const patchedThemes = new WeakSet<object>();
	function installThinkingTextProxy(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			const theme = ctx.ui.theme as unknown as {
				fg: (color: string, text: string) => string;
				fgColors?: Map<string, string>;
			};
			if (!theme || !theme.fgColors || patchedThemes.has(theme)) return;
			const origFg = theme.fg.bind(theme);
			theme.fg = function (color: string, text: string): string {
				if (color === "thinkingText") {
					const lvl = (typeof pi.getThinkingLevel === "function"
						? pi.getThinkingLevel()
						: undefined) ?? "off";
					const token = THINKING_LEVEL_TOKEN[lvl] ?? "thinkingOff";
					if (theme.fgColors?.get(token)) return origFg(token, text);
				}
				return origFg(color, text);
			};
			patchedThemes.add(theme);
			activeTui?.requestRender();
		} catch {
			/* theme shape changed - silently ignore */
		}
	}

	function syncThinkingTextColor(ctx: ExtensionContext, _level?: string): void {
		// Re-install the proxy in case the theme instance was swapped (setTheme),
		// then nudge a render so cached output picks up the latest level.
		installBrightestColor(ctx);
		installThinkingTextProxy(ctx);
		activeTui?.requestRender();
	}

	pi.on("thinking_level_select", async (event, ctx) => {
		const level = (event as { level?: string }).level;
		syncThinkingTextColor(ctx, level);
	});

	// Re-apply on model switch (the theme instance may be unchanged, but the
	// active thinking level can be clamped) and whenever a new session starts.
	pi.on("model_select", async (_event, ctx) => {
		syncThinkingTextColor(ctx);
	});

	// ---- restore mode on startup / resume ----
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries() as Array<{
			type: string;
			customType?: string;
			data?: { mode?: Mode };
		}>;
		const last = [...entries].reverse().find((e) => e.type === "custom" && e.customType === "pi-plan-mode");
		if (last?.data?.mode && MODES.includes(last.data.mode)) {
			mode = last.data.mode;
		}
		editorDraftIsBash = false;
		ensurePlansDir();
		renderStatus(ctx);
		installBrightestColor(ctx);
		installFooter(ctx);
		installEditor(ctx);
		installThinkingTextProxy(ctx);
		syncThinkingTextColor(ctx);
	});

	// ---- custom editor: paint border with mode color ----
	function installEditor(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;
		// Same color as the mode label but with ANSI dim (\x1b[2m) to desaturate.
		const dim = (painted: string): string => `\x1b[2m${painted}\x1b[22m`;
		const paintBorder = (text: string): string => {
			try {
				return theme.fg(MODE_COLOR[mode], text);
			} catch {
				return text;
			}
		};
		const paintBashBorder = (text: string): string => {
			try {
				return theme.fg(COLORS.bash.token, text);
			} catch {
				try {
					return theme.fg("warning", text);
				} catch {
					return text;
				}
			}
		};

		const isEditorBorderLine = (line: string): boolean => {
			const plain = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
			return /^─+$/.test(plain) || /^─── [↑↓] \d+ more ─*$/.test(plain);
		};

		// Decorate whatever editor is currently installed: paint the border with
		// the active mode's colour (or amber when the draft is a `!bash` line) and
		// keep the bash-draft status bar in sync. We monkey-patch instead of
		// subclassing so this composes with other extensions (e.g. paste's chip
		// navigation) regardless of load order.
		chainEditor(ctx.ui, (editor: any, tui: any) => {
			if (editor.__modeBorderPatched) return editor;
			activeTui = tui ?? activeTui;

			const syncBashDraftStatus = (): void => {
				const next = (editor.getText() as string).startsWith("!");
				if (next === editorDraftIsBash) return;
				editorDraftIsBash = next;
				renderStatus(ctx);
				activeTui?.requestRender();
			};

			// Lock borderColor: ignore external assignments (e.g. pi resetting it
			// on thinking-level / bash-mode changes).
			Object.defineProperty(editor, "borderColor", {
				configurable: true,
				enumerable: true,
				get: () => ((editor.getText() as string).startsWith("!") ? paintBashBorder : paintBorder),
				set: () => { /* ignore */ },
			});

			const origRender = editor.render.bind(editor);
			editor.render = function (width: number): string[] {
				const gutterWidth = 2;
				if (width <= gutterWidth + 1) return origRender(width);
				const border = editor.borderColor;
				let contentLineSeen = false;
				return (origRender(width - gutterWidth) as string[]).map((line) => {
					if (isEditorBorderLine(line)) {
						const pad = Math.max(0, width - visibleWidth(line));
						return line + border("─".repeat(pad));
					}
					const prefix = contentLineSeen ? "  " : `${border("❯")} `;
					contentLineSeen = true;
					return prefix + line;
				});
			};

			const origHandle = editor.handleInput.bind(editor);
			editor.handleInput = function (data: string): void {
				origHandle(data);
				syncBashDraftStatus();
			};

			const origSetText = editor.setText.bind(editor);
			editor.setText = function (text: string): void {
				origSetText(text);
				syncBashDraftStatus();
			};

			editor.__modeBorderPatched = true;
			return editor;
		});
	}

	function shortenUserPath(p: string): string {
		const home = os.homedir();
		const pathText = p.replace(/\//g, "\\");
		const homeText = home.replace(/\//g, "\\");
		const pathLower = pathText.toLowerCase();
		const homeLower = homeText.toLowerCase();
		if (pathLower === homeLower) return "~";
		if (pathLower.startsWith(homeLower + "\\")) return "~" + pathText.slice(homeText.length);
		return p;
	}

	// ---- 2-line footer: stats on top, model on bottom ----
	// Match the default pi footer's formatTokens (uppercase M, sensible thresholds).
	function fmt(count: number): string {
		if (count < 1000) return count.toString();
		if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
		if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
		if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
		return `${Math.round(count / 1_000_000)}M`;
	}

	function providerLabel(provider: string): string {
		if (provider === "github-copilot") return "copilot";
		if (provider === "pi-cursor-provider") return "cursor";
		return provider
			.replace(/^github-/, "")
			.replace(/^pi-/, "")
			.replace(/-provider$/, "");
	}

	function shouldShowProvider(ctx: ExtensionContext): boolean {
		try {
			const getAvailable = ctx.modelRegistry?.getAvailable;
			if (typeof getAvailable !== "function") return false;
			const models = getAvailable.call(ctx.modelRegistry) as Array<{ provider?: string }>;
			const providers = new Set(models.map((m) => m.provider).filter((p): p is string => typeof p === "string" && p.length > 0));
			return providers.size > 1;
		} catch {
			return false;
		}
	}

	function installFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// --- gather stats ---
					let input = 0,
						output = 0,
						cacheRead = 0,
						cacheWrite = 0,
						cost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							input += m.usage.input ?? 0;
							output += m.usage.output ?? 0;
							cacheRead += m.usage.cacheRead ?? 0;
							cacheWrite += m.usage.cacheWrite ?? 0;
							cost += m.usage.cost?.total ?? 0;
						}
					}

					const usage = ctx.getContextUsage?.();
					let ctxStr = "";
					if (usage && usage.contextWindow > 0) {
						const pctVal = usage.percent ?? null;
						const pct = pctVal !== null ? `${pctVal.toFixed(1)}%` : "?";
						// Match default footer's `(auto)` indicator. The flag isn't exposed
						// to extensions, so default to true (pi's default) and let users
						// who disabled it ignore it.
						const autoIndicator = " (auto)";
						const display =
							pctVal === null
								? `?/${fmt(usage.contextWindow)}${autoIndicator}`
								: `${pct}/${fmt(usage.contextWindow)}${autoIndicator}`;
						let painted: string;
						if (pctVal !== null && pctVal > 90) {
							painted = theme.fg("error", display);
						} else if (pctVal !== null && pctVal > 70) {
							painted = theme.fg("warning", display);
						} else {
							painted = theme.fg("dim", display);
						}
						ctxStr = ` ${painted}`;
					}

					// `(sub)` indicator when the active model uses an OAuth subscription.
					let subIndicator = "";
					try {
						if (ctx.model && ctx.modelRegistry?.isUsingOAuth?.(ctx.model)) {
							subIndicator = " (sub)";
						}
					} catch {
						/* ignore */
					}

					const statsLeft = theme.fg(
						"dim",
						`↑${fmt(input)} ↓${fmt(output)} R${fmt(cacheRead)} W${fmt(cacheWrite)} $${cost.toFixed(3)}${subIndicator}`,
					);
					const statsRight = statsLeft + ctxStr;

					// --- gather model line ---
					const modelId = ctx.model?.id ?? "no-model";
					const modelProviderSuffix = ctx.model && shouldShowProvider(ctx) ? ` (${providerLabel(ctx.model.provider)})` : "";
					const modelLabel = `${modelId}${modelProviderSuffix}`;
					const thinking = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined;
					// Match default footer wording for thinking level.
					const thinkingLevel = thinking || "off";
					// Paint just the level word with its matching thinking<Level> color
					// (same hue as the input border in default pi). Everything else stays
					// dim so the colored word stands out.
					const levelToken = THINKING_LEVEL_TOKEN[thinkingLevel] ?? "thinkingOff";
					let levelPainted: string;
					try {
						levelPainted = theme.fg(levelToken, thinkingLevel);
					} catch {
						levelPainted = theme.fg("dim", thinkingLevel);
					}
					const modelRight =
						thinkingLevel === "off"
							? theme.fg("dim", `${modelLabel} • thinking off`)
							: theme.fg("dim", `${modelLabel} • `) + levelPainted;

					// --- left side: extension statuses (mode badge etc.) and git branch ---
					const branch = footerData.getGitBranch();

					const line = (left: string, right: string) => {
						const lw = visibleWidth(left);
						const rw = visibleWidth(right);
						const pad = Math.max(1, width - lw - rw);
						return truncateToWidth(left + " ".repeat(pad) + right, width, theme.fg("dim", "\u2026"));
					};

					// --- mode on top line, cwd + branch on bottom line ---
					const modeLabel = MODE_LABEL[mode];
					let modePainted = modeLabel;
					try {
						modePainted = theme.fg(MODE_COLOR[mode], modeLabel);
					} catch { /* */ }
					// Show home-relative paths as ~\...; keep all other footer behavior unchanged.
					let cwdDisplay = shortenUserPath(ctx.cwd);
					if (cwdDisplay.length > 30) {
						const slashIdx = cwdDisplay.indexOf("\\", cwdDisplay.length - 30);
						if (slashIdx !== -1 && slashIdx < cwdDisplay.length - 1) {
							cwdDisplay = cwdDisplay.slice(slashIdx + 1);
						}
					}
					const cwdPart = theme.fg("dim", cwdDisplay);
					const branchPart = branch ? theme.fg("dim", " on ") + theme.fg("dim", branch) : "";
					const cwdWithBranch = cwdPart + branchPart;
					// statuses already includes the mode badge from renderStatus(),
					// so use statuses alone to avoid duplicating the mode label.
					const statusEntries = Array.from(footerData.getExtensionStatuses().entries())
						.filter(([, text]) => Boolean(text))
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text);
					const statusLeft = statusEntries.length > 0 ? statusEntries.join(theme.fg("dim", " • ")) : modePainted;

					return [
						line(statusLeft, modelRight),
						line(cwdWithBranch, statsRight),
					];
				},
			};
		});
	}
}
