import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * shortcuts extension
 *
 * Custom keyboard shortcuts.
 *
 *   Ctrl+Alt+P — cycle through selectable models (built-in + custom)
 *   that have configured auth. No-key models are skipped before calling
 *   pi.setModel(), which avoids repeated "No API key" warnings.
 */
export default function shortcutsExtension(pi: ExtensionAPI): void {
	pi.registerShortcut("ctrl+alt+p", {
		description: "Cycle through selectable models",
		handler: async (ctx) => {
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
