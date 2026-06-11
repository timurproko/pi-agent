import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { InteractiveMode, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { EditorModal, type EditorModalFilter, type EditorModalItem } from "./core/editor-ui";

type CommandSource = "builtin" | SlashCommandInfo["source"];
type CommandFilter = "all" | "hidden";

type CommandInfo = {
	name: string;
	description?: string;
	source: CommandSource;
};

type HiddenSettings = {
	__settingsCommand?: string;
	hiddenCommands?: string[];
};

type CommandSettingsEvent = {
	args?: string;
	ctx?: ExtensionCommandContext;
};

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_DIR = path.join(EXTENSION_DIR, "hidden");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");
const SETTINGS_COMMAND = "hidden-settings";
const PROTECTED_COMMANDS = new Set(["hidden"]);

const BUILTIN_COMMANDS: CommandInfo[] = [
	{ name: "settings", description: "Open settings menu", source: "builtin" },
	{ name: "model", description: "Select model (opens selector UI)", source: "builtin" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling", source: "builtin" },
	{ name: "export", description: "Export session", source: "builtin" },
	{ name: "import", description: "Import and resume a session", source: "builtin" },
	{ name: "share", description: "Share session as a secret GitHub gist", source: "builtin" },
	{ name: "copy", description: "Copy last agent message to clipboard", source: "builtin" },
	{ name: "name", description: "Set session display name", source: "builtin" },
	{ name: "session", description: "Show session info and stats", source: "builtin" },
	{ name: "changelog", description: "Show changelog entries", source: "builtin" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts", source: "builtin" },
	{ name: "fork", description: "Create a new fork from a previous user message", source: "builtin" },
	{ name: "clone", description: "Duplicate the current session at the current position", source: "builtin" },
	{ name: "tree", description: "Navigate session tree", source: "builtin" },
	{ name: "trust", description: "Save project trust decision", source: "builtin" },
	{ name: "login", description: "Configure provider authentication", source: "builtin" },
	{ name: "logout", description: "Remove provider authentication", source: "builtin" },
	{ name: "new", description: "Start a new session", source: "builtin" },
	{ name: "compact", description: "Manually compact session context", source: "builtin" },
	{ name: "resume", description: "Resume a different session", source: "builtin" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes", source: "builtin" },
	{ name: "quit", description: "Quit pi", source: "builtin" },
];

type InteractiveModeWithEditor = {
	defaultEditor?: {
		onSubmit?: (text: string) => void | Promise<void>;
	};
};

type HiddenGlobalState = typeof globalThis & {
	__piHiddenInteractiveMode?: InteractiveModeWithEditor;
	__piHiddenInteractivePatchInstalled?: boolean;
};

const COMMAND_FILTERS: Array<EditorModalFilter<CommandFilter>> = [
	{ value: "all", label: "all" },
	{ value: "hidden", label: "hidden" },
];

function installInteractiveCommandExecutor(): void {
	const state = globalThis as HiddenGlobalState;
	if (state.__piHiddenInteractivePatchInstalled) return;

	const proto = (InteractiveMode as unknown as { prototype?: Record<string, unknown> }).prototype;
	if (!proto) return;

	const patchMethod = (name: string): boolean => {
		const original = proto[name];
		if (typeof original !== "function") return false;
		proto[name] = function patchedInteractiveModeMethod(this: InteractiveModeWithEditor, ...args: unknown[]) {
			state.__piHiddenInteractiveMode = this;
			return original.apply(this, args);
		};
		return true;
	};

	const patchedSubmit = patchMethod("setupEditorSubmitHandler");
	// setupAutocompleteProvider is called when this extension registers its
	// autocomplete wrapper during session_start, so it also captures the current
	// InteractiveMode instance on reloads where submit handlers are already set.
	const patchedAutocomplete = patchMethod("setupAutocompleteProvider");
	state.__piHiddenInteractivePatchInstalled = patchedSubmit || patchedAutocomplete;
}

function executeInteractiveSlashCommand(commandName: string): boolean {
	const state = globalThis as HiddenGlobalState;
	const mode = state.__piHiddenInteractiveMode;
	const submit = mode?.defaultEditor?.onSubmit;
	if (typeof submit !== "function") return false;

	setTimeout(() => {
		void submit.call(mode.defaultEditor, `/${commandName}`);
	}, 0);
	return true;
}

function ensureSettingsFile(): void {
	fs.mkdirSync(SETTINGS_DIR, { recursive: true });
	if (!fs.existsSync(SETTINGS_FILE)) {
		writeSettings({ __settingsCommand: SETTINGS_COMMAND, hiddenCommands: [] });
	}
}

function readSettings(): HiddenSettings {
	ensureSettingsFile();
	try {
		const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { __settingsCommand: SETTINGS_COMMAND, hiddenCommands: [] };
		return {
			__settingsCommand: typeof raw.__settingsCommand === "string" ? raw.__settingsCommand : SETTINGS_COMMAND,
			hiddenCommands: Array.isArray(raw.hiddenCommands)
				? raw.hiddenCommands.filter((name: unknown): name is string => typeof name === "string")
				: [],
		};
	} catch {
		return { __settingsCommand: SETTINGS_COMMAND, hiddenCommands: [] };
	}
}

function writeSettings(settings: HiddenSettings): void {
	fs.mkdirSync(SETTINGS_DIR, { recursive: true });
	const uniqueHidden = [...new Set(settings.hiddenCommands ?? [])]
		.filter((name) => name && !PROTECTED_COMMANDS.has(name))
		.sort((a, b) => a.localeCompare(b));
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
		__settingsCommand: SETTINGS_COMMAND,
		hiddenCommands: uniqueHidden,
	}, null, 2) + "\n", "utf8");
}

function getHiddenSet(): Set<string> {
	return new Set(readSettings().hiddenCommands ?? []);
}

function getAllCommands(pi: ExtensionAPI): CommandInfo[] {
	const byName = new Map<string, CommandInfo>();
	for (const command of BUILTIN_COMMANDS) byName.set(command.name, command);
	for (const command of pi.getCommands()) {
		if (command.source === "skill") continue;
		byName.set(command.name, {
			name: command.name,
			description: command.description,
			source: command.source,
		});
	}
	for (const commandName of PROTECTED_COMMANDS) byName.delete(commandName);
	return [...byName.values()].sort((a, b) => {
		const sourceDiff = a.source.localeCompare(b.source);
		return sourceDiff !== 0 ? sourceDiff : a.name.localeCompare(b.name);
	});
}

function matchesCommand(command: CommandInfo, query: string): boolean {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return true;
	return `${command.name} ${command.description ?? ""} ${command.source}`.toLowerCase().includes(normalized);
}

function filterCommands(commands: CommandInfo[], hiddenSet: Set<string>, filter: CommandFilter | undefined, query = ""): CommandInfo[] {
	const activeFilter = filter ?? "all";
	return commands
		.filter((command) => activeFilter === "hidden" ? hiddenSet.has(command.name) : true)
		.filter((command) => matchesCommand(command, query));
}

function toItem(command: CommandInfo, hiddenSet: Set<string>): EditorModalItem<string> {
	const hidden = hiddenSet.has(command.name);
	const protectedCommand = PROTECTED_COMMANDS.has(command.name);
	return {
		value: command.name,
		label: command.name,
		description: `[${command.source}]`,
		selectedDescription: command.description,
		checked: hidden,
		disabled: protectedCommand,
	};
}

function isSlashCommandCompletion(lines: string[], cursorLine: number, cursorCol: number, suggestions: AutocompleteSuggestions): boolean {
	const currentLine = lines[cursorLine] || "";
	const textBeforeCursor = currentLine.slice(0, cursorCol);
	return suggestions.prefix.startsWith("/") && textBeforeCursor === suggestions.prefix && !suggestions.prefix.slice(1).includes("/");
}

function wrapAutocompleteProvider(provider: AutocompleteProvider): AutocompleteProvider {
	return {
		...provider,
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol, options);
			if (!suggestions || !isSlashCommandCompletion(lines, cursorLine, cursorCol, suggestions)) return suggestions;

			const hiddenSet = getHiddenSet();
			if (hiddenSet.size === 0) return suggestions;

			const items = suggestions.items.filter((item) => !hiddenSet.has(item.value));
			return items.length > 0 ? { ...suggestions, items } : null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion: provider.shouldTriggerFileCompletion?.bind(provider),
	};
}

async function showHiddenSettings(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	let hiddenSet = getHiddenSet();
	let savedHiddenSet = new Set(hiddenSet);
	let activeFilter: CommandFilter = "all";
	let activeValue: string | undefined;
	const initialQuery = args.trim();

	const save = (): void => {
		writeSettings({ hiddenCommands: [...hiddenSet] });
		savedHiddenSet = new Set(hiddenSet);
		ctx.ui.notify(`Saved ${hiddenSet.size} hidden command${hiddenSet.size === 1 ? "" : "s"}.`, "info");
	};

	const result = await ctx.ui.custom<string | "cancel">((tui, theme, keybindings, done) => new EditorModal<string, CommandFilter>({
		tui,
		theme,
		keybindings,
		title: "Hidden Commands",
		filters: COMMAND_FILTERS,
		initialFilter: activeFilter,
		initialSelectedValue: activeValue,
		search: true,
		initialQuery,
		shortcuts: "type to search · ↑↓ navigate · tab filter · enter/space toggle · ctrl+s save · esc cancel",
		noItemsText: (query) => query.trim() ? "No matching commands" : "No commands",
		descriptionGap: 4,
		getStatusText: () => {
			const current = [...hiddenSet].sort().join("\0");
			const saved = [...savedHiddenSet].sort().join("\0");
			return current === saved ? undefined : "(unsaved)";
		},
		getItems: (filter, query = "") => filterCommands(getAllCommands(pi), hiddenSet, filter, query).map((command) => toItem(command, hiddenSet)),
		onSelect: (item) => {
			if (PROTECTED_COMMANDS.has(item.value)) return;
			if (hiddenSet.has(item.value)) hiddenSet.delete(item.value);
			else hiddenSet.add(item.value);
			activeValue = item.value;
		},
		onCancel: () => done("cancel"),
		onFilterChange: (filter) => {
			activeFilter = filter;
		},
		onInput: (data, filter, selectedItem) => {
			if (data === " ") {
				if (selectedItem && !PROTECTED_COMMANDS.has(selectedItem.value)) {
					if (hiddenSet.has(selectedItem.value)) hiddenSet.delete(selectedItem.value);
					else hiddenSet.add(selectedItem.value);
					activeValue = selectedItem.value;
				}
				activeFilter = filter ?? activeFilter;
				return true;
			}
			if (data === "\x13") {
				activeFilter = filter ?? activeFilter;
				activeValue = selectedItem?.value ?? activeValue;
				save();
				return true;
			}
			return false;
		},
	}));

	if (result === "cancel") return;
}

async function showHiddenCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const hiddenSet = getHiddenSet();
	const hiddenCommands = getAllCommands(pi).filter((command) => hiddenSet.has(command.name));
	if (hiddenCommands.length === 0) {
		await showHiddenSettings(pi, args, ctx);
		return;
	}

	const result = await ctx.ui.custom<string | "cancel">((tui, theme, keybindings, done) => new EditorModal<string>({
		tui,
		theme,
		keybindings,
		title: "Hidden",
		search: true,
		initialQuery: args.trim(),
		maxVisible: Math.min(10, Math.max(1, hiddenCommands.length)),
		shortcuts: "type to search · ↑↓ navigate · enter run · esc cancel",
		noItemsText: (query) => query.trim() ? "No matching hidden commands" : "No hidden commands",
		descriptionGap: 4,
		getItems: (_filter, query = "") => hiddenCommands
			.filter((command) => matchesCommand(command, query))
			.map((command) => ({
				value: command.name,
				label: command.name,
				description: `[${command.source}]`,
				selectedDescription: command.description,
			})),
		onSelect: (item) => done(item.value),
		onCancel: () => done("cancel"),
	}));

	if (!result || result === "cancel") return;
	if (!executeInteractiveSlashCommand(result)) {
		ctx.ui.setEditorText(`/${result}`);
		ctx.ui.notify(`Inserted /${result}. Press Enter to run it.`, "warning");
	}
}

function isCommandSettingsEvent(data: unknown): data is CommandSettingsEvent {
	if (!data || typeof data !== "object") return false;
	const ctx = (data as CommandSettingsEvent).ctx as (ExtensionContext | undefined);
	return !!ctx?.ui && typeof ctx.ui.custom === "function";
}

export default function hiddenCommandsExtension(pi: ExtensionAPI): void {
	installInteractiveCommandExecutor();
	ensureSettingsFile();

	pi.events.on(`command-settings:${SETTINGS_COMMAND}`, (data) => {
		if (!isCommandSettingsEvent(data) || !data.ctx) return;
		void showHiddenSettings(pi, data.args ?? "", data.ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((provider) => wrapAutocompleteProvider(provider));
	});

	pi.registerCommand("hidden", {
		description: "Show and run hidden slash commands",
		handler: async (args, ctx) => showHiddenCommand(pi, args, ctx),
	});

}
