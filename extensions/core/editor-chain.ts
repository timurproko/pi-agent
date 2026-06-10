/**
 * Shared helper used by extensions that want to add behaviour to pi's editor
 * without stomping on each other.
 *
 * pi only allows ONE editor factory at a time (`ui.setEditorComponent`), so
 * if two extensions both call it the second one wins. This helper chains
 * factories: it reads the currently-installed factory via
 * `ui.getEditorComponent()`, then installs a new factory that:
 *   1. invokes the previous factory (or `new CustomEditor(...)` if none) to
 *      get a base editor instance,
 *   2. lets the caller decorate that instance (typically by monkey-patching
 *      `handleInput`, overriding `borderColor`, or wrapping `render`),
 *   3. returns the decorated instance.
 *
 * Because each extension only decorates the instance it receives, ordering
 * between extensions does not matter — features compose cleanly.
 *
 * Usage:
 *
 *   import { chainEditor } from "./core/editor-chain";
 *
 *   chainEditor(ctx.ui, (editor) => {
 *     const orig = editor.handleInput.bind(editor);
 *     editor.handleInput = (data) => { ...; orig(data); };
 *     return editor;
 *   });
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type EditorInstance = any;
export type EditorDecorator = (editor: EditorInstance, tui: any, theme: any, kb: any) => EditorInstance;

/**
 * Chain a new editor factory on top of whatever is currently installed.
 *
 * Returns true on success, false if `ui.setEditorComponent` is unavailable
 * (e.g. headless / non-interactive sessions).
 */
export function chainEditor(ui: any, decorate: EditorDecorator): boolean {
	if (!ui || typeof ui.setEditorComponent !== "function") return false;

	const prevFactory =
		typeof ui.getEditorComponent === "function" ? ui.getEditorComponent() : undefined;

	try {
		ui.setEditorComponent((tui: any, theme: any, kb: any) => {
			const base =
				typeof prevFactory === "function"
					? prevFactory(tui, theme, kb)
					: new (CustomEditor as any)(tui, theme, kb);
			return decorate(base, tui, theme, kb);
		});
		return true;
	} catch {
		return false;
	}
}

// No-op default export so this helper remains harmless if loaded directly.
// The actual API consumers import { chainEditor } above.
export default function editorChainNoop(_pi: ExtensionAPI): void {}
