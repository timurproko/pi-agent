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

type EditorColor = Parameters<Theme["fg"]>[0];

export interface EditorModalItem<T = string> {
	value: T;
	label: string;
	description?: string;
	prefixIcon?: string;
	prefixIconColor?: EditorColor;
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
	initialSelectedValue?: T;
	items?: Array<EditorModalItem<T>>;
	getItems?: (filter?: F, query?: string) => Array<EditorModalItem<T>>;
	maxVisible?: number;
	shortcuts?: string;
	noItemsText?: string | ((query: string) => string);
	descriptionGap?: number;
	search?: boolean;
	initialQuery?: string;
	highlightDescription?: boolean;
	getStatusText?: () => string | undefined;
	showItemShortcuts?: boolean;
	onSelect: (item: EditorModalItem<T>, filter?: F) => void;
	onCancel: () => void;
	onFilterChange?: (filter: F) => void;
	onInput?: (keyData: string, filter?: F, selectedItem?: EditorModalItem<T>) => boolean;
}

export type EditorSettingValue = boolean | number | string;

export interface EditorSettingField {
	key: string;
	label: string;
	type: "boolean" | "number" | "enum" | "string" | "action";
	value: EditorSettingValue;
	options?: string[];
	min?: number;
	max?: number;
	step?: number;
}

export interface EditorSettingsModalOptions {
	tui: TUI;
	theme: Theme;
	keybindings: EditorUiKeybindings;
	title?: string;
	fields: EditorSettingField[];
	shortcuts?: string;
	onChange: (field: EditorSettingField, value: EditorSettingValue) => void;
	onAction?: (field: EditorSettingField) => void;
	onBack: () => void;
}

export interface EditorConfirmModalOptions {
	tui: TUI;
	theme: Theme;
	keybindings: EditorUiKeybindings;
	title: string;
	subtitle?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	shortcuts?: string;
	onConfirm: () => void;
	onCancel: () => void;
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
	noItemsText?: string | ((query: string) => string);
	descriptionGap?: number;
	onSelect: (item: EditorModalItem<T>, query: string) => void;
	onCancel: () => void;
}

function defaultFilterItem<T>(item: EditorModalItem<T>, query: string): boolean {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return true;
	return `${item.label} ${item.description ?? ""}`.toLowerCase().includes(normalized);
}

function isInlineDescription(description?: string): boolean {
	return !!description && /^\([^)]*\)$/.test(description.trim());
}

const ITEM_SHORTCUT_KEYS = "abcdefghijklmnoprstuvwxyz".split("");

function getVisibleItemRange(itemCount: number, selectedIndex: number, maxVisible: number): { startIndex: number; endIndex: number } {
	const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), itemCount - maxVisible));
	const endIndex = Math.min(startIndex + maxVisible, itemCount);
	return { startIndex, endIndex };
}

export class EditorModal<T = string, F extends string = string> implements Component, Focusable {
	private readonly input = new Input();
	private selectedIndex = 0;
	private filter?: F;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.options.search) this.input.focused = value;
	}

	constructor(private readonly options: EditorModalOptions<T, F>) {
		if (options.initialQuery) this.input.setValue(options.initialQuery);
		this.filter = options.initialFilter ?? options.filters?.[0]?.value;
		if (options.initialSelectedValue !== undefined) {
			const selectedIndex = this.getItems().findIndex((item) => item.value === options.initialSelectedValue);
			if (selectedIndex >= 0) this.selectedIndex = selectedIndex;
		}
	}

	private getQuery(): string {
		return this.options.search ? this.input.getValue() : "";
	}

	private getItems(): Array<EditorModalItem<T>> {
		return this.options.getItems?.(this.filter, this.getQuery()) ?? this.options.items ?? [];
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
		const items = this.getItems();
		this.clampSelection(items);
		if (this.options.onInput?.(keyData, this.filter, items[this.selectedIndex])) {
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
		if (this.options.showItemShortcuts && /^[a-z]$/.test(keyData)) {
			const maxVisible = this.options.maxVisible ?? 10;
			const { startIndex, endIndex } = getVisibleItemRange(items.length, this.selectedIndex, maxVisible);
			const shortcutIndex = ITEM_SHORTCUT_KEYS.indexOf(keyData);
			const targetIndex = startIndex + shortcutIndex;
			const item = shortcutIndex >= 0 && targetIndex < endIndex ? items[targetIndex] : undefined;
			if (item && !item.disabled) {
				this.selectedIndex = targetIndex;
				this.options.onSelect(item, this.filter);
				this.options.tui.requestRender();
				return;
			}
		}
		if (kb.matches(keyData, "tui.select.confirm") || matchesKey(keyData, Key.enter)) {
			const item = this.getItems()[this.selectedIndex];
			if (item && !item.disabled) this.options.onSelect(item, this.filter);
			this.options.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel") || (!this.options.search && keyData === "q")) {
			this.options.onCancel();
			return;
		}
		if (this.options.search) {
			const before = this.getQuery();
			this.input.handleInput(keyData);
			if (this.getQuery() !== before) this.selectedIndex = 0;
			this.options.tui.requestRender();
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

		if (this.options.search) {
			for (const line of this.input.render(width)) push(line);
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
			const noItemsText = typeof this.options.noItemsText === "function"
				? this.options.noItemsText(this.getQuery())
				: this.options.noItemsText;
			push(theme.fg("muted", `  ${noItemsText ?? "No matching items"}`));
			return;
		}

		const maxVisible = this.options.maxVisible ?? 10;
		const { startIndex, endIndex } = getVisibleItemRange(items.length, this.selectedIndex, maxVisible);
		const visibleItems = items.slice(startIndex, endIndex);
		const hasColumnDescriptions = visibleItems.some((item) => item.description && !isInlineDescription(item.description));
		const getLabelWidth = (item: EditorModalItem<T>) => visibleWidth(`${item.prefixIcon ? `${item.prefixIcon} ` : ""}${item.label}`);
		const labelColumnWidth = hasColumnDescriptions
			? Math.max(...visibleItems.map((item) => getLabelWidth(item)))
			: 0;
		const descriptionGap = this.options.descriptionGap ?? 7;

		for (let i = startIndex; i < endIndex; i += 1) {
			const item = items[i];
			if (!item) continue;
			const selected = i === this.selectedIndex && !item.disabled;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			const shortcut = this.options.showItemShortcuts
				? `${theme.fg(selected ? "accent" : "dim", ITEM_SHORTCUT_KEYS[i - startIndex] ?? " ")} `
				: "";
			const prefixIcon = item.prefixIcon
				? `${theme.fg(item.prefixIconColor ?? (item.disabled ? "dim" : "text"), item.prefixIcon)} `
				: "";
			const labelColor = item.disabled ? "dim" : selected ? "accent" : "text";
			let line = prefix + shortcut + prefixIcon + theme.fg(labelColor, item.label);

			if (item.description) {
				if (isInlineDescription(item.description)) {
					line += ` ${theme.fg("muted", item.description)}`;
				} else if (hasColumnDescriptions) {
					const padding = " ".repeat(Math.max(descriptionGap, labelColumnWidth - getLabelWidth(item) + descriptionGap));
					const descriptionColor = item.disabled ? "dim" : selected && this.options.highlightDescription !== false ? "accent" : "muted";
					line += padding + theme.fg(descriptionColor, item.description);
				}
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

export class EditorConfirmModal extends EditorModal<boolean> {
	constructor(options: EditorConfirmModalOptions) {
		super({
			tui: options.tui,
			theme: options.theme,
			keybindings: options.keybindings,
			title: options.title,
			subtitle: options.subtitle,
			items: [
				{ value: true, label: options.confirmLabel ?? "Yes" },
				{ value: false, label: options.cancelLabel ?? "No" },
			],
			shortcuts: options.shortcuts ?? "↑↓ choose • enter confirm • esc no",
			onSelect: (item) => item.value ? options.onConfirm() : options.onCancel(),
			onCancel: options.onCancel,
		});
	}
}

export class EditorSettingsModal implements Component, Focusable {
	private selectedIndex = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(private readonly options: EditorSettingsModalOptions) {}

	private updateSelected(delta: number): void {
		if (this.options.fields.length === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + this.options.fields.length) % this.options.fields.length;
	}

	private changeValue(delta = 1): void {
		const field = this.options.fields[this.selectedIndex];
		if (!field) return;

		let nextValue: EditorSettingValue = field.value;
		if (field.type === "boolean") {
			nextValue = !Boolean(field.value);
		} else if (field.type === "number") {
			const step = field.step ?? 1;
			const current = typeof field.value === "number" ? field.value : Number(field.value) || 0;
			nextValue = current + delta * step;
			if (typeof field.min === "number") nextValue = Math.max(field.min, nextValue);
			if (typeof field.max === "number") nextValue = Math.min(field.max, nextValue);
		} else if (field.type === "enum" && field.options?.length) {
			const currentIndex = Math.max(0, field.options.indexOf(String(field.value)));
			nextValue = field.options[(currentIndex + delta + field.options.length) % field.options.length] ?? field.value;
		} else if (field.type === "action") {
			this.options.onAction?.(field);
			return;
		} else {
			return;
		}

		field.value = nextValue;
		this.options.onChange(field, nextValue);
	}

	handleInput(keyData: string): void {
		const kb = this.options.keybindings;
		if (kb.matches(keyData, "tui.select.up") || matchesKey(keyData, Key.up)) {
			this.updateSelected(-1);
			this.options.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.down") || matchesKey(keyData, Key.down)) {
			this.updateSelected(1);
			this.options.tui.requestRender();
			return;
		}
		if (matchesKey(keyData, Key.left)) {
			this.changeValue(-1);
			this.options.tui.requestRender();
			return;
		}
		if (matchesKey(keyData, Key.right)) {
			this.changeValue(1);
			this.options.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") || matchesKey(keyData, Key.enter)) {
			this.changeValue(1);
			this.options.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.options.onBack();
		}
	}

	render(width: number): string[] {
		const theme = this.options.theme;
		const fields = this.options.fields;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, fields.length - 1));

		const lines: string[] = [];
		const push = (line = "") => lines.push(truncateToWidth(line, width));
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const labelColumnWidth = Math.max(1, Math.min(30, Math.floor(width * 0.35), Math.max(...fields.map((field) => visibleWidth(field.label)), 1)));
		const gap = 4;

		push(border);
		push();
		push(theme.fg("accent", theme.bold(this.options.title ?? "Settings")));
		push();

		if (fields.length === 0) {
			push(theme.fg("muted", "  No settings"));
		} else {
			for (let i = 0; i < fields.length; i += 1) {
				const field = fields[i]!;
				const selected = i === this.selectedIndex;
				const prefix = selected ? theme.fg("accent", "→ ") : "  ";
				const displayLabel = truncateToWidth(field.label, labelColumnWidth);
				const labelPadding = " ".repeat(Math.max(gap, labelColumnWidth - visibleWidth(displayLabel) + gap));
				const label = theme.fg(selected ? "accent" : "text", displayLabel);
				const displayValue = typeof field.value === "boolean" ? (field.value ? "yes" : "no") : String(field.value);
				const value = theme.fg("muted", displayValue);
				push(prefix + label + labelPadding + value);
			}
		}

		push();
		push(theme.fg("dim", this.options.shortcuts ?? "↑↓ navigate • enter toggle • ←→ adjust • esc back"));
		push(border);
		return lines;
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
			const noItemsText = typeof this.options.noItemsText === "function"
				? this.options.noItemsText(this.getQuery())
				: this.options.noItemsText;
			push(theme.fg("muted", `  ${noItemsText ?? "No matching items"}`));
			return;
		}

		const maxVisible = this.options.maxVisible ?? 10;
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, items.length);
		const visibleItems = items.slice(startIndex, endIndex);
		const hasColumnDescriptions = visibleItems.some((item) => item.description && !isInlineDescription(item.description));
		const labelColumnWidth = hasColumnDescriptions
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

			if (item.description) {
				if (isInlineDescription(item.description)) {
					line += ` ${theme.fg("muted", item.description)}`;
				} else if (hasColumnDescriptions) {
					const padding = " ".repeat(Math.max(descriptionGap, labelColumnWidth - visibleWidth(item.label) + descriptionGap));
					const descriptionColor = item.disabled ? "dim" : selected ? "accent" : "muted";
					line += padding + theme.fg(descriptionColor, item.description);
				}
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
