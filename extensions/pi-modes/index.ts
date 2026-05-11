/**
 * pi-plan extension
 *
 * Adds three operating modes to pi:
 *   - Command (default): pi works normally - user asks, ai executes.
 *   - Plan: ai writes a markdown plan into `~/.pi/agent/plans/` (the plan folder).
 *           No bash / write / edit outside of `~/.pi/agent/plans/` is allowed.
 *           pi can later read & execute that plan in Command mode.
 *   - Ask:  ai just answers. No bash. No edits. No writes. Pure chat.
 *
 * Cycle modes with: Shift+Tab
 * The current mode is shown in the status bar, just before the model entry,
 * on the right-hand side.
 *
 * Commands:
 *   /mode            -> show current mode
 *   /mode command    -> switch to Command mode
 *   /mode plan       -> switch to Plan mode
 *   /mode ask        -> switch to Ask mode
 *   /plans           -> list existing plans in ~/.pi/agent/plans/
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Mode = "command" | "plan" | "ask";

const MODES: Mode[] = ["command", "plan", "ask"];

const MODE_LABEL: Record<Mode, string> = {
	command: "command",
	plan: "plan",
	ask: "ask",
};

const MODE_LABEL_TITLE: Record<Mode, string> = {
	command: "Command",
	plan: "Plan",
	ask: "Ask",
};

// Theme color token per mode.
//   Ask     -> green  (success)
//   Command -> gray   (muted)
//   Plan    -> cyan   (accent, which is typically cyan/blue in pi themes)
const MODE_COLOR: Record<Mode, string> = {
	command: "muted",
	plan: "accent",
	ask: "success",
};

// Tools considered "mutating" - blocked in Ask mode, restricted in Plan mode.
const MUTATING_TOOLS = new Set(["bash", "write", "edit", "multi_edit"]);

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

export default function piPlanExtension(pi: ExtensionAPI): void {
	let mode: Mode = "command";
	let activeTui: TUI | undefined;
	let lastWrittenPlanFile: string | null = null;
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
				? ctx.ui.theme.fg(PI_PLAN_BASH_TOKEN, label)
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
		description: "Cycle pi-plan mode (Command / Plan / Ask)",
		handler: async (ctx) => cycleMode(ctx),
	});

	// ---- /mode command ----
	pi.registerCommand("mode", {
		description: "Show or switch pi-plan mode (command | plan | ask)",
		getArgumentCompletions: (prefix: string) => {
			const items = MODES.map((m) => ({ value: m, label: m }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();
			if (!arg) {
				ctx.ui.notify(`Current mode: ${MODE_LABEL[mode]}`, "info");
				return;
			}
			if (!MODES.includes(arg as Mode)) {
				ctx.ui.notify(`Unknown mode '${arg}'. Use: ${MODES.join(", ")}`, "error");
				return;
			}
			setMode(arg as Mode, ctx);
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
			// Pure Q&A: block any tool that can change the world.
			if (MUTATING_TOOLS.has(toolName)) {
				return {
					block: true,
					reason: `Ask mode is active - the assistant must answer without running '${toolName}'. Switch modes with Shift+Tab (or /mode command) to allow it.`,
				};
			}
			return;
		}

		// mode === "plan"
		// In Plan mode the assistant may read/search the codebase freely,
		// but is only allowed to *write* into ~/.pi/agent/plans/. No bash, no edits.
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
					reason: "Plan mode: edits are only allowed inside ~/.pi/agent/plans/. Save your plan there.",
				};
			}
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

	// ---- post-plan review prompt ----
	pi.on("agent_end", async (_event, ctx) => {
		if (mode !== "plan" || !lastWrittenPlanFile) return;

		const planFile = lastWrittenPlanFile;
		lastWrittenPlanFile = null;

		const choice = await ctx.ui.select("Plan saved! What would you like to do?", [
			"Accept and build",
			"Exit plan mode",
			"Suggest changes",
		]);

		if (choice === "Accept and build") {
			setMode("command", ctx, false);
			pi.sendUserMessage(`Execute the plan at ${planFile}. Read it first, then follow its Steps section.`);
		} else if (choice === "Exit plan mode") {
			setMode("command", ctx, false);
		} else if (choice === "Suggest changes") {
			const suggestions = await ctx.ui.input("Enter your suggestions:");
			if (suggestions) {
				pi.sendUserMessage(suggestions);
			}
		}
		// If undefined (Escape), do nothing — stay in plan mode
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
				"Do NOT call bash, write, edit, or any other tool that modifies the system.",
				"Read-only tools (read, grep, find, ls) are fine if truly needed to answer accurately,",
				"but prefer answering from your own knowledge first.",
			].join("\n");
		} else if (mode === "plan") {
			directive = [
				"[PI-PLAN MODE: PLAN]",
				"You are in Plan mode. Your job is to PRODUCE A PLAN, not to execute it.",
				"",
				"Rules:",
				"  - Do NOT run bash.",
				"  - Do NOT edit or write any file outside of `~/.pi/agent/plans/`.",
				"  - You MAY use read / grep / find / ls to investigate the codebase.",
				"  - When the plan is ready, save it as Markdown using the `write` tool to:",
				"      ~/.pi/agent/plans/<short-kebab-case-name>.md",
				"  - The plan file should contain:",
				"      # Title",
				"      ## Goal        (1-3 sentences)",
				"      ## Context     (key files / constraints)",
				"      ## Steps       (numbered, actionable, ordered)",
				"      ## Verification (how to confirm success)",
				"  - After saving, briefly tell the user the plan path and a short summary.",
				"  - The user will be prompted to accept and build, exit plan mode, or suggest changes.",
				"",
				"Existing plans in this project:",
				planList,
			].join("\n");
		} else {
			// command mode
			directive = [
				"[PI-PLAN MODE: COMMAND]",
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
	// uses an even brighter custom color (registered as `piPlanThinkingBrightest`
	// at install time). This makes the lower levels easier to distinguish.
	const PI_PLAN_BRIGHTEST_TOKEN = "piPlanThinkingBrightest";
	const PI_PLAN_BRIGHTEST_HEX = "#ff79e1"; // bright pink/magenta
	const PI_PLAN_LOW_TOKEN = "piPlanThinkingLow";
	const PI_PLAN_LOW_HEX = "#4fb090"; // muted teal - distinct from minimal but dimmer than medium
	const PI_PLAN_BASH_TOKEN = "piPlanBashCommand";
	const PI_PLAN_BASH_HEX = "#c6a15b"; // muted amber - visible warning without overpowering mode colors
	const THINKING_LEVEL_TOKEN: Record<string, string> = {
		off: "thinkingOff",
		minimal: "thinkingLow",
		low: PI_PLAN_LOW_TOKEN,
		medium: "thinkingHigh",
		high: "thinkingXhigh",
		xhigh: PI_PLAN_BRIGHTEST_TOKEN,
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
			const brightest = toAnsi(PI_PLAN_BRIGHTEST_HEX, "thinkingXhigh");
			if (brightest) theme.fgColors.set(PI_PLAN_BRIGHTEST_TOKEN, brightest);
			const low = toAnsi(PI_PLAN_LOW_HEX, "thinkingMedium");
			if (low) theme.fgColors.set(PI_PLAN_LOW_TOKEN, low);
			const bash = toAnsi(PI_PLAN_BASH_HEX, "warning");
			if (bash) {
				theme.fgColors.set(PI_PLAN_BASH_TOKEN, bash);
				// Built-in user-bash execution blocks use the `bashMode` color for
				// their borders and `$ command` header. Align those with our muted
				// amber warning instead of the default green.
				theme.fgColors.set("bashMode", bash);
			}
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
		const paintBorder = (text: string): string => {
			try {
				return theme.fg(MODE_COLOR[mode], text);
			} catch {
				return text;
			}
		};
		const paintBashBorder = (text: string): string => {
			try {
				return theme.fg(PI_PLAN_BASH_TOKEN, text);
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

		class ModeBorderEditor extends CustomEditor {
			private syncBashDraftStatus(): void {
				const next = this.getText().startsWith("!");
				if (next === editorDraftIsBash) return;
				editorDraftIsBash = next;
				renderStatus(ctx);
				activeTui?.requestRender();
			}

			constructor(tui: TUI, edTheme: EditorTheme, kb: KeybindingsManager) {
				super(tui, edTheme, kb);
				activeTui = tui;
				// Lock borderColor: ignore external assignments (e.g. pi resetting
				// it on thinking-level / bash-mode changes). Normally render with
				// the current pi-plan mode color, but use yellow warning borders
				// while the draft starts with `!` because that will run local bash.
				Object.defineProperty(this, "borderColor", {
					configurable: true,
					enumerable: true,
					get: () => this.getText().startsWith("!") ? paintBashBorder : paintBorder,
					set: () => { /* ignore */ },
				});
			}

			render(width: number): string[] {
				const gutterWidth = 2;
				if (width <= gutterWidth + 1) return super.render(width);

				const border = this.borderColor;
				let contentLineSeen = false;
				return super.render(width - gutterWidth).map((line) => {
					if (isEditorBorderLine(line)) {
						const pad = Math.max(0, width - visibleWidth(line));
						return line + border("─".repeat(pad));
					}

					const prefix = contentLineSeen ? "  " : `${border("❯")} `;
					contentLineSeen = true;
					return prefix + line;
				});
			}

			handleInput(data: string): void {
				super.handleInput(data);
				this.syncBashDraftStatus();
			}

			setText(text: string): void {
				super.setText(text);
				this.syncBashDraftStatus();
			}
		}

		ctx.ui.setEditorComponent((tui, edTheme, kb) => new ModeBorderEditor(tui, edTheme, kb));
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
							? theme.fg("dim", `${modelId} • thinking off`)
							: theme.fg("dim", `${modelId} • `) + levelPainted;

					// --- left side: extension statuses (mode badge etc.) and git branch ---
					const statuses = Array.from(footerData.getExtensionStatuses().values()).filter(Boolean);
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
					const statusLeft = statuses.length > 0 ? statuses.join("  ") : modePainted;

					return [
						line(statusLeft, modelRight),
						line(cwdWithBranch, statsRight),
					];
				},
			};
		});
	}
}
