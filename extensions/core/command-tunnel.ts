import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type AutocompleteItem, type AutocompleteProvider, type AutocompleteSuggestions } from "@earendil-works/pi-tui";

type Awaitable<T> = T | Promise<T>;

export interface CommandTunnelItem extends AutocompleteItem {
	/** Value appended after `<commandName>:` and passed to the host command as its first argument. */
	value: string;
}

export interface CommandTunnel {
	/** Host slash command name, without the leading slash. Example: `skills` for `/skills:`. */
	commandName: string;
	/**
	 * Top-level slash command value prefixes owned by this tunnel and hidden from the normal global menu.
	 * Example: `skill:` hides `/skill:*` entries while `/skills:*` exposes them through the tunnel.
	 */
	hideGlobalValuePrefixes?: string[];
	/** Return tunnel suggestions for the text after `<commandName>:`. */
	getItems: (query: string) => Awaitable<CommandTunnelItem[]>;
	/**
	 * Rewrite submitted `/commandName:value rest` input. This runs from the input hook,
	 * after extension slash commands have already been checked, so tunnels that target
	 * pi-native expansion should rewrite to that native syntax (for example `/skill:value`).
	 */
	toInputText?: (value: string, rest: string) => string;
}

const TUNNEL_COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function normalizeCommandName(commandName: string): string {
	return commandName.trim().replace(/^\/+/, "");
}

function isTopLevelSlashCommandCompletion(lines: string[], cursorLine: number, cursorCol: number, suggestions: AutocompleteSuggestions): boolean {
	const currentLine = lines[cursorLine] || "";
	const textBeforeCursor = currentLine.slice(0, cursorCol);
	return suggestions.prefix.startsWith("/") && textBeforeCursor === suggestions.prefix && !suggestions.prefix.slice(1).includes("/");
}

function extractTunnelQuery(textBeforeCursor: string, tunnels: CommandTunnel[]): { tunnel: CommandTunnel; query: string } | undefined {
	const match = textBeforeCursor.match(/^\/([A-Za-z0-9][A-Za-z0-9_-]*):([^\s]*)$/);
	if (!match) return undefined;

	const commandName = match[1] ?? "";
	const tunnel = tunnels.find((candidate) => normalizeCommandName(candidate.commandName) === commandName);
	if (!tunnel) return undefined;

	return { tunnel, query: match[2] ?? "" };
}

function shouldHideGlobalItem(item: AutocompleteItem, tunnels: CommandTunnel[]): boolean {
	return tunnels.some((tunnel) => (tunnel.hideGlobalValuePrefixes ?? []).some((prefix) => item.value.startsWith(prefix)));
}

function tunnelItemValue(commandName: string, value: string): string {
	return `${commandName}:${value}`;
}

function normalizeTunnels(tunnels: CommandTunnel[]): CommandTunnel[] {
	return tunnels
		.map((tunnel) => ({ ...tunnel, commandName: normalizeCommandName(tunnel.commandName) }))
		.filter((tunnel) => TUNNEL_COMMAND_PATTERN.test(tunnel.commandName));
}

export function createCommandTunnelAutocompleteProvider(current: AutocompleteProvider, tunnels: CommandTunnel[]): AutocompleteProvider {
	const activeTunnels = normalizeTunnels(tunnels);

	return {
		...current,
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const tunnelQuery = extractTunnelQuery(textBeforeCursor, activeTunnels);
			if (tunnelQuery) {
				const items = await tunnelQuery.tunnel.getItems(tunnelQuery.query);
				if (options.signal.aborted || items.length === 0) return null;
				return {
					prefix: textBeforeCursor,
					items: items.map((item) => ({
						...item,
						value: tunnelItemValue(tunnelQuery.tunnel.commandName, item.value),
						label: item.label || tunnelItemValue(tunnelQuery.tunnel.commandName, item.value),
					})),
				};
			}

			const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (!suggestions || !isTopLevelSlashCommandCompletion(lines, cursorLine, cursorCol, suggestions)) return suggestions;

			const items = suggestions.items.filter((item) => !shouldHideGlobalItem(item, activeTunnels));
			return items.length > 0 ? { ...suggestions, items } : null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

type EditorFactory = (tui: any, theme: any, keybindings: any) => any;

type TunnelCapableEditor = {
	handleInput(data: string): void;
	getText(): string;
	setText(text: string): void;
	onChange?: (text: string) => void;
	[key: string]: unknown;
	[key: symbol]: unknown;
};

const EDITOR_WRAPPED = Symbol.for("pi.commandTunnel.editorWrapped");
const EDITOR_TUNNELS = Symbol.for("pi.commandTunnel.editorTunnels");
const AUTOCOMPLETE_DESCRIPTION_PATCHED = Symbol.for("pi.commandTunnel.autocompleteDescriptionPatched");
const AUTOCOMPLETE_LIST_FACTORY_PATCHED = Symbol.for("pi.commandTunnel.autocompleteListFactoryPatched");
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

function getSelectedAutocompleteValue(editor: TunnelCapableEditor): string | undefined {
	const list = editor.autocompleteList as ({ getSelectedItem?: () => AutocompleteItem | undefined } | undefined);
	return list?.getSelectedItem?.()?.value;
}

function tryCompleteSelectedCommandTunnel(editor: TunnelCapableEditor, tunnels: CommandTunnel[]): boolean {
	const selectedValue = getSelectedAutocompleteValue(editor);
	if (!selectedValue || !tunnels.some((tunnel) => tunnel.commandName === selectedValue)) return false;

	const prefix = typeof editor.autocompletePrefix === "string" ? editor.autocompletePrefix : undefined;
	if (!prefix || !prefix.startsWith("/") || prefix.slice(1).includes("/")) return false;

	const state = editor.state as ({ lines?: string[]; cursorLine?: number; cursorCol?: number } | undefined);
	if (!state || !Array.isArray(state.lines) || typeof state.cursorLine !== "number" || typeof state.cursorCol !== "number") return false;

	const currentLine = state.lines[state.cursorLine] ?? "";
	const beforePrefix = currentLine.slice(0, state.cursorCol - prefix.length);
	if (beforePrefix.trim() !== "") return false;

	const afterCursor = currentLine.slice(state.cursorCol);
	const nextLine = `${beforePrefix}/${selectedValue}:${afterCursor}`;

	if (typeof editor.pushUndoSnapshot === "function") editor.pushUndoSnapshot();
	editor.lastAction = null;
	state.lines = [...state.lines];
	state.lines[state.cursorLine] = nextLine;
	if (typeof editor.setCursorCol === "function") {
		editor.setCursorCol(beforePrefix.length + selectedValue.length + 2);
	} else {
		state.cursorCol = beforePrefix.length + selectedValue.length + 2;
	}
	if (typeof editor.cancelAutocomplete === "function") editor.cancelAutocomplete();
	editor.onChange?.(editor.getText());
	if (typeof editor.tryTriggerAutocomplete === "function") editor.tryTriggerAutocomplete();
	return true;
}

function patchAutocompleteListSelectedDescription(list: any): void {
	if (!list || list[AUTOCOMPLETE_DESCRIPTION_PATCHED] || typeof list.renderItem !== "function") return;

	list.renderItem = function renderItemWithMutedSelectedDescription(
		item: AutocompleteItem,
		isSelected: boolean,
		width: number,
		descriptionSingleLine: string | undefined,
		primaryColumnWidth: number,
	): string {
		const theme = this.theme;
		const prefix = isSelected ? "→ " : "  ";
		const prefixWidth = visibleWidth(prefix);

		if (descriptionSingleLine && width > 40) {
			const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = typeof this.truncatePrimary === "function"
				? this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth)
				: truncateToWidth(item.label || item.value, maxPrimaryWidth, "");
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2;

			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
				if (isSelected) {
					return theme.selectedText(`${prefix}${truncatedValue}${spacing}`) + theme.description(truncatedDesc);
				}

				return prefix + truncatedValue + theme.description(spacing + truncatedDesc);
			}
		}

		const maxWidth = width - prefixWidth - 2;
		const truncatedValue = typeof this.truncatePrimary === "function"
			? this.truncatePrimary(item, isSelected, maxWidth, maxWidth)
			: truncateToWidth(item.label || item.value, maxWidth, "");
		if (isSelected) return theme.selectedText(`${prefix}${truncatedValue}`);
		return prefix + truncatedValue;
	};
	list[AUTOCOMPLETE_DESCRIPTION_PATCHED] = true;
}

function patchEditorAutocompleteLists(editor: TunnelCapableEditor): void {
	patchAutocompleteListSelectedDescription(editor.autocompleteList);
	if (editor[AUTOCOMPLETE_LIST_FACTORY_PATCHED] || typeof editor.createAutocompleteList !== "function") return;

	const originalCreateAutocompleteList = editor.createAutocompleteList.bind(editor);
	editor.createAutocompleteList = (...args: any[]) => {
		const list = originalCreateAutocompleteList(...args);
		patchAutocompleteListSelectedDescription(list);
		return list;
	};
	editor[AUTOCOMPLETE_LIST_FACTORY_PATCHED] = true;
}

function wrapEditorForCommandTunnels(editor: TunnelCapableEditor, tunnels: CommandTunnel[]): TunnelCapableEditor {
	const activeTunnels = normalizeTunnels(tunnels);
	if (activeTunnels.length === 0) return editor;
	patchEditorAutocompleteLists(editor);

	const existingTunnels = Array.isArray(editor[EDITOR_TUNNELS]) ? editor[EDITOR_TUNNELS] as CommandTunnel[] : [];
	const tunnelsByCommand = new Map<string, CommandTunnel>();
	for (const tunnel of [...existingTunnels, ...activeTunnels]) tunnelsByCommand.set(tunnel.commandName, tunnel);
	editor[EDITOR_TUNNELS] = [...tunnelsByCommand.values()];
	if (editor[EDITOR_WRAPPED]) return editor;

	const originalHandleInput = editor.handleInput.bind(editor);
	editor.handleInput = (data: string) => {
		const currentTunnels = Array.isArray(editor[EDITOR_TUNNELS]) ? editor[EDITOR_TUNNELS] as CommandTunnel[] : [];
		if (data === ":" && tryCompleteSelectedCommandTunnel(editor, currentTunnels)) return;
		originalHandleInput(data);
	};
	editor[EDITOR_WRAPPED] = true;
	return editor;
}

export function createCommandTunnelEditorFactory(tunnels: CommandTunnel[], currentFactory?: EditorFactory): EditorFactory {
	return (tui, theme, keybindings) => {
		const editor = currentFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
		return wrapEditorForCommandTunnels(editor as TunnelCapableEditor, tunnels);
	};
}

export function transformCommandTunnelInput(text: string, tunnels: CommandTunnel[]): string {
	const activeTunnels = new Map(normalizeTunnels(tunnels).map((tunnel) => [tunnel.commandName, tunnel]));
	return text.replace(/^\/([A-Za-z0-9][A-Za-z0-9_-]*):([^\s]*)([\s\S]*)$/, (full, commandName: string, tunneledValue: string, rest: string) => {
		const tunnel = activeTunnels.get(commandName);
		if (!tunnel) return full;
		return tunnel.toInputText?.(tunneledValue, rest) ?? `/${commandName} ${tunneledValue}${rest}`;
	});
}
