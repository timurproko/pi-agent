import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	type TUI,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export type EditorUiKeybindings = {
	matches: (keyData: string, keybindingId: string) => boolean;
};

export interface EditorModalFilter<T extends string = string> {
	value: T;
	label: string;
}

export interface EditorModalItem<T = string> {
	value: T;
	label: string;
	description?: string;
	checked?: boolean;
	disabled?: boolean;
}

export interface EditorModalOptions<T = string, F extends string = string> {
	tui: TUI;
	theme: Theme;
	keybindings: EditorUiKeybindings;
	title: string;
	subtitle?: string;
	filters?: Array<EditorModalFilter<F>>;
	initialFilter?: F;
	items?: Array<EditorModalItem<T>>;
	getItems?: (filter?: F) => Array<EditorModalItem<T>>;
	maxVisible?: number;
	shortcuts?: string;
	noItemsText?: string;
	descriptionGap?: number;
	getStatusText?: () => string | undefined;
	onSelect: (item: EditorModalItem<T>, filter?: F) => void;
	onCancel: () => void;
	onFilterChange?: (filter: F) => void;
	onInput?: (keyData: string, filter?: F) => boolean;
}

export interface EditorSearchModalOptions<T = string> {
	tui: TUI;
	theme: Theme;
	keybindings: EditorUiKeybindings;
	title: string;
	initialQuery?: string;
	items?: Array<EditorModalItem<T>>;
	getItems?: (query: string) => Array<EditorModalItem<T>>;
	filterItem?: (item: EditorModalItem<T>, query: string) => boolean;
	maxVisible?: number;
	shortcuts?: string;
	noItemsText?: string;
	descriptionGap?: number;
	onSelect: (item: EditorModalItem<T>, query: string) => void;
	onCancel: () => void;
}

function defaultFilterItem<T>(item: EditorModalItem<T>, query: string): boolean {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return true;
	return `${item.label} ${item.description ?? ""}`.toLowerCase().includes(normalized);
}

export class EditorModal<T = string, F extends string = string> implements Component, Focusable {
	private selectedIndex = 0;
	private filter?: F;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(private readonly options: EditorModalOptions<T, F>) {
		this.filter = options.initialFilter ?? options.filters?.[0]?.value;
	}

	private getItems(): Array<EditorModalItem<T>> {
		return this.options.getItems?.(this.filter) ?? this.options.items ?? [];
	}

	private clampSelection(items = this.getItems()): void {
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, items.length - 1));
	}

	private moveSelection(delta: number): void {
		const items = this.getItems();
		if (items.length === 0) return;
		let next = this.selectedIndex;
		for (let i = 0; i < items.length; i += 1) {
			next = (next + delta + items.length) % items.length;
			if (!items[next]?.disabled) {
				this.selectedIndex = next;
				return;
			}
		}
	}

	private cycleFilter(): void {
		const filters = this.options.filters;
		if (!filters || filters.length <= 1) return;
		const currentIndex = filters.findIndex((filter) => filter.value === this.filter);
		const next = filters[(currentIndex + 1) % filters.length] ?? filters[0];
		if (!next) return;
		this.filter = next.value;
		this.selectedIndex = 0;
		this.options.onFilterChange?.(next.value);
	}

	handleInput(keyData: string): void {
		const kb = this.options.keybindings;
		if (this.options.onInput?.(keyData, this.filter)) {
			this.options.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.up") || matchesKey(keyData, Key.up)) {
			this.moveSelection(-1);
			this.options.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.down") || matchesKey(keyData, Key.down)) {
			this.moveSelection(1);
			this.options.tui.requestRender();
			return;
		}
		if (keyData === "\t") {
			this.cycleFilter();
			this.options.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") || matchesKey(keyData, Key.enter)) {
			const item = this.getItems()[this.selectedIndex];
			if (item && !item.disabled) this.options.onSelect(item, this.filter);
			this.options.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel") || keyData === "q") {
			this.options.onCancel();
		}
	}

	render(width: number): string[] {
		const theme = this.options.theme;
		const items = this.getItems();
		this.clampSelection(items);

		const lines: string[] = [];
		const push = (line = "") => lines.push(truncateToWidth(line, width));
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));

		push(border);
		push();
		push(theme.fg("accent", theme.bold(this.options.title)));
		if (this.options.subtitle) {
			push(theme.fg("dim", this.options.subtitle));
		}
		push();

		if (this.options.filters && this.options.filters.length > 0) {
			const sep = theme.fg("dim", " | ");
			const filterText = theme.fg("dim", "Filter: ") + this.options.filters
				.map((filter) => theme.fg(filter.value === this.filter ? "accent" : "dim", filter.label))
				.join(sep);
			push(filterText);
			push();
		}

		this.renderItems(push, items);
		push();
		push(theme.fg("dim", this.options.shortcuts ?? "↑↓ navigate • enter select • esc back"));
		const statusText = this.options.getStatusText?.();
		if (statusText) push(theme.fg("warning", statusText));
		push(border);
		return lines;
	}

	private renderItems(push: (line?: string) => void, items: Array<EditorModalItem<T>>): void {
		const theme = this.options.theme;
		if (items.length === 0) {
			push(theme.fg("muted", `  ${this.options.noItemsText ?? "No matching items"}`));
			return;
		}

		const maxVisible = this.options.maxVisible ?? 10;
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, items.length);
		const visibleItems = items.slice(startIndex, endIndex);
		const hasDescriptions = visibleItems.some((item) => item.description);
		const labelColumnWidth = hasDescriptions
			? Math.max(...visibleItems.map((item) => visibleWidth(item.label)))
			: 0;
		const descriptionGap = this.options.descriptionGap ?? 7;

		for (let i = startIndex; i < endIndex; i += 1) {
			const item = items[i];
			if (!item) continue;
			const selected = i === this.selectedIndex && !item.disabled;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			const labelColor = item.disabled ? "dim" : selected ? "accent" : "text";
			let line = prefix + theme.fg(labelColor, item.label);

			if (hasDescriptions) {
				const padding = " ".repeat(Math.max(descriptionGap, labelColumnWidth - visibleWidth(item.label) + descriptionGap));
				const descriptionColor = item.disabled ? "dim" : selected ? "accent" : "muted";
				line += padding + theme.fg(descriptionColor, item.description ?? "");
			}

			if (item.checked !== undefined) {
				const icon = item.checked ? theme.fg("success", "✓") : theme.fg("dim", "✗");
				line += ` ${icon}`;
			}

			push(line);
		}

		if (items.length > maxVisible) {
			push(theme.fg("dim", `  (${this.selectedIndex + 1}/${items.length})`));
		}
	}

	invalidate(): void {}
}

export class EditorSearchModal<T = string> implements Component, Focusable {
	private readonly input = new Input();
	private selectedIndex = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(private readonly options: EditorSearchModalOptions<T>) {
		if (options.initialQuery) this.input.setValue(options.initialQuery);
		this.input.onSubmit = () => this.selectCurrent();
	}

	private getQuery(): string {
		return this.input.getValue();
	}

	private getItems(): Array<EditorModalItem<T>> {
		const query = this.getQuery();
		if (this.options.getItems) return this.options.getItems(query);
		const filterItem = this.options.filterItem ?? defaultFilterItem;
		return (this.options.items ?? []).filter((item) => filterItem(item, query));
	}

	private clampSelection(items = this.getItems()): void {
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, items.length - 1));
	}

	private moveSelection(delta: number): void {
		const items = this.getItems();
		if (items.length === 0) return;
		let next = this.selectedIndex;
		for (let i = 0; i < items.length; i += 1) {
			next = (next + delta + items.length) % items.length;
			if (!items[next]?.disabled) {
				this.selectedIndex = next;
				return;
			}
		}
	}

	private selectCurrent(): void {
		const item = this.getItems()[this.selectedIndex];
		if (item && !item.disabled) this.options.onSelect(item, this.getQuery());
	}

	handleInput(keyData: string): void {
		const kb = this.options.keybindings;
		if (kb.matches(keyData, "tui.select.up") || matchesKey(keyData, Key.up)) {
			this.moveSelection(-1);
			this.options.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.down") || matchesKey(keyData, Key.down)) {
			this.moveSelection(1);
			this.options.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") || matchesKey(keyData, Key.enter)) {
			this.selectCurrent();
			this.options.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.options.onCancel();
			return;
		}

		const before = this.getQuery();
		this.input.handleInput(keyData);
		if (this.getQuery() !== before) this.selectedIndex = 0;
		this.options.tui.requestRender();
	}

	render(width: number): string[] {
		const theme = this.options.theme;
		const items = this.getItems();
		this.clampSelection(items);

		const lines: string[] = [];
		const push = (line = "") => lines.push(truncateToWidth(line, width));
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));

		push(border);
		push();
		push(theme.fg("accent", theme.bold(this.options.title)));
		push();
		for (const line of this.input.render(width)) push(line);
		push();
		this.renderItems(push, items);
		push();
		push(theme.fg("dim", this.options.shortcuts ?? "type to search • ↑↓ navigate • enter select • esc back"));
		push(border);
		return lines;
	}

	private renderItems(push: (line?: string) => void, items: Array<EditorModalItem<T>>): void {
		const theme = this.options.theme;
		if (items.length === 0) {
			push(theme.fg("muted", `  ${this.options.noItemsText ?? "No matching items"}`));
			return;
		}

		const maxVisible = this.options.maxVisible ?? 10;
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, items.length);
		const visibleItems = items.slice(startIndex, endIndex);
		const hasDescriptions = visibleItems.some((item) => item.description);
		const labelColumnWidth = hasDescriptions
			? Math.max(...visibleItems.map((item) => visibleWidth(item.label)))
			: 0;
		const descriptionGap = this.options.descriptionGap ?? 7;

		for (let i = startIndex; i < endIndex; i += 1) {
			const item = items[i];
			if (!item) continue;
			const selected = i === this.selectedIndex && !item.disabled;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			const labelColor = item.disabled ? "dim" : selected ? "accent" : "text";
			let line = prefix + theme.fg(labelColor, item.label);

			if (hasDescriptions) {
				const padding = " ".repeat(Math.max(descriptionGap, labelColumnWidth - visibleWidth(item.label) + descriptionGap));
				const descriptionColor = item.disabled ? "dim" : selected ? "accent" : "muted";
				line += padding + theme.fg(descriptionColor, item.description ?? "");
			}

			if (item.checked !== undefined) {
				const icon = item.checked ? theme.fg("success", "✓") : theme.fg("dim", "✗");
				line += ` ${icon}`;
			}

			push(line);
		}

		if (items.length > maxVisible) {
			push(theme.fg("dim", `  (${this.selectedIndex + 1}/${items.length})`));
		}
	}

	invalidate(): void {
		this.input.invalidate();
	}
}

// No-op default export so pi's extension loader (which picks up every .ts
// file in this directory) treats this shared helper as a valid extension.
export default function _editorUiNoop(_pi: ExtensionAPI): void {}
