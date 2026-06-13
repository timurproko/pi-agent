import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { EditorModal, EditorSearchModal, EditorTextPromptDialog, type EditorModalItem } from "../core/editor-ui";
import { barProgressLine } from "./platform";

export async function chooseFromModal<T>(
	ctx: ExtensionCommandContext,
	options: {
		title: string;
		subtitle?: string;
		items: Array<EditorModalItem<T>>;
		search?: boolean;
		shortcuts?: string;
		noItemsText?: string;
		maxVisible?: number;
	},
): Promise<T | undefined> {
	return await ctx.ui.custom<T | undefined>((tui, theme, keybindings, done) => new EditorModal<T>({
		tui,
		theme,
		keybindings,
		title: options.title,
		subtitle: options.subtitle,
		items: options.items,
		search: options.search,
		shortcuts: options.shortcuts,
		noItemsText: options.noItemsText,
		maxVisible: options.maxVisible,
		onSelect: (item) => done(item.value),
		onCancel: () => done(undefined),
	}));
}

export async function searchModal<T>(
	ctx: ExtensionCommandContext,
	options: {
		title: string;
		items: Array<EditorModalItem<T>>;
		shortcuts?: string;
		noItemsText?: string;
		maxVisible?: number;
	},
): Promise<{ value: T; query: string } | undefined> {
	return await ctx.ui.custom<{ value: T; query: string } | undefined>((tui, theme, keybindings, done) => new EditorSearchModal<T>({
		tui,
		theme,
		keybindings,
		title: options.title,
		items: options.items,
		shortcuts: options.shortcuts,
		noItemsText: options.noItemsText,
		maxVisible: options.maxVisible,
		onSelect: (item, query) => done({ value: item.value, query }),
		onCancel: () => done(undefined),
	}));
}

export async function textPrompt(ctx: ExtensionCommandContext, title: string, subtitle = "", initialText = ""): Promise<string | undefined> {
	return await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => new EditorTextPromptDialog({
		tui,
		theme,
		keybindings,
		title,
		subtitle,
		initialText,
		onSubmit: (text) => done(text),
		onCancel: () => done(undefined),
	}));
}

export class ProgressDialog {
	private lines: string[];
	constructor(private theme: Theme, private title: string, lines: string[]) {
		this.lines = lines;
	}
	setLines(lines: string[]): void {
		this.lines = lines;
	}
	handleInput(_data: string): void {}
	render(width: number): string[] {
		const lines: string[] = [];
		const border = this.theme.fg("border", "─".repeat(Math.max(1, width)));
		const push = (line = "") => lines.push(truncateToWidth(line, width));
		push(border);
		push(this.theme.fg("accent", this.theme.bold(this.title)));
		push("");
		for (const line of this.lines) push(line);
		push("");
		push(this.theme.fg("dim", "esc cancel if supported"));
		push(border);
		return lines;
	}
	invalidate(): void {}
}

export function setProgressWidget(ctx: ExtensionCommandContext, title: string, done: number, total: number, detail?: string): void {
	ctx.ui.setWidget("asset-store-progress", (_tui, theme) => ({
		render(width: number) {
			const parts = [theme.fg("accent", title), barProgressLine(done, total), detail ? theme.fg("muted", detail) : ""];
			return parts.filter(Boolean).map((line) => truncateToWidth(line, width));
		},
		invalidate() {},
	}));
}

export function clearProgressWidget(ctx: ExtensionCommandContext): void {
	ctx.ui.setWidget("asset-store-progress", undefined);
}

export class AssetIdInputDialog {
	private value = "";
	private cursor = 0;
	focused = false;
	constructor(private theme: Theme, private title: string, private lines: string[], private done: (value: string | undefined) => void) {}
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) return this.done(undefined);
		if (matchesKey(data, Key.enter)) return this.done(this.value.trim());
		if (matchesKey(data, Key.backspace)) {
			if (this.cursor > 0) {
				this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
				this.cursor -= 1;
			}
			return;
		}
		if (matchesKey(data, Key.left)) { this.cursor = Math.max(0, this.cursor - 1); return; }
		if (matchesKey(data, Key.right)) { this.cursor = Math.min(this.value.length, this.cursor + 1); return; }
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.value = this.value.slice(0, this.cursor) + data + this.value.slice(this.cursor);
			this.cursor += 1;
		}
	}
	render(width: number): string[] {
		const lines: string[] = [];
		const th = this.theme;
		const border = th.fg("border", "─".repeat(Math.max(1, width)));
		const push = (line = "") => lines.push(truncateToWidth(line, width));
		push(border);
		push(th.fg("accent", th.bold(this.title)));
		push("");
		for (const line of this.lines) push(line);
		push("");
		const before = this.value.slice(0, this.cursor);
		const cur = this.cursor < this.value.length ? this.value[this.cursor] : " ";
		const after = this.cursor < this.value.length ? this.value.slice(this.cursor + 1) : "";
		push(`> ${before}\x1b[7m${cur}\x1b[27m${after}`);
		push("");
		push(th.fg("dim", "Enter = submit • . = open folder • Esc = back"));
		push(border);
		return lines;
	}
	invalidate(): void {}
}

export function fixedWidthIdNameLabel(id: string, name: string): string {
	return `${id}  ${name.replace(/\s+/g, " ").trim()}`;
}

export function visiblePad(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}
