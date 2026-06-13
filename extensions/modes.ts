/**
 * pi modes extension
 *
 * Adds input modes to pi:
 *   - Cmd (default): pi works normally - user asks, ai executes.
 *   - Ask:  ai just answers. No bash. No edits. No writes. Pure chat.
 *
 * Other extensions can register additional modes through `globalThis.__piModeWorkflow`.
 *
 * Cycle modes with: Shift+Tab
 * The current mode is shown in the status bar, just before the model entry,
 * on the right-hand side.
 *
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chainEditor } from "./core/editor-chain";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as os from "node:os";
import * as path from "node:path";
import { getModePrompt } from "./core/mode-prompts";

type Mode = string;

interface ModeDefinition {
	id: string;
	label: string;
	title: string;
	colorToken: string;
	promptTemplateId?: string;
}

// ─── All custom colors in one place ──────────────────────────────────
// Each entry has a theme token (used with theme.fg()) and an optional hex
// value for custom colors that we register at runtime.
const COLORS = {
	// Mode label & input border per mode
	cmd:             { token: "piPlanCmdMode",            hex: "#979BA1", fallback: "dim"          }, // light gray
	ask:             { token: "success"                                                             }, // green (built-in)

	// Bash-prefix mode (when input starts with `!`)
	bash:            { token: "piPlanBashCommand",         hex: "#E5C07B", fallback: "warning"      }, // muted amber

	// Thinking-level custom colors (registered at runtime)
	thinkingLow:     { token: "piPlanThinkingLow",         hex: "#56B6C2", fallback: "thinkingMedium" }, // muted teal
	thinkingBright:  { token: "piPlanThinkingBrightest",   hex: "#ff79e1", fallback: "thinkingXhigh"  }, // bright pink/magenta
} as const;

const modeDefinitions = new Map<string, ModeDefinition>([
	["command", { id: "command", label: "cmd", title: "Cmd", colorToken: COLORS.cmd.token, promptTemplateId: "CMD" }],
	["ask", { id: "ask", label: "ask", title: "Ask", colorToken: COLORS.ask.token, promptTemplateId: "ASK" }],
]);

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

export default function piModesExtension(pi: ExtensionAPI): void {
	let mode: Mode = "command";
	let activeTui: TUI | undefined;
	let editorDraftIsBash = false;

	// ---- status bar ----
	// Use a key that sorts BEFORE "model" alphabetically so the mode badge
	// appears to the left of the model entry on the right side of the bar.
	const STATUS_KEY = "aaa-pi-plan-mode";

	function getModeDefinition(id = mode): ModeDefinition {
		return modeDefinitions.get(id) ?? modeDefinitions.get("command")!;
	}

	function modeIds(): string[] {
		return Array.from(modeDefinitions.keys());
	}

	function renderStatus(ctx: ExtensionContext): void {
		const def = getModeDefinition();
		const label = editorDraftIsBash ? "bash" : def.label;
		let painted = label;
		try {
			painted = editorDraftIsBash
				? ctx.ui.theme.fg(COLORS.bash.token, label)
				: ctx.ui.theme.fg(def.colorToken, label);
		} catch {
			/* theme not ready - fall back to plain */
		}
		ctx.ui.setStatus(STATUS_KEY, painted);
	}

	function persist(): void {
		pi.appendEntry("pi-plan-mode", { mode });
	}

	function setMode(next: Mode, ctx: ExtensionContext, _announce = true): void {
		if (!modeDefinitions.has(next)) next = "command";
		if (next === mode) return;
		mode = next;
		renderStatus(ctx);
		persist();
		activeTui?.requestRender();
		ctx.ui.notify(`Switched to ${getModeDefinition().title} mode`);
	}

	function cycleMode(ctx: ExtensionContext): void {
		const ids = modeIds();
		const idx = ids.indexOf(mode);
		const next = ids[(idx + 1) % ids.length] ?? "command";
		setMode(next, ctx);
	}

	(globalThis as any).__piModeWorkflow = {
		getMode: () => mode,
		setMode,
		registerMode: (definition: ModeDefinition) => {
			modeDefinitions.set(definition.id, definition);
		},
		unregisterMode: (id: string) => {
			modeDefinitions.delete(id);
			if (mode === id) mode = "command";
		},
		modeIds,
	};

	// ---- shortcut: Shift+Tab ----
	// Note: also unbind `app.thinking.cycle` in ~/.pi/agent/keybindings.json
	// so Shift+Tab doesn't double-fire the built-in thinking-level cycler.
	pi.registerShortcut("shift+tab", {
		description: "Cycle pi mode (Cmd / Ask plus registered modes)",
		handler: async (ctx) => cycleMode(ctx),
	});

	// ---- gate tool calls based on mode ----
	// Ask mode blocks mutations while still allowing safe read-only shell commands.
	pi.on("tool_call", async (event, _ctx) => {
		if (mode !== "ask") return;

		const toolName = event.toolName;
		if (WRITE_ONLY_TOOLS.has(toolName)) {
			return {
				block: true,
				reason: `Ask mode is active - the assistant must answer without running '${toolName}'. Switch modes with Shift+Tab to allow it.`,
			};
		}
		if (toolName === "bash") {
			const cmd = (event.input as { command?: string }).command ?? "";
			if (!isSafeBashCommand(cmd)) {
				return {
					block: true,
					reason: `Ask mode is active - only read-only commands (grep, find, ls, git log, etc.) are allowed. Switch modes with Shift+Tab to run '${cmd.split(" ")[0]}'.`,
				};
			}
		}
	});

	// ---- inject per-mode guidance for the LLM via the system prompt ----
	// We append to event.systemPrompt instead of injecting a visible message,
	// so nothing shows up above the prompt input. Prompt text is sourced from
	// the canonical Mode Prompt Registry in ~/.pi/agent/AGENTS.md.
	pi.on("before_agent_start", async (event, _ctx) => {
		const directive = getModePrompt(getModeDefinition().promptTemplateId);
		if (!directive) return;

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
			data?: { mode?: string };
		}>;
		const last = [...entries].reverse().find((e) => e.type === "custom" && e.customType === "pi-plan-mode");
		if (last?.data?.mode && modeDefinitions.has(last.data.mode)) {
			mode = last.data.mode;
		} else if (!modeDefinitions.has(mode)) {
			mode = "command";
		}
		editorDraftIsBash = false;
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
				return theme.fg(getModeDefinition().colorToken, text);
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
					const modeLabel = getModeDefinition().label;
					let modePainted = modeLabel;
					try {
						modePainted = theme.fg(getModeDefinition().colorToken, modeLabel);
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
