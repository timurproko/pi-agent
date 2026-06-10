import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chainEditor } from "../_editor-chain.ts";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * shortcuts extension
 *
 * Custom keyboard shortcuts and keyboard/input UX tweaks.
 *
 *   Ctrl+Alt+P — cycle through selectable models (built-in + custom)
 *   that have configured auth. No-key models are skipped before calling
 *   pi.setModel(), which avoids repeated "No API key" warnings.
 *
 *   Bare Esc — let global Esc handling win when custom TUI input listeners
 *   are active. This keeps Esc behavior consistent across modal/list UIs.
 */
const LOG = path.join(process.env.USERPROFILE || ".", ".pi", "agent", "shortcuts-debug.log");
const SETTINGS = path.join(__dirname, "settings.json");
const PATCHED = Symbol.for("shortcuts:tui-handleInput-patched");

interface ShortcutsSettings {
	cycleModels: boolean;
	bareEscHandling: boolean;
}

const DEFAULT_SETTINGS: ShortcutsSettings = {
	cycleModels: true,
	bareEscHandling: true,
};

function readSettings(): ShortcutsSettings {
	try {
		const raw = JSON.parse(fs.readFileSync(SETTINGS, "utf8")) as Partial<ShortcutsSettings>;
		return {
			cycleModels: raw.cycleModels ?? DEFAULT_SETTINGS.cycleModels,
			bareEscHandling: raw.bareEscHandling ?? DEFAULT_SETTINGS.bareEscHandling,
		};
	} catch {
		return DEFAULT_SETTINGS;
	}
}

function log(msg: string): void {
	try {
		fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`);
	} catch {
		// Debug logging must never break shortcuts.
	}
}

function patchBareEscHandling(tui: any, source: string): void {
	if (!tui || typeof tui.handleInput !== "function") {
		log(`patchBareEscHandling[${source}]: no tui or no handleInput`);
		return;
	}
	if (tui[PATCHED]) {
		log(`patchBareEscHandling[${source}]: already patched`);
		return;
	}

	const original = tui.handleInput.bind(tui);
	tui.handleInput = (data: string) => {
		if (readSettings().bareEscHandling && data === "\x1b") {
			log(`bare ESC intercepted, listeners=${tui.inputListeners?.size ?? 0}`);
			if (tui.inputListeners && tui.inputListeners.size > 0) {
				const saved = tui.inputListeners;
				tui.inputListeners = new Set();
				try {
					original(data);
				} finally {
					tui.inputListeners = saved;
				}
				return;
			}
		}
		original(data);
	};
	tui[PATCHED] = true;
	log(`patchBareEscHandling[${source}]: patched OK`);
}

export default function shortcutsExtension(pi: ExtensionAPI): void {
	log("shortcuts factory loaded");

	pi.on("session_start", (_event, ctx) => {
		log("session_start fired");
		const ui: any = (ctx as any).ui;
		if (!ui) {
			log("no ui on ctx");
			return;
		}

		const ok = chainEditor(ui, (editor, tui) => {
			log("chainEditor decorator ran");
			patchBareEscHandling(tui, "chainEditor");
			return editor;
		});
		log(`chainEditor returned ${ok}`);

		const tui = ui.tui ?? ui._tui ?? ui.terminalUI;
		if (tui) patchBareEscHandling(tui, "session_start-direct");
		else log("no tui on ui directly");
	});

	pi.registerShortcut("ctrl+alt+p", {
		description: "Cycle through selectable models",
		handler: async (ctx) => {
			if (!readSettings().cycleModels) {
				ctx.ui.notify("Cycle models shortcut is disabled in shortcuts settings.", "info");
				return;
			}
			const selectable = ctx.modelRegistry?.getAvailable?.() ?? [];
			if (selectable.length === 0) {
				ctx.ui.notify("No selectable models found (missing API keys?)", "warning");
				return;
			}

			const current = ctx.model;
			const currentIdx = current
				? selectable.findIndex((m) => m.provider === current.provider && m.id === current.id)
				: -1;
			const next = selectable[(currentIdx + 1) % selectable.length];

			const ok = await pi.setModel(next);
			if (!ok) {
				ctx.ui.notify(`Could not select ${next.provider}/${next.id}`, "warning");
				return;
			}

			ctx.ui.notify(`Model: ${next.provider}/${next.id}`, "info");
		},
	});
}
