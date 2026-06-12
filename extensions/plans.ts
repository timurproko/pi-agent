/**
 * pi plans extension
 *
 * Owns everything related to the plan workflow: the Plan mode registration,
 * /plans manager, plan dialogs/actions, plan-mode write restrictions,
 * plan-specific system prompt guidance, and the post-plan review prompt.
 *
 * Disable this file to remove the entire plan workflow while leaving the
 * generic Cmd/Ask mode extension active.
 */

import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, Key, Markdown, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { EditorConfirmModal, EditorDialogTemplate, EditorModal, type EditorModalItem } from "./core/editor-ui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type ModeDefinition = {
	id: string;
	label: string;
	title: string;
	colorToken: string;
};

type ModeWorkflow = {
	getMode: () => string;
	setMode: (mode: string, ctx: ExtensionContext, announce?: boolean) => void;
	registerMode: (definition: ModeDefinition) => void;
	unregisterMode?: (id: string) => void;
	modeIds?: () => string[];
};

function modeWorkflow(): ModeWorkflow | undefined {
	return (globalThis as any).__piModeWorkflow as ModeWorkflow | undefined;
}

function registerPlanMode(): void {
	modeWorkflow()?.registerMode({ id: "plan", label: "plan", title: "Plan", colorToken: "accent" });
}

function currentMode(): string {
	return modeWorkflow()?.getMode() ?? "command";
}

function setWorkflowMode(mode: "plan" | "command", ctx: ExtensionContext, announce = true): boolean {
	const workflow = modeWorkflow();
	if (!workflow) {
		ctx.ui.notify("Plan workflow needs extensions/modes.ts to be loaded first", "error");
		return false;
	}
	workflow.setMode(mode, ctx, announce);
	return true;
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

function planPath(planName: string): string {
	return path.join(plansDir(), planName);
}

interface PlanListItem {
	name: string;
	path: string;
	title: string;
}

function readPlanTitle(filePath: string, fallbackName: string): string {
	try {
		const content = fs.readFileSync(filePath, "utf8");
		const heading = content.match(/^#\s+(.+)\s*$/m)?.[1]?.trim();
		if (heading) return heading;
	} catch {
		// If the file cannot be read, fall back to the filename so the list still works.
	}
	return fallbackName;
}

function listPlanItems(): PlanListItem[] {
	return listPlans().map((name) => {
		const fullPath = planPath(name);
		return { name, path: fullPath, title: readPlanTitle(fullPath, name) };
	});
}

function filterPlanItems(plans: PlanListItem[], query: string): PlanListItem[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return plans;
	return plans.filter((plan) =>
		`${plan.name} ${plan.title} ${plan.path}`.toLowerCase().includes(normalizedQuery),
	);
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

type PlanAction = "view" | "refine" | "update" | "work";

type PlanMenuAction = PlanAction | "delete";

const PLAN_ACTION_ITEMS: Array<EditorModalItem<Exclude<PlanAction, "view">>> = [
	{ value: "refine", label: "Refine", description: "Refine plan" },
	{ value: "update", label: "Update", description: "Suggest specific changes" },
	{ value: "work", label: "Work", description: "Start implementation" },
];

const PLAN_POST_SAVE_ACTION_ITEMS: Array<EditorModalItem<PlanAction>> = [
	{ value: "view", label: "View", description: "Open plan view" },
	...PLAN_ACTION_ITEMS,
];

const PLAN_MENU_ITEMS: Array<EditorModalItem<PlanMenuAction>> = [
	...PLAN_ACTION_ITEMS,
	{ value: "delete", label: "Delete", description: "Delete plan" },
];

interface PlanSelectorResult {
	plan: PlanListItem;
	query: string;
	quickAction?: "view";
}

class PlanSelectorDialog implements Component, Focusable {
	private readonly input = new Input();
	private filteredPlans: PlanListItem[];
	private selectedIndex = 0;
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
		private readonly plans: PlanListItem[],
		private readonly onDone: (result: PlanSelectorResult | undefined) => void,
		initialQuery = "",
	) {
		this.filteredPlans = plans;
		if (initialQuery) this.input.setValue(initialQuery);
		this.input.onSubmit = () => this.selectCurrent();
		this.applyFilter(this.input.getValue());
	}

	private applyFilter(query: string): void {
		this.filteredPlans = filterPlanItems(this.plans, query);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredPlans.length - 1));
	}

	private selectCurrent(quickAction?: PlanSelectorResult["quickAction"]): void {
		const plan = this.filteredPlans[this.selectedIndex];
		if (plan) this.onDone({ plan, query: this.input.getValue(), quickAction });
	}

	handleInput(keyData: string): void {
		if (this.keybindings.matches(keyData, "tui.select.cancel")) {
			this.onDone(undefined);
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.up") || matchesKey(keyData, Key.up)) {
			if (this.filteredPlans.length > 0) {
				this.selectedIndex = this.selectedIndex === 0 ? this.filteredPlans.length - 1 : this.selectedIndex - 1;
				this.tui.requestRender();
			}
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.down") || matchesKey(keyData, Key.down)) {
			if (this.filteredPlans.length > 0) {
				this.selectedIndex = this.selectedIndex === this.filteredPlans.length - 1 ? 0 : this.selectedIndex + 1;
				this.tui.requestRender();
			}
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.confirm") || matchesKey(keyData, Key.enter)) {
			this.selectCurrent();
			return;
		}
		if (keyData === " ") {
			this.selectCurrent("view");
			return;
		}

		this.input.handleInput(keyData);
		this.applyFilter(this.input.getValue());
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const border = this.theme.fg("border", "─".repeat(Math.max(1, width)));
		const push = (line = "") => lines.push(truncateToWidth(line, width));
		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredPlans.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredPlans.length);

		push(border);
		push();
		push(this.theme.fg("accent", this.theme.bold("Plans")));
		push();
		for (const line of this.input.render(width)) push(line);
		push();

		if (this.filteredPlans.length === 0) {
			const emptyMessage = this.input.getValue().trim() ? "No matching plans" : "No plans yet";
			push(this.theme.fg("muted", `  ${emptyMessage}`));
		} else {
			const visiblePlans = this.filteredPlans.slice(startIndex, endIndex);
			const maxTitleWidth = Math.max(...visiblePlans.map((plan) => visibleWidth(plan.title || plan.name)));
			// Keep the file name in a stable description-style column, matching the
			// /skills layout, while preserving one cell of margin to avoid wrapping.
			const rowWidth = Math.max(1, width - 1);
			const prefixWidth = 2;
			const gapWidth = 2;
			const minFileNameWidth = Math.min(24, Math.max(0, rowWidth - prefixWidth - gapWidth - 1));
			const titleColumnWidth = Math.min(
				maxTitleWidth,
				Math.max(1, rowWidth - prefixWidth - gapWidth - minFileNameWidth),
			);
			const fileNameWidth = Math.max(0, rowWidth - prefixWidth - titleColumnWidth - gapWidth);

			for (let i = startIndex; i < endIndex; i += 1) {
				const plan = this.filteredPlans[i];
				if (!plan) continue;
				const selected = i === this.selectedIndex;
				const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
				const rawTitle = truncateToWidth(plan.title || plan.name, titleColumnWidth);
				const titlePadding = " ".repeat(Math.max(0, titleColumnWidth - visibleWidth(rawTitle)));
				const title = this.theme.fg(selected ? "accent" : "text", rawTitle + titlePadding);
				const fileName = this.theme.fg("dim", truncateToWidth(plan.name, fileNameWidth));
				push(prefix + title + "  " + fileName);
			}
			if (startIndex > 0 || endIndex < this.filteredPlans.length) {
				push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filteredPlans.length})`));
			}
		}

		push();
		push(this.theme.fg("dim", "type to search • ↑↓ navigate • space view • enter actions • esc close"));
		push(border);
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
	}
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
		const dialog = new EditorDialogTemplate({ theme: this.theme, size: "fullscreen" });
		const contentWidth = dialog.contentWidth(width);
		const pathLabel = this.theme.fg("muted", this.planFile);
		const footer = [
			this.theme.fg("dim", "↑↓ scroll"),
			this.theme.fg("dim", "pgup/pgdn page"),
			this.theme.fg("dim", "esc back"),
		].join(this.theme.fg("muted", " • "));
		const contentHeight = Math.max(1, dialog.maxHeight(this.tui) - dialog.nonBodyLineCount({ metaLines: [pathLabel], footerLines: [footer] }));

		let markdownWidth = Math.max(1, contentWidth);
		let markdownLines = this.compactRenderedHeadingSpacing(this.markdown.render(markdownWidth));
		let hasScrollableContent = markdownLines.length > contentHeight;
		if (hasScrollableContent) {
			markdownWidth = dialog.contentWidth(width, { rightDecorationWidth: 1 });
			markdownLines = this.compactRenderedHeadingSpacing(this.markdown.render(markdownWidth));
			hasScrollableContent = markdownLines.length > contentHeight;
		}

		this.totalLines = markdownLines.length;
		this.viewHeight = contentHeight;
		const maxScroll = Math.max(0, this.totalLines - contentHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visibleLines = markdownLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		const bodyLines: string[] = [];
		const bodyRightDecorations: Array<string | undefined> = [];
		for (let i = 0; i < contentHeight; i++) {
			const line = visibleLines[i] ?? "";
			if (!hasScrollableContent) {
				bodyLines.push(line);
				bodyRightDecorations.push(undefined);
				continue;
			}
			bodyLines.push(truncateToWidth(line, markdownWidth));
			bodyRightDecorations.push(this.getScrollIndicatorForRow(i, contentHeight));
		}

		return dialog.render(width, {
			title: this.planTitle,
			metaLines: [pathLabel],
			bodyLines,
			bodyRightDecorations,
			footerLines: [footer],
		});
	}

	invalidate(): void {
		this.markdown = new Markdown(this.reviewContent, 0, 0, getMarkdownTheme());
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

async function openPlanView(plan: Pick<PlanListItem, "path">, ctx: ExtensionContext): Promise<void> {
	try {
		const content = fs.readFileSync(plan.path, "utf8");
		await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
			return new PlanReviewDialog(tui, theme, keybindings, plan.path, content, () => done());
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Could not open plan: ${message}`, "error");
	}
}

export default function piPlansExtension(pi: ExtensionAPI): void {
	let lastWrittenPlanFile: string | null = null;
	let postPlanPromptScheduled = false;

	registerPlanMode();

	// ---- /plans command ----
	const openPlansCommand = async (_args: string | undefined, ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			const plans = listPlans();
			ctx.ui.notify(plans.length > 0 ? `Plans (${plans.length}):\n${plans.map((p) => `  • ${p}`).join("\n")}` : "No plans yet.", "info");
			return;
		}

		let searchQuery = (_args || "").trim();
		while (true) {
			const plans = listPlanItems();

			const selected = await ctx.ui.custom<PlanSelectorResult | undefined>((tui, theme, keybindings, done) => {
				return new PlanSelectorDialog(tui, theme, keybindings, plans, done, searchQuery);
			});
			if (!selected) return;
			searchQuery = selected.query;
			if (selected.quickAction === "view") {
				await openPlanView(selected.plan, ctx);
				continue;
			}

			const action = await ctx.ui.custom<PlanMenuAction | undefined>((tui, theme, keybindings, done) => {
				return new EditorModal<PlanMenuAction>({
					tui,
					theme,
					keybindings,
					title: `Actions for "${selected.plan.title || selected.plan.name}"`,
					items: PLAN_MENU_ITEMS,
					shortcuts: "↑↓ navigate • enter select • esc back",
					onSelect: (item) => done(item.value),
					onCancel: () => done(undefined),
				});
			});
			if (!action) continue;

			if (action === "refine") {
				if (!setWorkflowMode("plan", ctx, false)) return;
				const refineFlow = (globalThis as any).__piAnswerRefineFlow;
				if (typeof refineFlow?.start === "function") {
					await refineFlow.start(ctx, {
						key: `plan:${path.resolve(selected.plan.path)}`,
						prompt: buildRefinePlanPrompt(selected.plan.path),
						cancelMessage: false,
						cancelControlLabel: "back to plans",
						statusLabel: "plan",
						onCancelled: async (cancelCtx: ExtensionContext) => {
							if (currentMode() === "plan") await openPlansCommand(undefined, cancelCtx);
						},
					});
				} else {
					ctx.ui.notify("Could not auto-open answer UI: /answer refine flow is not loaded", "error");
					await pi.sendUserMessage(buildRefinePlanPrompt(selected.plan.path));
				}
				return;
			}

			if (action === "update") {
				if (!setWorkflowMode("plan", ctx, false)) return;
				const suggestion = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
					return new SpecificSuggestionDialog(tui, theme, keybindings, done);
				});
				if (!suggestion?.trim()) continue;
				await pi.sendUserMessage(buildSuggestSpecificChangesPrompt(selected.plan.path, suggestion.trim()));
				return;
			}

			if (action === "work") {
				if (!setWorkflowMode("command", ctx, false)) return;
				await pi.sendUserMessage(`Execute the plan at ${selected.plan.path}. Read it first, then follow its Steps section.`);
				return;
			}

			if (action === "delete") {
				const confirmed = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => new EditorConfirmModal({
					tui,
					theme,
					keybindings,
					title: "Delete plan",
					subtitle: `Delete ${selected.plan.name}? This cannot be undone.`,
					onConfirm: () => done(true),
					onCancel: () => done(false),
				}));
				if (!confirmed) continue;
				try {
					fs.unlinkSync(selected.plan.path);
					ctx.ui.notify(`Deleted plan ${selected.plan.name}`, "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Could not delete plan: ${message}`, "error");
				}
			}
		}
	};

	pi.registerCommand("plans", {
		description: "Open the plan manager",
		handler: openPlansCommand,
	});

	// ---- plan mode tool gate ----
	pi.on("tool_call", async (event, _ctx) => {
		if (currentMode() !== "plan") return;

		const toolName = event.toolName;
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
			ensurePlansDir();
			lastWrittenPlanFile = target;
			return;
		}
	});

	// ---- reset plan file tracking on each agent run ----
	pi.on("agent_start", async (_event, _ctx) => {
		lastWrittenPlanFile = null;
	});

	async function showPostPlanPrompt(planFile: string, ctx: ExtensionContext): Promise<void> {
		while (currentMode() === "plan") {
			const choice = await ctx.ui.custom<PlanAction | undefined>((tui, theme, keybindings, done) => {
				return new EditorModal<PlanAction>({
					tui,
					theme,
					keybindings,
					title: "Plan saved! What would you like to do?",
					items: PLAN_POST_SAVE_ACTION_ITEMS,
					shortcuts: "↑↓ navigate • enter select • esc cancel",
					onSelect: (item) => done(item.value),
					onCancel: () => done(undefined),
				});
			});

			if (choice === "view") {
				await openPlanView({ path: planFile }, ctx);
				continue;
			}

			if (choice === "refine") {
				const refineFlow = (globalThis as any).__piAnswerRefineFlow;
				if (typeof refineFlow?.start !== "function") {
					ctx.ui.notify("Could not auto-open answer UI: /answer refine flow is not loaded", "error");
					return;
				}
				await refineFlow.start(ctx, {
					key: `plan:${path.resolve(planFile)}`,
					prompt: buildRefinePlanPrompt(planFile),
					cancelMessage: false,
					cancelControlLabel: "back to plan",
					statusLabel: "plan",
					onCancelled: async (cancelCtx: ExtensionContext) => {
						if (currentMode() === "plan") {
							await showPostPlanPrompt(planFile, cancelCtx);
						}
					},
				});
				return;
			}

			if (choice === "update") {
				const suggestion = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
					return new SpecificSuggestionDialog(tui, theme, keybindings, done);
				});
				if (!suggestion?.trim()) continue;
				await pi.sendUserMessage(buildSuggestSpecificChangesPrompt(planFile, suggestion.trim()));
				return;
			}

			if (choice === "work") {
				if (!setWorkflowMode("command", ctx, false)) return;
				await pi.sendUserMessage(`Execute the plan at ${planFile}. Read it first, then follow its Steps section.`);
				return;
			}

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
					if (currentMode() === "plan") await showPostPlanPrompt(planFile, ctx);
				} finally {
					postPlanPromptScheduled = false;
				}
			})();
		};

		setTimeout(waitForFinished, 0);
	}

	// ---- post-plan review prompt ----
	pi.on("agent_end", async (_event, ctx) => {
		if (currentMode() !== "plan") return;
		if (!lastWrittenPlanFile) return;

		const planFile = lastWrittenPlanFile;
		lastWrittenPlanFile = null;
		schedulePostPlanPrompt(planFile, ctx);
	});

	// ---- plan-specific system prompt guidance ----
	pi.on("before_agent_start", async (event, _ctx) => {
		ensurePlansDir();
		const plans = listPlans();
		const planList = plans.length > 0 ? plans.map((p) => `  - ~/.pi/agent/plans/${p}`).join("\n") : "  (none yet)";

		let directive: string | undefined;
		if (currentMode() === "plan") {
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
				"  - When refining an existing plan, read the plan first and update that same plan file under `~/.pi/agent/plans/` using `edit` or `write`.",
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
		} else if (currentMode() === "command") {
			directive = [
				"If the user refers to 'the plan' or 'my plan', look under `~/.pi/agent/plans/`:",
				planList,
				"Read the relevant plan file and follow its Steps section.",
			].join("\n");
		}

		if (!directive) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${directive}` };
	});

	// Register again at session start in case /reload ordering changes or modes.ts reset the registry.
	pi.on("session_start", async (_event, _ctx) => {
		ensurePlansDir();
		registerPlanMode();
	});
}
