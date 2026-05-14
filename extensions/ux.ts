import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chainEditor } from "./_editor-chain.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const LOG = path.join(process.env.USERPROFILE || ".", ".pi", "agent", "ux-debug.log");
function log(msg: string) {
	try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

const PATCHED = Symbol.for("ux:tui-handleInput-patched");

function patchTui(tui: any, source: string): void {
	if (!tui || typeof tui.handleInput !== "function") {
		log(`patchTui[${source}]: no tui or no handleInput`);
		return;
	}
	if (tui[PATCHED]) {
		log(`patchTui[${source}]: already patched`);
		return;
	}
	const original = tui.handleInput.bind(tui);
	tui.handleInput = (data: string) => {
		if (data === "\x1b") {
			log(`bare ESC intercepted, listeners=${tui.inputListeners?.size ?? 0}`);
			if (tui.inputListeners && tui.inputListeners.size > 0) {
				const saved = tui.inputListeners;
				tui.inputListeners = new Set();
				try { original(data); } finally { tui.inputListeners = saved; }
				return;
			}
		}
		original(data);
	};
	tui[PATCHED] = true;
	log(`patchTui[${source}]: patched OK`);
}

export default function uxExtension(pi: ExtensionAPI): void {
	log("ux factory loaded");
	pi.on("session_start", (_event, ctx) => {
		log("session_start fired");
		const ui: any = (ctx as any).ui;
		if (!ui) { log("no ui on ctx"); return; }
		const ok = chainEditor(ui, (editor, tui) => {
			log("chainEditor decorator ran");
			patchTui(tui, "chainEditor");
			return editor;
		});
		log(`chainEditor returned ${ok}`);
		const tui = ui.tui ?? ui._tui ?? ui.terminalUI;
		if (tui) patchTui(tui, "session_start-direct");
		else log("no tui on ui directly");
	});
}
