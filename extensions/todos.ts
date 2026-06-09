/**
 * This extension stores todo items as files under <todo-dir> (defaults to .pi/todos,
 * or the path in PI_TODO_PATH).  Each todo is a standalone markdown file named
 * <id>.md and an optional <id>.lock file is used while a session is editing it.
 *
 * File format in .pi/todos:
 * - The file starts with a JSON object (not YAML) containing the front matter:
 *   { id, title, tags, status, created_at, assigned_to_session }
 * - After the JSON block comes optional markdown body text separated by a blank line.
 * - Example:
 *   {
 *     "id": "deadbeef",
 *     "title": "Add tests",
 *     "tags": ["qa"],
 *     "status": "open",
 *     "created_at": "2026-01-25T17:00:00.000Z",
 *     "assigned_to_session": "session.json"
 *   }
 *
 *   Notes about the work go here.
 *
 * Todo settings are kept in the global agent settings file under the `todos` key:
 * C:\Users\<user>\.pi\agent\settings.json.
 *
 * Use `/todos` to bring up the visual todo manager or just let the LLM use them
 * naturally.
 */
import { DynamicBorder, copyToClipboard, getMarkdownTheme, keyHint, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import crypto from "node:crypto";
import {
	Container,
	type Focusable,
	Input,
	Key,
	Markdown,
	SelectList,
	Spacer,
	type SelectItem,
	Text,
	TUI,
	fuzzyMatch,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const TODO_DIR_NAME = ".pi/todos";
const AGENT_TODO_DIR_NAME = "todos";
const TODO_WIDGET_KEY = "todos-widget";
const TODO_WIDGET_MAX_VISIBLE = 8;
const TODO_PATH_ENV = "PI_TODO_PATH";
const TODO_ID_PREFIX = "TODO-";
const TODO_ID_PATTERN = /^[a-f0-9]{8}$/i;
const DEFAULT_TODO_SETTINGS = {
	saveTodosInCurrentWorkingDirectory: true,
	maxVisibleTodosInWidget: TODO_WIDGET_MAX_VISIBLE,
	widgetSortOrder: "time" as "id" | "time",
};
const LOCK_TTL_MS = 30 * 60 * 1000;

interface TodoFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
	assigned_to_session?: string;
}

interface TodoRecord extends TodoFrontMatter {
	body: string;
}

interface LockInfo {
	id: string;
	pid: number;
	session?: string | null;
	created_at: string;
}

interface TodoSettings {
	saveTodosInCurrentWorkingDirectory: boolean;
	maxVisibleTodosInWidget: number;
	widgetSortOrder: "id" | "time";
}

type KeybindingMatcher = {
	matches: (keyData: string, keybindingId: string) => boolean;
};

const TodoParams = Type.Object({
	action: StringEnum([
		"list",
		"list-all",
		"get",
		"create",
		"update",
		"append",
		"delete",
		"claim",
		"release",
	] as const),
	id: Type.Optional(
		Type.String({ description: "Todo id (TODO-<hex> or raw hex filename)" }),
	),
	title: Type.Optional(Type.String({ description: "Short summary shown in lists" })),
	status: Type.Optional(Type.String({ description: "Todo status" })),
	tags: Type.Optional(Type.Array(Type.String({ description: "Todo tag" }))),
	body: Type.Optional(
		Type.String({ description: "Long-form details (markdown). Update replaces; append adds." }),
	),
	force: Type.Optional(Type.Boolean({ description: "Override another session's assignment" })),
});

type TodoAction =
	| "list"
	| "list-all"
	| "get"
	| "create"
	| "update"
	| "append"
	| "delete"
	| "claim"
	| "release";

type TodoOverlayAction = "back";

type TodoHomeAction = "view" | "clearAll" | "settings";

type TodoMenuAction =
	| "work"
	| "refine"
	| "close"
	| "reopen"
	| "release"
	| "delete"
	| "copyPath"
	| "copyText"
	| "view";

type TodoToolDetails =
	| { action: "list" | "list-all"; todos: TodoFrontMatter[]; currentSessionId?: string; error?: string }
	| {
			action: "get" | "create" | "update" | "append" | "delete" | "claim" | "release";
			todo: TodoRecord;
			error?: string;
		};

function formatTodoId(id: string): string {
	return `${TODO_ID_PREFIX}${id}`;
}

function cyanTodoId(id: string): string {
	// Match the hardcoded cyan used by the answer extension's "Questions" title.
	return `\x1b[36m${formatTodoId(id)}\x1b[0m`;
}

function normalizeTodoId(id: string): string {
	let trimmed = id.trim();
	if (trimmed.startsWith("#")) {
		trimmed = trimmed.slice(1);
	}
	if (trimmed.toUpperCase().startsWith(TODO_ID_PREFIX)) {
		trimmed = trimmed.slice(TODO_ID_PREFIX.length);
	}
	return trimmed;
}

function validateTodoId(id: string): { id: string } | { error: string } {
	const normalized = normalizeTodoId(id);
	if (!normalized || !TODO_ID_PATTERN.test(normalized)) {
		return { error: "Invalid todo id. Expected TODO-<hex>." };
	}
	return { id: normalized.toLowerCase() };
}

function displayTodoId(id: string): string {
	return formatTodoId(normalizeTodoId(id));
}

function isTodoClosed(status: string): boolean {
	return ["closed", "done"].includes(status.toLowerCase());
}

function clearAssignmentIfClosed(todo: TodoFrontMatter): void {
	if (isTodoClosed(getTodoStatus(todo))) {
		todo.assigned_to_session = undefined;
	}
}

function sortTodos(todos: TodoFrontMatter[]): TodoFrontMatter[] {
	return [...todos].sort((a, b) => {
		const aClosed = isTodoClosed(a.status);
		const bClosed = isTodoClosed(b.status);
		if (aClosed !== bClosed) return aClosed ? 1 : -1;
		const aAssigned = !aClosed && Boolean(a.assigned_to_session);
		const bAssigned = !bClosed && Boolean(b.assigned_to_session);
		if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
		return (a.created_at || "").localeCompare(b.created_at || "");
	});
}

function buildTodoSearchText(todo: TodoFrontMatter): string {
	const tags = todo.tags.join(" ");
	const assignment = todo.assigned_to_session ? `assigned:${todo.assigned_to_session}` : "";
	return `${formatTodoId(todo.id)} ${todo.id} ${todo.title} ${tags} ${todo.status} ${assignment}`.trim();
}

function filterTodos(todos: TodoFrontMatter[], query: string): TodoFrontMatter[] {
	const trimmed = query.trim();
	if (!trimmed) return todos;

	const tokens = trimmed
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);

	if (tokens.length === 0) return todos;

	const matches: Array<{ todo: TodoFrontMatter; score: number }> = [];
	for (const todo of todos) {
		const text = buildTodoSearchText(todo);
		let totalScore = 0;
		let matched = true;
		for (const token of tokens) {
			const result = fuzzyMatch(token, text);
			if (!result.matches) {
				matched = false;
				break;
			}
			totalScore += result.score;
		}
		if (matched) {
			matches.push({ todo, score: totalScore });
		}
	}

	return matches
		.sort((a, b) => {
			const aClosed = isTodoClosed(a.todo.status);
			const bClosed = isTodoClosed(b.todo.status);
			if (aClosed !== bClosed) return aClosed ? 1 : -1;
			const aAssigned = !aClosed && Boolean(a.todo.assigned_to_session);
			const bAssigned = !bClosed && Boolean(b.todo.assigned_to_session);
			if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
			return a.score - b.score;
		})
		.map((match) => match.todo);
}

type TodoScope = "open" | "closed";

class TodoHomeMenuComponent extends Container implements Focusable {
	private selectedIndex = 0;
	private items: Array<{ action: TodoHomeAction; label: string; disabled?: boolean }>;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(
		private theme: Theme,
		private keybindings: KeybindingMatcher,
		private onSelectCallback: (action: TodoHomeAction) => void,
		private onCancelCallback: () => void,
	) {
		super();
		this.items = [
			{ action: "view", label: "View todos" },
			{ action: "clearAll", label: "Delete all todos" },
			{ action: "settings", label: "Extension settings" },
		];
		this.selectedIndex = this.firstEnabledIndex();
	}

	private firstEnabledIndex(): number {
		const index = this.items.findIndex((item) => !item.disabled);
		return index >= 0 ? index : 0;
	}

	private moveSelection(delta: number): void {
		if (this.items.every((item) => item.disabled)) return;
		let next = this.selectedIndex;
		for (let i = 0; i < this.items.length; i++) {
			next = (next + delta + this.items.length) % this.items.length;
			if (!this.items[next]?.disabled) {
				this.selectedIndex = next;
				return;
			}
		}
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.items[this.selectedIndex];
			if (selected && !selected.disabled) this.onSelectCallback(selected.action);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const border = this.theme.fg("border", "─".repeat(Math.max(1, width)));
		lines.push(border);
		lines.push("");
		lines.push(this.theme.fg("accent", this.theme.bold("Todos")));
		lines.push("");
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const selected = i === this.selectedIndex && !item.disabled;
			const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
			const labelColor = item.disabled ? "dim" : selected ? "accent" : "text";
			const label = this.theme.fg(labelColor, item.label);
			lines.push(prefix + label);
		}
		lines.push("");
		lines.push(this.theme.fg("dim", "↑↓ navigate • enter select • esc close"));
		lines.push(border);
		return lines;
	}

	override invalidate(): void {}
}

class TodoSettingsMenuComponent extends Container implements Focusable {
	private selectedIndex = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(
		private theme: Theme,
		private keybindings: KeybindingMatcher,
		private settings: TodoSettings,
		private onChange: (settings: TodoSettings) => void,
		private onBack: () => void,
	) {
		super();
	}

	private updateSelected(delta: number): void {
		this.selectedIndex = (this.selectedIndex + delta + 3) % 3;
	}

	private changeValue(delta = 1): void {
		if (this.selectedIndex === 0) {
			this.settings.saveTodosInCurrentWorkingDirectory = !this.settings.saveTodosInCurrentWorkingDirectory;
		} else if (this.selectedIndex === 1) {
			this.settings.maxVisibleTodosInWidget = Math.max(1, Math.min(100, this.settings.maxVisibleTodosInWidget + delta));
		} else if (this.selectedIndex === 2) {
			this.settings.widgetSortOrder = this.settings.widgetSortOrder === "id" ? "time" : "id";
		}
		this.onChange(this.settings);
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.select.up")) {
			this.updateSelected(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.updateSelected(1);
			return;
		}
		if (matchesKey(keyData, Key.left)) {
			this.changeValue(-1);
			return;
		}
		if (matchesKey(keyData, Key.right)) {
			this.changeValue(1);
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.changeValue(1);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onBack();
		}
	}

	render(width: number): string[] {
		const border = this.theme.fg("border", "─".repeat(Math.max(1, width)));
		const rows = [
			["Save in PWD directory", this.settings.saveTodosInCurrentWorkingDirectory ? "yes" : "no"],
			["Max visible todos in widget", String(this.settings.maxVisibleTodosInWidget)],
			["Widget sort order", this.settings.widgetSortOrder],
		] as const;
		const lines = [border, "", this.theme.fg("accent", this.theme.bold("Extension settings")), ""];
		for (let i = 0; i < rows.length; i++) {
			const [label, value] = rows[i]!;
			const selected = i === this.selectedIndex;
			const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
			const labelText = this.theme.fg(selected ? "accent" : "text", label.padEnd(34));
			const valueText = this.theme.fg("muted", value);
			lines.push(prefix + labelText + valueText);
		}
		lines.push("");
		lines.push(this.theme.fg("dim", "↑↓ navigate • enter toggle • ←→ adjust • esc back"));
		lines.push(border);
		return lines;
	}

	override invalidate(): void {}
}

class TodoSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private listContainer: Container;
	private allTodos: TodoFrontMatter[];
	private filteredTodos: TodoFrontMatter[];
	private selectedIndex = 0;
	private onSelectCallback: (todo: TodoFrontMatter) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private scope: TodoScope = "open";
	private theme: Theme;
	private keybindings: KeybindingMatcher;
	private headerText: Text;
	private scopeText: Text;
	private scopeHintText: Text;
	private hintText: Text;
	private currentSessionId?: string;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingMatcher,
		todos: TodoFrontMatter[],
		onSelect: (todo: TodoFrontMatter) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		currentSessionId?: string,
		private onQuickAction?: (todo: TodoFrontMatter, action: "work" | "refine") => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.currentSessionId = currentSessionId;
		this.allTodos = todos;
		this.filteredTodos = todos;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
		this.addChild(new Spacer(1));

		this.headerText = new Text("", 0, 0);
		this.addChild(this.headerText);
		this.addChild(new Spacer(1));

		this.scopeText = new Text("", 0, 0);
		this.addChild(this.scopeText);
		this.scopeHintText = new Text("", 0, 0);
		this.addChild(this.scopeHintText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.hintText = new Text("", 0, 0);
		this.addChild(this.hintText);
		this.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));

		this.updateHeader();
		this.updateScope();
		this.updateHints();
		this.applyFilter(this.searchInput.getValue());
	}

	setTodos(todos: TodoFrontMatter[]): void {
		this.allTodos = todos;
		this.updateHeader();
		this.applyFilter(this.searchInput.getValue());
		this.tui.requestRender();
	}

	getSearchValue(): string {
		return this.searchInput.getValue();
	}

	private updateHeader(): void {
		this.headerText.setText(this.theme.fg("accent", this.theme.bold("View todos")));
	}

	private updateScope(): void {
		const openLabel = this.scope === "open"
			? this.theme.fg("accent", "open")
			: this.theme.fg("dim", "open");
		const closedLabel = this.scope === "closed"
			? this.theme.fg("accent", "closed")
			: this.theme.fg("dim", "closed");
		const sep = this.theme.fg("dim", " | ");
		this.scopeText.setText(this.theme.fg("dim", "Filter: ") + openLabel + sep + closedLabel);
		this.scopeHintText.setText(this.theme.fg("dim", "tab filter (open/closed)"));
	}

	private updateHints(): void {
		this.hintText.setText(
			this.theme.fg(
				"dim",
				"type to search • ↑↓ navigate • tab filter • enter actions • esc back",
			),
		);
	}

	private applyFilter(query: string): void {
		let todos = this.allTodos;
		if (this.scope === "open") {
			todos = todos.filter((t) => !isTodoClosed(t.status));
		} else {
			todos = todos.filter((t) => isTodoClosed(t.status));
		}
		this.filteredTodos = filterTodos(todos, query);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredTodos.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredTodos.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching todos"), 0, 0));
			return;
		}

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredTodos.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredTodos.length);

		for (let i = startIndex; i < endIndex; i += 1) {
			const todo = this.filteredTodos[i];
			if (!todo) continue;
			const isSelected = i === this.selectedIndex;
			const closed = isTodoClosed(todo.status);
			const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			const titleColor = isSelected ? "accent" : closed ? "dim" : "text";
			const tagText = todo.tags.length ? ` [${todo.tags.join(", ")}]` : "";
			const assignmentText = renderAssignmentSuffix(this.theme, todo, this.currentSessionId);

			let icon: string;
			if (closed) {
				icon = this.theme.fg("success", "✓");
			} else if (todo.assigned_to_session) {
				icon = this.theme.fg("accent", "◼");
			} else {
				icon = "◻";
			}

			const idText = closed
				? this.theme.fg("dim", "\x1b[9m#" + todo.id + "\x1b[29m")
				: this.theme.fg("dim", "#" + todo.id);

			const line =
				prefix +
				icon + " " +
				idText +
				" " +
				this.theme.fg(titleColor, todo.title || "(untitled)") +
				this.theme.fg("muted", tagText) +
				assignmentText;
			this.listContainer.addChild(new Text(line, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredTodos.length) {
			const scrollInfo = this.theme.fg(
				"dim",
				`  (${this.selectedIndex + 1}/${this.filteredTodos.length})`,
			);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredTodos.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredTodos.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredTodos.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredTodos.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}
		if (keyData === "\t") {
			this.scope = this.scope === "open" ? "closed" : "open";
			this.selectedIndex = 0;
			this.updateHeader();
			this.updateScope();
			this.applyFilter(this.searchInput.getValue());
			return;
		}
		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	override invalidate(): void {
		super.invalidate();
		this.updateHeader();
		this.updateScope();
		this.updateHints();
		this.updateList();
	}
}

class TodoActionMenuComponent extends Container {
	private selectList: SelectList;
	private onSelectCallback: (action: TodoMenuAction) => void;
	private onCancelCallback: () => void;

	constructor(
		theme: Theme,
		todo: TodoRecord,
		onSelect: (action: TodoMenuAction) => void,
		onCancel: () => void,
	) {
		super();
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		const closed = isTodoClosed(todo.status);
		const title = todo.title || "(untitled)";
		const options: SelectItem[] = [
			{ value: "view", label: "view", description: "View todo" },
			{ value: "refine", label: "refine", description: "Refine todo" },
			{ value: "work", label: "work", description: "Work on todo" },
			...(closed
				? [{ value: "reopen", label: "reopen", description: "Reopen todo" }]
				: [{ value: "close", label: "close", description: "Close todo" }]),
			...(todo.assigned_to_session
				? [{ value: "release", label: "release", description: "Release assignment" }]
				: []),
			{ value: "delete", label: "delete", description: "Delete todo" },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
		this.addChild(
			new Text(
				theme.fg(
					"accent",
					theme.bold(`Actions for ${displayTodoId(todo.id)}: "${title}"`),
				),
			),
		);

		this.selectList = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		}, { maxPrimaryColumnWidth: 16 });

		this.selectList.onSelect = (item) => this.onSelectCallback(item.value as TodoMenuAction);
		this.selectList.onCancel = () => this.onCancelCallback();

		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc back"), 0, 0));
		this.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}

	override invalidate(): void {
		super.invalidate();
	}
}

class TodoDeleteConfirmComponent extends Container implements Focusable {
	private selectedIndex = 0;
	private readonly cancelLabel: "back" | "cancel";
	private readonly subtitle?: string;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(
		private theme: Theme,
		private keybindings: KeybindingMatcher,
		private title: string,
		private onConfirm: (confirmed: boolean) => void,
		options?: { subtitle?: string; cancelLabel?: "back" | "cancel" },
	) {
		super();
		this.subtitle = options?.subtitle;
		this.cancelLabel = options?.cancelLabel ?? "back";
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.select.up") || kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === 0 ? 1 : 0;
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.onConfirm(this.selectedIndex === 0);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onConfirm(false);
		}
	}

	render(width: number): string[] {
		const border = this.theme.fg("border", "─".repeat(Math.max(1, width)));
		const lines: string[] = [
			border,
			"",
			this.theme.fg("accent", this.theme.bold(this.title)),
		];
		if (this.subtitle) {
			// Subtitle sits directly under the title, matching standard dialogs.
			lines.push(this.theme.fg("dim", this.subtitle));
		}
		// Keep standard dialog breathing room before choices.
		lines.push("");
		lines.push(
			(this.selectedIndex === 0 ? this.theme.fg("accent", "→ ") : "  ") +
			this.theme.fg(this.selectedIndex === 0 ? "accent" : "text", "Yes"),
		);
		lines.push(
			(this.selectedIndex === 1 ? this.theme.fg("accent", "→ ") : "  ") +
			this.theme.fg(this.selectedIndex === 1 ? "accent" : "text", "No"),
		);
		// Keep one spacer above shortcuts, but no spacer between shortcuts and blue line.
		lines.push("");
		lines.push(this.theme.fg("dim", `↑↓ navigate • enter select • esc ${this.cancelLabel}`));
		lines.push(border);
		return lines;
	}

	override invalidate(): void {}
}

class TodoDetailOverlayComponent {
	private todo: TodoRecord;
	private theme: Theme;
	private tui: TUI;
	private markdown: Markdown;
	private scrollOffset = 0;
	private viewHeight = 0;
	private totalLines = 0;
	private onAction: (action: TodoOverlayAction) => void;
	private keybindings: KeybindingMatcher;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingMatcher,
		todo: TodoRecord,
		onAction: (action: TodoOverlayAction) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.todo = todo;
		this.onAction = onAction;
		this.markdown = new Markdown(this.getMarkdownText(), 0, 0, getMarkdownTheme());
	}

	private getMarkdownText(): string {
		const body = this.todo.body?.trim();
		return body ? body : "_No details yet._";
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onAction("back");
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			this.scrollBy(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.scrollBy(1);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageUp") || matchesKey(keyData, Key.left)) {
			this.scrollBy(-this.viewHeight || -1);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageDown") || matchesKey(keyData, Key.right)) {
			this.scrollBy(this.viewHeight || 1);
			return;
		}
	}

	render(width: number): string[] {
		const maxHeight = this.getMaxHeight();
		const headerLines = 2;
		const footerLines = 1;
		const separatorLines = 2;
		const borderLines = 2;
		const innerWidth = Math.max(10, width - 2);
		const contentHeight = Math.max(1, maxHeight - headerLines - footerLines - separatorLines - borderLines);

		let markdownWidth = Math.max(1, innerWidth - 2);
		let markdownLines = this.markdown.render(markdownWidth);
		let hasScrollableContent = markdownLines.length > contentHeight;
		if (hasScrollableContent) {
			// Reserve one column for the right-hand scrollbar track/thumb.
			markdownWidth = Math.max(1, innerWidth - 3);
			markdownLines = this.markdown.render(markdownWidth);
			hasScrollableContent = markdownLines.length > contentHeight;
		}

		this.totalLines = markdownLines.length;
		this.viewHeight = contentHeight;
		const maxScroll = Math.max(0, this.totalLines - contentHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visibleLines = markdownLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);

		const borderColor = (text: string) => this.theme.fg("dim", text);
		const boxLine = (content: string): string => {
			const truncated = truncateToWidth(content, innerWidth);
			const padding = Math.max(0, innerWidth - visibleWidth(truncated));
			return borderColor("│") + truncated + " ".repeat(padding) + borderColor("│");
		};
		const contentBoxLine = (content: string, rowIndex: number): string => {
			if (!hasScrollableContent) return boxLine(content);
			const contentWidth = Math.max(1, innerWidth - 1);
			const truncated = truncateToWidth(content, contentWidth);
			const padding = Math.max(0, contentWidth - visibleWidth(truncated));
			const scrollIndicator = this.getScrollIndicatorForRow(rowIndex, contentHeight);
			return borderColor("│") + truncated + " ".repeat(padding) + scrollIndicator + borderColor("│");
		};
		const separator = (): string => borderColor(`├${"─".repeat(innerWidth)}┤`);

		const output: string[] = [];

		// Top border (rounded)
		output.push(borderColor(`╭${"─".repeat(innerWidth)}╮`));

		// Title: TODO-id • title
		const titleLine = cyanTodoId(this.todo.id) +
			this.theme.fg("muted", " • ") +
			this.theme.fg("text", this.todo.title || "(untitled)");
		output.push(boxLine(`  ${truncateToWidth(titleLine, innerWidth - 2)}`));

		// Subtitle: status • tags
		const status = this.todo.status || "open";
		const statusColor = isTodoClosed(status) ? "dim" : "success";
		const tagText = this.todo.tags.length ? this.todo.tags.join(", ") : "no tags";
		const subtitleLine = this.theme.fg(statusColor, status) +
			this.theme.fg("muted", " • ") +
			this.theme.fg("muted", tagText);
		output.push(boxLine(`  ${truncateToWidth(subtitleLine, innerWidth - 2)}`));

		// Separator
		output.push(separator());

		// Content
		const lineContentWidth = hasScrollableContent ? Math.max(1, innerWidth - 3) : Math.max(1, innerWidth - 2);
		for (let i = 0; i < contentHeight; i++) {
			const line = visibleLines[i] ?? "";
			output.push(contentBoxLine(`  ${truncateToWidth(line, lineContentWidth)}`, i));
		}

		// Separator before footer
		output.push(separator());

		// Footer shortcuts
		output.push(boxLine(`  ${this.buildActionLine(innerWidth - 3)}`));

		// Bottom border (rounded)
		output.push(borderColor(`╰${"─".repeat(innerWidth)}╯`));

		return output.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.markdown = new Markdown(this.getMarkdownText(), 0, 0, getMarkdownTheme());
	}

	private getMaxHeight(): number {
		const rows = this.tui.terminal.rows || 24;
		return Math.max(10, Math.floor(rows * 0.5));
	}

	private buildTitleLine(width: number): string {
		const titleText = this.todo.title
			? ` ${this.todo.title} `
			: ` Todo ${formatTodoId(this.todo.id)} `;
		const titleWidth = visibleWidth(titleText);
		if (titleWidth >= width) {
			return truncateToWidth(this.theme.fg("accent", titleText.trim()), width);
		}
		const leftWidth = Math.max(0, Math.floor((width - titleWidth) / 2));
		const rightWidth = Math.max(0, width - titleWidth - leftWidth);
		return (
			this.theme.fg("border", "─".repeat(leftWidth)) +
			this.theme.fg("accent", titleText) +
			this.theme.fg("border", "─".repeat(rightWidth))
		);
	}

	private buildMetaLine(width: number): string {
		const status = this.todo.status || "open";
		const statusColor = isTodoClosed(status) ? "dim" : "success";
		const tagText = this.todo.tags.length ? this.todo.tags.join(", ") : "no tags";
		const line =
			cyanTodoId(this.todo.id) +
			this.theme.fg("muted", " • ") +
			this.theme.fg(statusColor, status) +
			this.theme.fg("muted", " • ") +
			this.theme.fg("muted", tagText);
		return truncateToWidth(line, width);
	}

	private buildActionLine(width: number): string {
		const nav = this.theme.fg("dim", "↑↓ navigate");
		const pages = this.theme.fg("dim", "←→ pages");
		const back = this.theme.fg("dim", "esc back");
		const line = [nav, pages, back].join(this.theme.fg("muted", " • "));
		return truncateToWidth(line, width);
	}

	private getScrollIndicatorForRow(rowIndex: number, trackHeight: number): string {
		if (this.totalLines <= this.viewHeight || trackHeight <= 0) {
			return " ";
		}
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
	}
}

function getAgentTodosDir(): string {
	const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
	return path.join(home, ".pi", "agent", AGENT_TODO_DIR_NAME);
}

function getTodosDir(cwd: string): string {
	const overridePath = process.env[TODO_PATH_ENV];
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	const settings = readTodoSettingsSync(getAgentTodosDir());
	return settings.saveTodosInCurrentWorkingDirectory
		? path.resolve(cwd, TODO_DIR_NAME)
		: getAgentTodosDir();
}

function getTodosDirLabel(cwd: string): string {
	const overridePath = process.env[TODO_PATH_ENV];
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	const settings = readTodoSettingsSync(getAgentTodosDir());
	return settings.saveTodosInCurrentWorkingDirectory ? TODO_DIR_NAME : getAgentTodosDir();
}

function getAgentSettingsPath(): string {
	return path.join(getAgentTodosDir(), "..", "settings.json");
}

type RawTodoSettings = Partial<TodoSettings> & Record<string, any>;

function normalizeTodoSettings(raw: RawTodoSettings): TodoSettings {
	const maxVisibleTodosInWidget = Number.isFinite(raw.maxVisibleTodosInWidget)
		? raw.maxVisibleTodosInWidget
		: Number.isFinite(raw.widgetMaxVisible)
			? raw.widgetMaxVisible
			: DEFAULT_TODO_SETTINGS.maxVisibleTodosInWidget;
	const widgetSortOrder = raw.widgetSortOrder === "id" || raw.widgetSortOrder === "time"
		? raw.widgetSortOrder
		: DEFAULT_TODO_SETTINGS.widgetSortOrder;
	return {
		saveTodosInCurrentWorkingDirectory: Boolean(raw.saveTodosInCurrentWorkingDirectory ?? raw.saveInPwdDirectory ?? DEFAULT_TODO_SETTINGS.saveTodosInCurrentWorkingDirectory),
		maxVisibleTodosInWidget: Math.max(1, Math.min(100, Math.floor(maxVisibleTodosInWidget))),
		widgetSortOrder,
	};
}

function readGlobalSettingsSync(): Record<string, any> {
	try {
		return JSON.parse(readFileSync(getAgentSettingsPath(), "utf8")) as Record<string, any>;
	} catch {
		return {};
	}
}

async function readGlobalSettings(): Promise<Record<string, any>> {
	try {
		return JSON.parse(await fs.readFile(getAgentSettingsPath(), "utf8")) as Record<string, any>;
	} catch {
		return {};
	}
}

async function readTodoSettings(_todosDir: string): Promise<TodoSettings> {
	const settings = await readGlobalSettings();
	return normalizeTodoSettings((settings.todos ?? {}) as RawTodoSettings);
}

function readTodoSettingsSync(_todosDir: string): TodoSettings {
	const settings = readGlobalSettingsSync();
	return normalizeTodoSettings((settings.todos ?? {}) as RawTodoSettings);
}

async function writeTodoSettings(_todosDir: string, settings: TodoSettings): Promise<void> {
	const settingsPath = getAgentSettingsPath();
	const rootSettings = await readGlobalSettings();
	rootSettings.todos = normalizeTodoSettings(settings as RawTodoSettings);
	await fs.mkdir(path.dirname(settingsPath), { recursive: true });
	await fs.writeFile(settingsPath, JSON.stringify(rootSettings, null, 2) + "\n", "utf8");
}

function getTodoPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.md`);
}

function getLockPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.lock`);
}

function parseFrontMatter(text: string, idFallback: string): TodoFrontMatter {
	const data: TodoFrontMatter = {
		id: idFallback,
		title: "",
		tags: [],
		status: "open",
		created_at: "",
		assigned_to_session: undefined,
	};

	const trimmed = text.trim();
	if (!trimmed) return data;

	try {
		const parsed = JSON.parse(trimmed) as Partial<TodoFrontMatter> | null;
		if (!parsed || typeof parsed !== "object") return data;
		if (typeof parsed.id === "string" && parsed.id) data.id = parsed.id;
		if (typeof parsed.title === "string") data.title = parsed.title;
		if (typeof parsed.status === "string" && parsed.status) data.status = parsed.status;
		if (typeof parsed.created_at === "string") data.created_at = parsed.created_at;
		if (typeof parsed.assigned_to_session === "string" && parsed.assigned_to_session.trim()) {
			data.assigned_to_session = parsed.assigned_to_session;
		}
		if (Array.isArray(parsed.tags)) {
			data.tags = parsed.tags.filter((tag): tag is string => typeof tag === "string");
		}
	} catch {
		return data;
	}

	return data;
}

function findJsonObjectEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < content.length; i += 1) {
		const char = content[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === "\"") {
				inString = false;
			}
			continue;
		}

		if (char === "\"") {
			inString = true;
			continue;
		}

		if (char === "{") {
			depth += 1;
			continue;
		}

		if (char === "}") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}

	return -1;
}

function splitFrontMatter(content: string): { frontMatter: string; body: string } {
	if (!content.startsWith("{")) {
		return { frontMatter: "", body: content };
	}

	const endIndex = findJsonObjectEnd(content);
	if (endIndex === -1) {
		return { frontMatter: "", body: content };
	}

	const frontMatter = content.slice(0, endIndex + 1);
	const body = content.slice(endIndex + 1).replace(/^\r?\n+/, "");
	return { frontMatter, body };
}

function parseTodoContent(content: string, idFallback: string): TodoRecord {
	const { frontMatter, body } = splitFrontMatter(content);
	const parsed = parseFrontMatter(frontMatter, idFallback);
	return {
		id: idFallback,
		title: parsed.title,
		tags: parsed.tags ?? [],
		status: parsed.status,
		created_at: parsed.created_at,
		assigned_to_session: parsed.assigned_to_session,
		body: body ?? "",
	};
}

function serializeTodo(todo: TodoRecord): string {
	const frontMatter = JSON.stringify(
		{
			id: todo.id,
			title: todo.title,
			tags: todo.tags ?? [],
			status: todo.status,
			created_at: todo.created_at,
			assigned_to_session: todo.assigned_to_session || undefined,
		},
		null,
		2,
	);

	const body = todo.body ?? "";
	const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
	if (!trimmedBody) return `${frontMatter}\n`;
	return `${frontMatter}\n\n${trimmedBody}\n`;
}

async function ensureTodosDir(todosDir: string) {
	await fs.mkdir(todosDir, { recursive: true });
}

async function readTodoFile(filePath: string, idFallback: string): Promise<TodoRecord> {
	const content = await fs.readFile(filePath, "utf8");
	return parseTodoContent(content, idFallback);
}

async function writeTodoFile(filePath: string, todo: TodoRecord) {
	await fs.writeFile(filePath, serializeTodo(todo), "utf8");
}

async function generateTodoId(todosDir: string): Promise<string> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const id = crypto.randomBytes(4).toString("hex");
		const todoPath = getTodoPath(todosDir, id);
		if (!existsSync(todoPath)) return id;
	}
	throw new Error("Failed to generate unique todo id");
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const raw = await fs.readFile(lockPath, "utf8");
		return JSON.parse(raw) as LockInfo;
	} catch {
		return null;
	}
}

async function acquireLock(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
): Promise<(() => Promise<void>) | { error: string }> {
	const lockPath = getLockPath(todosDir, id);
	const now = Date.now();
	const session = ctx.sessionManager.getSessionFile();

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await fs.open(lockPath, "wx");
			const info: LockInfo = {
				id,
				pid: process.pid,
				session,
				created_at: new Date(now).toISOString(),
			};
			await handle.writeFile(JSON.stringify(info, null, 2), "utf8");
			await handle.close();
			return async () => {
				try {
					await fs.unlink(lockPath);
				} catch {
					// ignore
				}
			};
		} catch (error: any) {
			if (error?.code !== "EEXIST") {
				return { error: `Failed to acquire lock: ${error?.message ?? "unknown error"}` };
			}
			const stats = await fs.stat(lockPath).catch(() => null);
			const lockAge = stats ? now - stats.mtimeMs : LOCK_TTL_MS + 1;
			if (lockAge <= LOCK_TTL_MS) {
				const info = await readLockInfo(lockPath);
				const owner = info?.session ? ` (session ${info.session})` : "";
				return { error: `Todo ${displayTodoId(id)} is locked${owner}. Try again later.` };
			}
			if (!ctx.hasUI) {
				return { error: `Todo ${displayTodoId(id)} lock is stale; rerun in interactive mode to steal it.` };
			}
			const ok = await ctx.ui.confirm(
				"Todo locked",
				`Todo ${displayTodoId(id)} appears locked. Steal the lock?`,
			);
			if (!ok) {
				return { error: `Todo ${displayTodoId(id)} remains locked.` };
			}
			await fs.unlink(lockPath).catch(() => undefined);
		}
	}

	return { error: `Failed to acquire lock for todo ${displayTodoId(id)}.` };
}

async function withTodoLock<T>(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	fn: () => Promise<T>,
): Promise<T | { error: string }> {
	const lock = await acquireLock(todosDir, id, ctx);
	if (typeof lock === "object" && "error" in lock) return lock;
	try {
		return await fn();
	} finally {
		await lock();
	}
}

async function listTodos(todosDir: string): Promise<TodoFrontMatter[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(todosDir);
	} catch {
		return [];
	}

	const todos: TodoFrontMatter[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const id = entry.slice(0, -3);
		const filePath = path.join(todosDir, entry);
		try {
			const content = await fs.readFile(filePath, "utf8");
			const { frontMatter } = splitFrontMatter(content);
			const parsed = parseFrontMatter(frontMatter, id);
			todos.push({
				id,
				title: parsed.title,
				tags: parsed.tags ?? [],
				status: parsed.status,
				created_at: parsed.created_at,
				assigned_to_session: parsed.assigned_to_session,
			});
		} catch {
			// ignore unreadable todo
		}
	}

	return sortTodos(todos);
}

function listTodosSync(todosDir: string): TodoFrontMatter[] {
	let entries: string[] = [];
	try {
		entries = readdirSync(todosDir);
	} catch {
		return [];
	}

	const todos: TodoFrontMatter[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const id = entry.slice(0, -3);
		const filePath = path.join(todosDir, entry);
		try {
			const content = readFileSync(filePath, "utf8");
			const { frontMatter } = splitFrontMatter(content);
			const parsed = parseFrontMatter(frontMatter, id);
			todos.push({
				id,
				title: parsed.title,
				tags: parsed.tags ?? [],
				status: parsed.status,
				created_at: parsed.created_at,
				assigned_to_session: parsed.assigned_to_session,
			});
		} catch {
			// ignore
		}
	}

	return sortTodos(todos);
}

function getTodoTitle(todo: TodoFrontMatter): string {
	return todo.title || "(untitled)";
}

function getTodoStatus(todo: TodoFrontMatter): string {
	return todo.status || "open";
}

function formatAssignmentSuffix(todo: TodoFrontMatter): string {
	return todo.assigned_to_session ? ` (assigned: ${todo.assigned_to_session})` : "";
}

function renderAssignmentSuffix(
	theme: Theme,
	todo: TodoFrontMatter,
	currentSessionId?: string,
): string {
	if (!todo.assigned_to_session) return "";
	const isCurrent = todo.assigned_to_session === currentSessionId;
	if (isCurrent) {
		return theme.fg("success", " (current)");
	}
	return theme.fg("accent", ` (${todo.assigned_to_session})`);
}

function formatTodoHeading(todo: TodoFrontMatter): string {
	const tagText = todo.tags.length ? ` [${todo.tags.join(", ")}]` : "";
	return `${formatTodoId(todo.id)} ${getTodoTitle(todo)}${tagText}${formatAssignmentSuffix(todo)}`;
}

function buildRefinePrompt(todoId: string, title: string): string {
	return (
		`let's refine task ${formatTodoId(todoId)} "${title}": ` +
		"Ask me for the missing details needed to refine the todo together. Do not rewrite the todo yet and do not make assumptions. " +
		"Ask clear, concrete questions and wait for my answers before drafting any structured description.\n"
	);
}

function extractTodoIdsFromText(text: unknown): string[] {
	if (typeof text !== "string") return [];
	const ids = new Set<string>();
	const todoIdPattern = /TODO-([0-9a-fA-F]+)/g;
	let match: RegExpExecArray | null;
	while ((match = todoIdPattern.exec(text)) !== null) {
		ids.add(match[1]!.toLowerCase());
	}
	return [...ids];
}

function isSuccessfulCompletedSubagentResult(result: any): boolean {
	if (!result || typeof result !== "object") return false;
	const status = result.progress?.status;
	// During streaming, running snapshots can still have the default exitCode 0.
	// Only close todos once the child result itself is terminal and successful.
	if (status && status !== "completed") return false;
	return result.exitCode === 0 && !result.error && !result.timedOut && !result.detached && !result.interrupted && !result.resourceLimitExceeded;
}

async function closeTodosForCompletedSubagentResults(details: any, ctx: ExtensionContext): Promise<boolean> {
	const results = Array.isArray(details?.results) ? details.results : [];
	const foundIds = new Set<string>();
	for (const result of results) {
		if (!isSuccessfulCompletedSubagentResult(result)) continue;
		for (const id of extractTodoIdsFromText(result.task)) {
			foundIds.add(id);
		}
	}
	if (foundIds.size === 0) return false;

	const todosDir = getTodosDir(ctx.cwd);
	let changed = false;
	for (const id of foundIds) {
		const filePath = getTodoPath(todosDir, id);
		if (!existsSync(filePath)) continue;
		const result = await withTodoLock(todosDir, id, ctx, async () => {
			const existing = await ensureTodoExists(filePath, id);
			if (!existing || isTodoClosed(existing.status)) return false;
			existing.status = "done";
			existing.assigned_to_session = undefined;
			await writeTodoFile(filePath, existing);
			return true;
		});
		if (result === true) changed = true;
	}
	return changed;
}

function splitTodosByAssignment(todos: TodoFrontMatter[]): {
	assignedTodos: TodoFrontMatter[];
	openTodos: TodoFrontMatter[];
	closedTodos: TodoFrontMatter[];
} {
	const assignedTodos: TodoFrontMatter[] = [];
	const openTodos: TodoFrontMatter[] = [];
	const closedTodos: TodoFrontMatter[] = [];
	for (const todo of todos) {
		if (isTodoClosed(getTodoStatus(todo))) {
			closedTodos.push(todo);
			continue;
		}
		if (todo.assigned_to_session) {
			assignedTodos.push(todo);
		} else {
			openTodos.push(todo);
		}
	}
	return { assignedTodos, openTodos, closedTodos };
}

function formatTodoList(todos: TodoFrontMatter[]): string {
	if (!todos.length) return "No todos.";

	const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
	const lines: string[] = [];
	const pushSection = (label: string, sectionTodos: TodoFrontMatter[]) => {
		lines.push(`${label} (${sectionTodos.length}):`);
		if (!sectionTodos.length) {
			lines.push("  none");
			return;
		}
		for (const todo of sectionTodos) {
			lines.push(`  ${formatTodoHeading(todo)}`);
		}
	};

	pushSection("Assigned todos", assignedTodos);
	pushSection("Open todos", openTodos);
	pushSection("Closed todos", closedTodos);
	return lines.join("\n");
}

function serializeTodoForAgent(todo: TodoRecord): string {
	const payload = { ...todo, id: formatTodoId(todo.id) };
	return JSON.stringify(payload, null, 2);
}

function serializeTodoListForAgent(todos: TodoFrontMatter[]): string {
	const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
	const mapTodo = (todo: TodoFrontMatter) => ({ ...todo, id: formatTodoId(todo.id) });
	return JSON.stringify(
		{
			assigned: assignedTodos.map(mapTodo),
			open: openTodos.map(mapTodo),
			closed: closedTodos.map(mapTodo),
		},
		null,
		2,
	);
}

function renderTodoHeading(theme: Theme, todo: TodoFrontMatter, currentSessionId?: string): string {
	const closed = isTodoClosed(getTodoStatus(todo));
	const titleColor = closed ? "dim" : "text";
	const tagText = todo.tags.length ? theme.fg("dim", ` [${todo.tags.join(", ")}]`) : "";
	const assignmentText = renderAssignmentSuffix(theme, todo, currentSessionId);
	return (
		cyanTodoId(todo.id) +
		" " +
		theme.fg(titleColor, getTodoTitle(todo)) +
		tagText +
		assignmentText
	);
}

function renderTodoList(
	theme: Theme,
	todos: TodoFrontMatter[],
	expanded: boolean,
	currentSessionId?: string,
): string {
	if (!todos.length) return theme.fg("dim", "No todos");

	const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
	const lines: string[] = [];
	const pushSection = (label: string, sectionTodos: TodoFrontMatter[]) => {
		lines.push(theme.fg("muted", `${label} (${sectionTodos.length})`));
		if (!sectionTodos.length) {
			lines.push(theme.fg("dim", "  none"));
			return;
		}
		const maxItems = expanded ? sectionTodos.length : Math.min(sectionTodos.length, 3);
		for (let i = 0; i < maxItems; i++) {
			lines.push(`  ${renderTodoHeading(theme, sectionTodos[i], currentSessionId)}`);
		}
		if (!expanded && sectionTodos.length > maxItems) {
			lines.push(theme.fg("dim", `  ... ${sectionTodos.length - maxItems} more`));
		}
	};

	const sections: Array<{ label: string; todos: TodoFrontMatter[] }> = [
		{ label: "Assigned todos", todos: assignedTodos },
		{ label: "Open todos", todos: openTodos },
		{ label: "Closed todos", todos: closedTodos },
	];

	sections.forEach((section, index) => {
		if (index > 0) lines.push("");
		pushSection(section.label, section.todos);
	});

	return lines.join("\n");
}

function renderTodoDetail(theme: Theme, todo: TodoRecord, expanded: boolean): string {
	const summary = renderTodoHeading(theme, todo);
	if (!expanded) return summary;

	const tags = todo.tags.length ? todo.tags.join(", ") : "none";
	const createdAt = todo.created_at || "unknown";
	const bodyText = todo.body?.trim() ? todo.body.trim() : "No details yet.";
	const bodyLines = bodyText.split("\n");

	const lines = [
		summary,
		theme.fg("muted", `Status: ${getTodoStatus(todo)}`),
		theme.fg("muted", `Tags: ${tags}`),
		theme.fg("muted", `Created: ${createdAt}`),
		"",
		theme.fg("muted", "Body:"),
		...bodyLines.map((line) => theme.fg("text", `  ${line}`)),
	];

	return lines.join("\n");
}

function appendExpandHint(theme: Theme, text: string): string {
	return `${text}\n${theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`)}`;
}

async function ensureTodoExists(filePath: string, id: string): Promise<TodoRecord | null> {
	if (!existsSync(filePath)) return null;
	return readTodoFile(filePath, id);
}

async function appendTodoBody(filePath: string, todo: TodoRecord, text: string): Promise<TodoRecord> {
	const spacer = todo.body.trim().length ? "\n\n" : "";
	todo.body = `${todo.body.replace(/\s+$/, "")}${spacer}${text.trim()}\n`;
	await writeTodoFile(filePath, todo);
	return todo;
}

async function deleteAllTodos(todosDir: string, ctx: ExtensionContext): Promise<number | { error: string }> {
	const todos = await listTodos(todosDir);
	let deleted = 0;
	for (const todo of todos) {
		const result = await deleteTodo(todosDir, todo.id, ctx);
		if ("error" in result) return { error: result.error };
		deleted++;
	}
	return deleted;
}

async function updateTodoStatus(
	todosDir: string,
	id: string,
	status: string,
	ctx: ExtensionContext,
): Promise<TodoRecord | { error: string }> {
	const validated = validateTodoId(id);
	if ("error" in validated) {
		return { error: validated.error };
	}
	const normalizedId = validated.id;
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) {
		return { error: `Todo ${displayTodoId(id)} not found` };
	}

	const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
		existing.status = status;
		clearAssignmentIfClosed(existing);
		await writeTodoFile(filePath, existing);
		return existing;
	});

	if (typeof result === "object" && "error" in result) {
		return { error: result.error };
	}

	return result;
}

async function claimTodoAssignment(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	force = false,
): Promise<TodoRecord | { error: string }> {
	const validated = validateTodoId(id);
	if ("error" in validated) {
		return { error: validated.error };
	}
	const normalizedId = validated.id;
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) {
		return { error: `Todo ${displayTodoId(id)} not found` };
	}
	const sessionId = ctx.sessionManager.getSessionId();
	const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
		if (isTodoClosed(existing.status)) {
			return { error: `Todo ${displayTodoId(id)} is closed` } as const;
		}
		const assigned = existing.assigned_to_session;
		if (assigned && assigned !== sessionId && !force) {
			return {
				error: `Todo ${displayTodoId(id)} is already assigned to session ${assigned}. Use force to override.`,
			} as const;
		}
		if (assigned !== sessionId) {
			existing.assigned_to_session = sessionId;
			await writeTodoFile(filePath, existing);
		}
		return existing;
	});

	if (typeof result === "object" && "error" in result) {
		return { error: result.error };
	}

	return result;
}

async function releaseTodoAssignment(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	force = false,
): Promise<TodoRecord | { error: string }> {
	const validated = validateTodoId(id);
	if ("error" in validated) {
		return { error: validated.error };
	}
	const normalizedId = validated.id;
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) {
		return { error: `Todo ${displayTodoId(id)} not found` };
	}
	const sessionId = ctx.sessionManager.getSessionId();
	const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
		const assigned = existing.assigned_to_session;
		if (!assigned) {
			return existing;
		}
		if (assigned !== sessionId && !force) {
			return {
				error: `Todo ${displayTodoId(id)} is assigned to session ${assigned}. Use force to release.`,
			} as const;
		}
		existing.assigned_to_session = undefined;
		await writeTodoFile(filePath, existing);
		return existing;
	});

	if (typeof result === "object" && "error" in result) {
		return { error: result.error };
	}

	return result;
}

async function deleteTodo(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
): Promise<TodoRecord | { error: string }> {
	const validated = validateTodoId(id);
	if ("error" in validated) {
		return { error: validated.error };
	}
	const normalizedId = validated.id;
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) {
		return { error: `Todo ${displayTodoId(id)} not found` };
	}

	const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
		await fs.unlink(filePath);
		return existing;
	});

	if (typeof result === "object" && "error" in result) {
		return { error: result.error };
	}

	return result;
}

function renderTodoWidgetLines(theme: Theme, todos: TodoFrontMatter[], currentSessionId: string | undefined, settings: TodoSettings): string[] {
	const { assignedTodos, openTodos } = splitTodosByAssignment(todos);
	const activeTodos = [...assignedTodos, ...openTodos];
	if (activeTodos.length === 0) return [];

	const sortedTodos = [...activeTodos].sort((a, b) => {
		if (settings.widgetSortOrder === "id") return a.id.localeCompare(b.id);
		return (a.created_at || "").localeCompare(b.created_at || "");
	});

	const lines: string[] = [];

	// Header line with counts
	const parts: string[] = [];
	if (assignedTodos.length > 0) parts.push(`${assignedTodos.length} assigned`);
	if (openTodos.length > 0) parts.push(`${openTodos.length} open`);
	const statusText = `${sortedTodos.length} todos (${parts.join(", ")})`;
	lines.push(theme.fg("accent", "●") + " " + theme.fg("accent", statusText));

	// Individual todo lines
	const visible = sortedTodos.slice(0, settings.maxVisibleTodosInWidget);
	for (const todo of visible) {
		const isAssignedToMe = todo.assigned_to_session === currentSessionId;
		let icon: string;
		if (isTodoClosed(todo.status)) {
			icon = theme.fg("success", "✓");
		} else if (todo.assigned_to_session) {
			icon = theme.fg("accent", "◼");
		} else {
			icon = "◻";
		}

		const closed = isTodoClosed(todo.status);
		const title = todo.title || "(untitled)";
		const idStr = closed
			? theme.fg("dim", "\x1b[9m#" + todo.id + "\x1b[29m")
			: theme.fg("dim", "#" + todo.id);
		const titleStr = title;
		let suffix = "";
		if (isAssignedToMe) {
			suffix = theme.fg("success", " (current)");
		} else if (todo.assigned_to_session) {
			suffix = theme.fg("accent", ` (${todo.assigned_to_session})`);
		}
		lines.push(`  ${icon} ${idStr} ${titleStr}${suffix}`);
	}

	const hiddenCount = sortedTodos.length - visible.length;
	if (hiddenCount > 0) {
		lines.push(theme.fg("dim", `    … and ${hiddenCount} more`));
	}

	return lines;
}

function updateTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const todosDir = getTodosDir(ctx.cwd);
	const todos = listTodosSync(todosDir);
	const settings = readTodoSettingsSync(todosDir);
	const currentSessionId = ctx.sessionManager.getSessionId();
	const theme = ctx.ui.theme;
	const lines = renderTodoWidgetLines(theme, todos, currentSessionId, settings);

	if (lines.length === 0) {
		ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
	} else {
		ctx.ui.setWidget(TODO_WIDGET_KEY, lines, { placement: "aboveEditor" });
	}
}

export default function todosExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const todosDir = getTodosDir(ctx.cwd);
		await ensureTodosDir(todosDir);
		updateTodoWidget(ctx);
	});

	// Refresh widget after any todo tool execution.
	// For subagents, close only TODOs whose corresponding child result is terminal and successful.
	// Do not close all TODO IDs mentioned in the original subagent input: at tool-call time they
	// are merely assigned, and parallel/failing runs can include children that have not completed.
	pi.on("tool_result", async (event: any, ctx) => {
		if (event.toolName === "todo") {
			updateTodoWidget(ctx);
		}
		if (event.toolName === "subagent") {
			const changed = await closeTodosForCompletedSubagentResults(event.details, ctx);
			if (changed) updateTodoWidget(ctx);
		}
	});

	pi.on("tool_execution_update", async (event: any, ctx) => {
		if (event.toolName !== "subagent") return;
		const changed = await closeTodosForCompletedSubagentResults(event.partialResult?.details, ctx);
		if (changed) updateTodoWidget(ctx);
	});

	// Auto-claim todos when subagent tasks reference them
	pi.on("tool_call", async (event: any, ctx) => {
		if (event.toolName !== "subagent") return;
		const input = event.input ?? {};
		// Collect {agent, task} pairs from single, parallel, or chain invocations
		const agentTasks: { agent: string; task: string }[] = [];
		if (input.task && input.agent) {
			agentTasks.push({ agent: input.agent, task: input.task });
		}
		if (Array.isArray(input.tasks)) {
			for (const t of input.tasks) {
				if (t?.task && t?.agent) agentTasks.push({ agent: t.agent, task: t.task });
			}
		}
		if (Array.isArray(input.chain)) {
			for (const step of input.chain) {
				if (step?.task && step?.agent) agentTasks.push({ agent: step.agent, task: step.task });
				if (Array.isArray(step?.parallel)) {
					for (const p of step.parallel) {
						if (p?.task && p?.agent) agentTasks.push({ agent: p.agent, task: p.task });
					}
				}
			}
		}
		// Map TODO IDs to agent names
		const todoIdPattern = /TODO-([0-9a-fA-F]+)/g;
		const todoAgentMap = new Map<string, string>();
		for (const { agent, task } of agentTasks) {
			let match;
			while ((match = todoIdPattern.exec(task)) !== null) {
				todoAgentMap.set(match[1]!.toLowerCase(), agent);
			}
			todoIdPattern.lastIndex = 0;
		}
		if (todoAgentMap.size === 0) return;
		// Assign each referenced todo to its agent name
		const todosDir = getTodosDir(ctx.cwd);
		for (const [id, agentName] of todoAgentMap) {
			const filePath = getTodoPath(todosDir, id);
			if (!existsSync(filePath)) continue;
			await withTodoLock(todosDir, id, ctx, async () => {
				const existing = await ensureTodoExists(filePath, id);
				if (!existing || isTodoClosed(existing.status)) return;
				existing.assigned_to_session = agentName;
				await writeTodoFile(filePath, existing);
			});
		}
		updateTodoWidget(ctx);
	});

	const todosDirLabel = getTodosDirLabel(process.cwd());

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			`Manage file-based todos in ${todosDirLabel} (list, list-all, get, create, update, append, delete, claim, release). ` +
			"Title is the short summary; body is long-form markdown notes (update replaces, append adds). " +
			"Todo ids are shown as TODO-<hex>; id parameters accept TODO-<hex> or the raw hex filename. " +
			"Claim tasks before working on them to avoid conflicts, and close them when complete.", 
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const todosDir = getTodosDir(ctx.cwd);
			const action: TodoAction = params.action;

			switch (action) {
				case "list": {
					const todos = await listTodos(todosDir);
					const { assignedTodos, openTodos } = splitTodosByAssignment(todos);
					const listedTodos = [...assignedTodos, ...openTodos];
					const currentSessionId = ctx.sessionManager.getSessionId();
					return {
						content: [{ type: "text", text: serializeTodoListForAgent(listedTodos) }],
						details: { action: "list", todos: listedTodos, currentSessionId },
					};
				}

				case "list-all": {
					const todos = await listTodos(todosDir);
					const currentSessionId = ctx.sessionManager.getSessionId();
					return {
						content: [{ type: "text", text: serializeTodoListForAgent(todos) }],
						details: { action: "list-all", todos, currentSessionId },
					};
				}

				case "get": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { action: "get", error: "id required" },
						};
					}
					const validated = validateTodoId(params.id);
					if ("error" in validated) {
						return {
							content: [{ type: "text", text: validated.error }],
							details: { action: "get", error: validated.error },
						};
					}
					const normalizedId = validated.id;
					const displayId = formatTodoId(normalizedId);
					const filePath = getTodoPath(todosDir, normalizedId);
					const todo = await ensureTodoExists(filePath, normalizedId);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo ${displayId} not found` }],
							details: { action: "get", error: "not found" },
						};
					}
					return {
						content: [{ type: "text", text: serializeTodoForAgent(todo) }],
						details: { action: "get", todo },
					};
				}

				case "create": {
					if (!params.title) {
						return {
							content: [{ type: "text", text: "Error: title required" }],
							details: { action: "create", error: "title required" },
						};
					}
					await ensureTodosDir(todosDir);
					const id = await generateTodoId(todosDir);
					const filePath = getTodoPath(todosDir, id);
					const todo: TodoRecord = {
						id,
						title: params.title,
						tags: params.tags ?? [],
						status: params.status ?? "open",
						created_at: new Date().toISOString(),
						body: params.body ?? "",
					};

					const result = await withTodoLock(todosDir, id, ctx, async () => {
						await writeTodoFile(filePath, todo);
						return todo;
					});

					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { action: "create", error: result.error },
						};
					}

					return {
						content: [{ type: "text", text: serializeTodoForAgent(todo) }],
						details: { action: "create", todo },
					};
				}

				case "update": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { action: "update", error: "id required" },
						};
					}
					const validated = validateTodoId(params.id);
					if ("error" in validated) {
						return {
							content: [{ type: "text", text: validated.error }],
							details: { action: "update", error: validated.error },
						};
					}
					const normalizedId = validated.id;
					const displayId = formatTodoId(normalizedId);
					const filePath = getTodoPath(todosDir, normalizedId);
					if (!existsSync(filePath)) {
						return {
							content: [{ type: "text", text: `Todo ${displayId} not found` }],
							details: { action: "update", error: "not found" },
						};
					}
					const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
						const existing = await ensureTodoExists(filePath, normalizedId);
						if (!existing) return { error: `Todo ${displayId} not found` } as const;

						existing.id = normalizedId;
						if (params.title !== undefined) existing.title = params.title;
						if (params.status !== undefined) existing.status = params.status;
						if (params.tags !== undefined) existing.tags = params.tags;
						if (params.body !== undefined) existing.body = params.body;
						if (!existing.created_at) existing.created_at = new Date().toISOString();
						clearAssignmentIfClosed(existing);

						await writeTodoFile(filePath, existing);
						return existing;
					});

					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { action: "update", error: result.error },
						};
					}

					const updatedTodo = result as TodoRecord;
					return {
						content: [{ type: "text", text: serializeTodoForAgent(updatedTodo) }],
						details: { action: "update", todo: updatedTodo },
					};
				}

				case "append": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { action: "append", error: "id required" },
						};
					}
					const validated = validateTodoId(params.id);
					if ("error" in validated) {
						return {
							content: [{ type: "text", text: validated.error }],
							details: { action: "append", error: validated.error },
						};
					}
					const normalizedId = validated.id;
					const displayId = formatTodoId(normalizedId);
					const filePath = getTodoPath(todosDir, normalizedId);
					if (!existsSync(filePath)) {
						return {
							content: [{ type: "text", text: `Todo ${displayId} not found` }],
							details: { action: "append", error: "not found" },
						};
					}
					const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
						const existing = await ensureTodoExists(filePath, normalizedId);
						if (!existing) return { error: `Todo ${displayId} not found` } as const;
						if (!params.body || !params.body.trim()) {
							return existing;
						}
						const updated = await appendTodoBody(filePath, existing, params.body);
						return updated;
					});

					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { action: "append", error: result.error },
						};
					}

					const updatedTodo = result as TodoRecord;
					return {
						content: [{ type: "text", text: serializeTodoForAgent(updatedTodo) }],
						details: { action: "append", todo: updatedTodo },
					};
				}

				case "claim": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { action: "claim", error: "id required" },
						};
					}
					const result = await claimTodoAssignment(
						todosDir,
						params.id,
						ctx,
						Boolean(params.force),
					);
					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { action: "claim", error: result.error },
						};
					}
					const updatedTodo = result as TodoRecord;
					return {
						content: [{ type: "text", text: serializeTodoForAgent(updatedTodo) }],
						details: { action: "claim", todo: updatedTodo },
					};
				}

				case "release": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { action: "release", error: "id required" },
						};
					}
					const result = await releaseTodoAssignment(
						todosDir,
						params.id,
						ctx,
						Boolean(params.force),
					);
					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { action: "release", error: result.error },
						};
					}
					const updatedTodo = result as TodoRecord;
					return {
						content: [{ type: "text", text: serializeTodoForAgent(updatedTodo) }],
						details: { action: "release", todo: updatedTodo },
					};
				}

				case "delete": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { action: "delete", error: "id required" },
						};
					}

					const validated = validateTodoId(params.id);
					if ("error" in validated) {
						return {
							content: [{ type: "text", text: validated.error }],
							details: { action: "delete", error: validated.error },
						};
					}
					const result = await deleteTodo(todosDir, validated.id, ctx);
					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { action: "delete", error: result.error },
						};
					}

					return {
						content: [{ type: "text", text: serializeTodoForAgent(result as TodoRecord) }],
						details: { action: "delete", todo: result as TodoRecord },
					};
				}
			}
		},


		renderCall(args, theme) {
			const action = typeof args.action === "string" ? args.action : "";
			const id = typeof args.id === "string" ? args.id : "";
			const normalizedId = id ? normalizeTodoId(id) : "";
			const title = typeof args.title === "string" ? args.title : "";
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", action);
			if (normalizedId) {
				text += " " + cyanTodoId(normalizedId);
			}
			if (title) {
				text += " " + theme.fg("dim", `"${title}"`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as TodoToolDetails | undefined;
			if (isPartial) {
				return new Text(theme.fg("warning", "Processing..."), 0, 0);
			}
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (details.action === "list" || details.action === "list-all") {
				let text = renderTodoList(theme, details.todos, expanded, details.currentSessionId);
				if (!expanded) {
					const { closedTodos } = splitTodosByAssignment(details.todos);
					if (closedTodos.length) {
						text = appendExpandHint(theme, text);
					}
				}
				return new Text(text, 0, 0);
			}

			if (!("todo" in details)) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			let text = renderTodoDetail(theme, details.todo, expanded);
			const actionLabel =
				details.action === "create"
					? "Created"
					: details.action === "update"
						? "Updated"
						: details.action === "append"
							? "Appended to"
							: details.action === "delete"
								? "Deleted"
								: details.action === "claim"
									? "Claimed"
									: details.action === "release"
										? "Released"
										: null;
			if (actionLabel) {
				const lines = text.split("\n");
				lines[0] = theme.fg("success", "✓ ") + theme.fg("muted", `${actionLabel} `) + lines[0];
				text = lines.join("\n");
			}
			if (!expanded) {
				text = appendExpandHint(theme, text);
			}
			return new Text(text, 0, 0);
		},
	});

	const openTodosCommand = async (args: string | undefined, ctx: any) => {
		const todosDir = getTodosDir(ctx.cwd);
		let todos = await listTodos(todosDir);
		const currentSessionId = ctx.sessionManager.getSessionId();
		const searchTerm = (args ?? "").trim();

		if (!ctx.hasUI) {
			const text = formatTodoList(todos);
			console.log(text);
			return;
		}

		const homeAction = await ctx.ui.custom<TodoHomeAction>((_tui, theme, keybindings, done) =>
			new TodoHomeMenuComponent(
				theme,
				keybindings,
				(action) => done(action),
				() => done(),
			),
		);

		if (!homeAction) {
			updateTodoWidget(ctx);
			return;
		}

		if (homeAction === "clearAll") {
			const ok = await ctx.ui.custom<boolean>((_tui, theme, keybindings, done) =>
				new TodoDeleteConfirmComponent(
					theme,
					keybindings,
					"Delete all todos",
					(confirmed) => done(confirmed),
					{
						subtitle: `Delete ${todos.length} todos? This cannot be undone.`,
						cancelLabel: "cancel",
					},
				),
			);
			if (!ok) {
				await openTodosCommand(args, ctx);
				return;
			}
			const result = await deleteAllTodos(todosDir, ctx);
			if (typeof result === "object" && "error" in result) {
				ctx.ui.notify(result.error, "error");
				return;
			}
			ctx.ui.notify(`Deleted ${result} todos`, "info");
			updateTodoWidget(ctx);
			return;
		}

		if (homeAction === "settings") {
			const settings = await readTodoSettings(todosDir);
			await ctx.ui.custom<void>((_tui, theme, keybindings, done) =>
				new TodoSettingsMenuComponent(
					theme,
					keybindings,
					settings,
					(updatedSettings) => {
						void writeTodoSettings(todosDir, updatedSettings).then(() => updateTodoWidget(ctx));
					},
					() => done(),
				),
			);
			await openTodosCommand(args, ctx);
			return;
		}

		todos = await listTodos(todosDir);
		let nextPrompt: string | null = null;
		let rootTui: TUI | null = null;
		let goBackToHome = false;
		await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
				rootTui = tui;
				let selector: TodoSelectorComponent | null = null;
				let actionMenu: TodoActionMenuComponent | null = null;
				let deleteConfirm: TodoDeleteConfirmComponent | null = null;
				let activeComponent:
					| {
							render: (width: number) => string[];
							invalidate: () => void;
							handleInput?: (data: string) => void;
							focused?: boolean;
						}
					| null = null;
				let wrapperFocused = false;

				const setActiveComponent = (
					component:
						| {
								render: (width: number) => string[];
								invalidate: () => void;
								handleInput?: (data: string) => void;
								focused?: boolean;
							}
						| null,
				) => {
					if (activeComponent && "focused" in activeComponent) {
						activeComponent.focused = false;
					}
					activeComponent = component;
					if (activeComponent && "focused" in activeComponent) {
						activeComponent.focused = wrapperFocused;
					}
					tui.requestRender();
				};

				const copyTodoPathToClipboard = (todoId: string) => {
					const filePath = getTodoPath(todosDir, todoId);
					const absolutePath = path.resolve(filePath);
					try {
						copyToClipboard(absolutePath);
						ctx.ui.notify(`Copied ${absolutePath} to clipboard`, "info");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(message, "error");
					}
				};

				const copyTodoTextToClipboard = (record: TodoRecord) => {
					const title = record.title || "(untitled)";
					const body = record.body?.trim() || "";
					const text = body ? `# ${title}\n\n${body}` : `# ${title}`;
					try {
						copyToClipboard(text);
						ctx.ui.notify("Copied todo text to clipboard", "info");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(message, "error");
					}
				};

				const resolveTodoRecord = async (todo: TodoFrontMatter): Promise<TodoRecord | null> => {
					const filePath = getTodoPath(todosDir, todo.id);
					const record = await ensureTodoExists(filePath, todo.id);
					if (!record) {
						ctx.ui.notify(`Todo ${formatTodoId(todo.id)} not found`, "error");
						return null;
					}
					return record;
				};

				const applyTodoAction = async (
					record: TodoRecord,
					action: TodoMenuAction,
				): Promise<"stay" | "exit"> => {
					if (action === "refine") {
						const title = record.title || "(untitled)";
						nextPrompt = buildRefinePrompt(record.id, title);
						done();
						return "exit";
					}
					if (action === "work") {
						const title = record.title || "(untitled)";
						nextPrompt = `work on todo ${formatTodoId(record.id)} "${title}"`;
						done();
						return "exit";
					}
					if (action === "view") {
						return "stay";
					}
					if (action === "copyPath") {
						copyTodoPathToClipboard(record.id);
						return "stay";
					}
					if (action === "copyText") {
						copyTodoTextToClipboard(record);
						return "stay";
					}

					if (action === "release") {
						const result = await releaseTodoAssignment(todosDir, record.id, ctx, true);
						if ("error" in result) {
							ctx.ui.notify(result.error, "error");
							return "stay";
						}
						const updatedTodos = await listTodos(todosDir);
						selector?.setTodos(updatedTodos);
						ctx.ui.notify(`Released todo ${formatTodoId(record.id)}`, "info");
						return "stay";
					}

					if (action === "delete") {
						const result = await deleteTodo(todosDir, record.id, ctx);
						if ("error" in result) {
							ctx.ui.notify(result.error, "error");
							return "stay";
						}
						const updatedTodos = await listTodos(todosDir);
						selector?.setTodos(updatedTodos);
						updateTodoWidget(ctx);
						ctx.ui.notify(`Deleted todo ${formatTodoId(record.id)}`, "info");
						return "stay";
					}

					const nextStatus = action === "close" ? "closed" : "open";
					const result = await updateTodoStatus(todosDir, record.id, nextStatus, ctx);
					if ("error" in result) {
						ctx.ui.notify(result.error, "error");
						return "stay";
					}

					const updatedTodos = await listTodos(todosDir);
					selector?.setTodos(updatedTodos);
					updateTodoWidget(ctx);
					ctx.ui.notify(
						`${action === "close" ? "Closed" : "Reopened"} todo ${formatTodoId(record.id)}`,
						"info",
					);
					return "stay";
				};

				const handleActionSelection = async (record: TodoRecord, action: TodoMenuAction) => {
					if (action === "view") {
						setActiveComponent(
							new TodoDetailOverlayComponent(
								tui,
								theme,
								keybindings,
								record,
								() => {
									setActiveComponent(actionMenu);
								},
							),
						);
						return;
					}

					if (action === "delete") {
						const message = `Delete todo ${formatTodoId(record.id)}? This cannot be undone.`;
						deleteConfirm = new TodoDeleteConfirmComponent(
							theme,
							keybindings,
							"Delete Todo",
							(confirmed) => {
								if (!confirmed) {
									setActiveComponent(actionMenu);
									return;
								}
								void (async () => {
									await applyTodoAction(record, "delete");
									setActiveComponent(selector);
								})();
							},
							{ subtitle: message, cancelLabel: "back" },
						);
						setActiveComponent(deleteConfirm);
						return;
					}

					const result = await applyTodoAction(record, action);
					if (result === "stay") {
						setActiveComponent(selector);
					}
				};

				const showActionMenu = async (todo: TodoFrontMatter | TodoRecord) => {
					const record = "body" in todo ? todo : await resolveTodoRecord(todo);
					if (!record) return;
					actionMenu = new TodoActionMenuComponent(
						theme,
						record,
						(action) => {
							void handleActionSelection(record, action);
						},
						() => {
							setActiveComponent(selector);
						},
					);
					setActiveComponent(actionMenu);
				};

				const handleSelect = async (todo: TodoFrontMatter) => {
					await showActionMenu(todo);
				};

				selector = new TodoSelectorComponent(
					tui,
					theme,
					keybindings,
					todos,
					(todo) => {
						void handleSelect(todo);
					},
					() => {
						goBackToHome = true;
						done();
					},
					searchTerm || undefined,
					currentSessionId,
					(todo, action) => {
						const title = todo.title || "(untitled)";
						nextPrompt =
							action === "refine"
								? buildRefinePrompt(todo.id, title)
								: `work on todo ${formatTodoId(todo.id)} "${title}"`;
						done();
					},
				);

				setActiveComponent(selector);

				const rootComponent = {
					get focused() {
						return wrapperFocused;
					},
					set focused(value: boolean) {
						wrapperFocused = value;
						if (activeComponent && "focused" in activeComponent) {
							activeComponent.focused = value;
						}
					},
					render(width: number) {
						return activeComponent ? activeComponent.render(width) : [];
					},
					invalidate() {
						activeComponent?.invalidate();
					},
					handleInput(data: string) {
						activeComponent?.handleInput?.(data);
					},
				};

				return rootComponent;
			});

		if (goBackToHome) {
			await openTodosCommand(args, ctx);
			return;
		}

		if (nextPrompt) {
			ctx.ui.setEditorText(nextPrompt);
			rootTui?.requestRender();
		}

		// Refresh widget after /todos command (user may have changed state)
		updateTodoWidget(ctx);
	};

	pi.registerCommand("todos", {
		description: "Open the todo manager",
		handler: openTodosCommand,
	});

}
