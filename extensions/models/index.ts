import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { EditorModal, type EditorModalFilter } from "../core/editor-ui";

/**
 * model-level extension
 *
 * Restricts thinking-level cycling/selection to only the levels a model
 * actually supports on its provider. When switching to a model with fewer
 * levels, the current level is auto-clamped downward to the closest allowed
 * one.
 *
 * Config: models.json next to this extension.
 *   A flat map of "provider/model-id" → allowed ThinkingLevel[].
 *   Example:
 *     {
 *       "github-copilot/claude-opus-4.7": ["medium"],
 *       "github-copilot/gpt-5.5":         ["minimal", "low", "medium", "high"]
 *     }
 *
 * How it works:
 *   On model_select (and session_start for the initial model), the extension
 *   mutates the live model object's `thinkingLevelMap`, setting disallowed
 *   levels to `null`. This makes pi's built-in `getSupportedThinkingLevels()`
 *   exclude them, so both the thinking-selector UI and Ctrl+Shift+T cycling
 *   only show/visit allowed levels.
 *
 *   If the current thinking level is no longer allowed, it is clamped to the
 *   closest allowed level below (or above as a fallback).
 */

const CONFIG_FILE = "models.json";
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

// Canonical order — must match pi-ai's EXTENDED_THINKING_LEVELS.
const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof ALL_LEVELS)[number];

// "provider/model-id" → allowed levels
type ModelLevelConfig = Record<string, ThinkingLevel[]>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function readConfig(): ModelLevelConfig {
	try {
		const configPath = path.join(EXTENSION_DIR, CONFIG_FILE);
		const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
		// Quick validation: every value must be a non-empty string array
		const result: ModelLevelConfig = {};
		for (const [key, value] of Object.entries(raw)) {
			if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) {
				result[key] = value as ThinkingLevel[];
			}
		}
		return result;
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getModelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Build a thinkingLevelMap that marks disallowed levels as `null`.
 * Allowed levels keep their existing mapping (if any) so the provider still
 * receives the correct effort string.
 */
function buildThinkingLevelMap(
	allowedLevels: ThinkingLevel[],
	existingMap?: Record<string, string | null>,
): Record<string, string | null> {
	const result: Record<string, string | null> = {};
	const allowed = new Set(allowedLevels);

	for (const level of ALL_LEVELS) {
		if (!allowed.has(level)) {
			// Mark as unsupported — getSupportedThinkingLevels() will skip it.
			result[level] = null;
		} else if (existingMap?.[level] !== undefined) {
			// Preserve the original provider mapping (e.g. "max", "xhigh").
			result[level] = existingMap[level];
		}
		// If allowed and no existing mapping, leave unset → default behaviour.
	}

	return result;
}

/**
 * Find the closest allowed level at or below the current one.
 * Falls back upward if nothing is below.
 */
function clampDown(current: string, allowed: ThinkingLevel[]): ThinkingLevel {
	if (allowed.includes(current as ThinkingLevel)) return current as ThinkingLevel;

	const currentIdx = ALL_LEVELS.indexOf(current as ThinkingLevel);
	if (currentIdx === -1) return allowed[0] ?? "off";

	// Search downward first (prefer lower effort).
	for (let i = currentIdx - 1; i >= 0; i--) {
		if (allowed.includes(ALL_LEVELS[i])) return ALL_LEVELS[i];
	}
	// Search upward as fallback.
	for (let i = currentIdx + 1; i < ALL_LEVELS.length; i++) {
		if (allowed.includes(ALL_LEVELS[i])) return ALL_LEVELS[i];
	}

	return allowed[0] ?? "off";
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

function applyModelRestrictions(pi: ExtensionAPI, ctx: ExtensionContext, config: ModelLevelConfig): void {
	const model = ctx.model;
	if (!model) return;

	const key = getModelKey(model);
	const allowedLevels = config[key];
	if (!allowedLevels || allowedLevels.length === 0) return;

	// Mutate the live model object's thinkingLevelMap.  This is the same
	// object that agent-session.js references via `this.agent.state.model`,
	// so subsequent calls to getSupportedThinkingLevels / clampThinkingLevel
	// (and the ThinkingSelectorComponent UI) will honour the restrictions.
	model.thinkingLevelMap = buildThinkingLevelMap(allowedLevels, model.thinkingLevelMap);

	// If the model doesn't declare `reasoning` but has allowed levels beyond
	// "off", ensure the flag is set so the thinking UI shows up at all.
	if (!model.reasoning && allowedLevels.some((l) => l !== "off")) {
		model.reasoning = true;
	}

	// Re-clamp the current thinking level to the now-restricted set.
	const currentLevel = pi.getThinkingLevel();
	const newLevel = clampDown(currentLevel, allowedLevels);
	if (newLevel !== currentLevel) {
		pi.setThinkingLevel(newLevel);
	}
}

// ---------------------------------------------------------------------------
// `/models` command
// ---------------------------------------------------------------------------

type ModelScopeFilter = "scoped" | "all";
type ModelLike = {
	provider: string;
	id: string;
	name?: string;
};
type AgentSettings = {
	defaultProvider?: string;
	defaultModel?: string;
	enabledModels?: string[];
	[key: string]: unknown;
};

const MODEL_FILTERS: Array<EditorModalFilter<ModelScopeFilter>> = [
	{ value: "scoped", label: "scoped" },
	{ value: "all", label: "all" },
];

function getFullModelId(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

function getModelDisplayName(model: ModelLike): string | undefined {
	const name = model.name?.replace(/^Model Name\s*:?\s*/i, "").trim();
	return name && name !== model.id ? name : undefined;
}

function readAgentSettings(): AgentSettings {
	const settingsPath = path.join(getAgentDir(), "settings.json");
	try {
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as AgentSettings : {};
	} catch {
		return {};
	}
}

function writeAgentSettings(settings: AgentSettings): void {
	const settingsPath = path.join(getAgentDir(), "settings.json");
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function readSavedEnabledIds(): string[] {
	const value = readAgentSettings().enabledModels;
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function arraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function matchesModel(model: ModelLike, query: string): boolean {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return true;
	return `${model.id} ${model.name ?? ""} ${model.provider} ${getFullModelId(model)}`.toLowerCase().includes(normalized);
}

function sortModels(models: ModelLike[]): ModelLike[] {
	return [...models].sort((a, b) => {
		const providerDiff = a.provider.localeCompare(b.provider);
		if (providerDiff !== 0) return providerDiff;
		return a.id.localeCompare(b.id);
	});
}

function buildScopedModels(scopedIds: string[], modelRegistry: ExtensionContext["modelRegistry"]): ModelLike[] {
	return scopedIds
		.map((fullId) => {
			const slash = fullId.indexOf("/");
			if (slash <= 0) return undefined;
			return modelRegistry.find(fullId.slice(0, slash), fullId.slice(slash + 1));
		})
		.filter((model): model is ModelLike => !!model);
}

function getVisibleScopedIds(savedIds: string[], desiredIds: string[]): string[] {
	return [...savedIds, ...desiredIds.filter((id) => !savedIds.includes(id))];
}

async function persistEnabledModels(enabledIds: string[]): Promise<void> {
	const settings = readAgentSettings();
	if (enabledIds.length === 0) {
		delete settings.enabledModels;
	} else {
		settings.enabledModels = [...enabledIds];
	}
	writeAgentSettings(settings);
}

function persistDefaultModel(model: ModelLike): void {
	const settings = readAgentSettings();
	settings.defaultProvider = model.provider;
	settings.defaultModel = model.id;
	writeAgentSettings(settings);
}

async function showModelsCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	ctx.modelRegistry.refresh();
	const availableModels = ctx.modelRegistry.getAvailable() as ModelLike[];
	if (availableModels.length === 0) {
		ctx.ui.notify("No models available. Use /login to add providers.", "warning");
		return;
	}

	let savedEnabledIds = readSavedEnabledIds().filter((id) => {
		const slash = id.indexOf("/");
		return slash > 0 && !!ctx.modelRegistry.find(id.slice(0, slash), id.slice(slash + 1));
	});
	let desiredEnabledIds = [...savedEnabledIds];
	let activeFilter: ModelScopeFilter = "scoped";
	let activeValue = ctx.model ? getFullModelId(ctx.model) : undefined;
	const initialQuery = args.trim();

	const isScoped = (fullId: string) => desiredEnabledIds.includes(fullId);
	const toggleScoped = (fullId: string) => {
		if (isScoped(fullId)) {
			desiredEnabledIds = desiredEnabledIds.filter((id) => id !== fullId);
		} else {
			desiredEnabledIds = [...desiredEnabledIds, fullId];
		}
	};

	const saveScopedModels = async (): Promise<void> => {
		await persistEnabledModels(desiredEnabledIds);
		savedEnabledIds = [...desiredEnabledIds];
		ctx.ui.notify(
			desiredEnabledIds.length > 0
				? `Saved ${desiredEnabledIds.length} scoped model${desiredEnabledIds.length === 1 ? "" : "s"}. Run /reload to apply to Ctrl+P cycling.`
				: "Cleared scoped models. Run /reload to apply to Ctrl+P cycling.",
			"info",
		);
	};

	const result = await ctx.ui.custom<string | "cancel">((tui, theme, keybindings, done) => new EditorModal<string, ModelScopeFilter>({
		tui,
		theme,
		keybindings,
		title: "Models",
		filters: MODEL_FILTERS,
		initialFilter: activeFilter,
		initialSelectedValue: activeValue,
		search: true,
		initialQuery,
		shortcuts: "type to search · ↑↓ navigate · tab filter · enter switch · space scope · ctrl+s save · esc cancel",
		noItemsText: (query) => query.trim() ? "No matching models" : "No scoped models",
		descriptionGap: 4,
		getStatusText: () => arraysEqual(desiredEnabledIds, savedEnabledIds) ? undefined : "(unsaved)",
		getItems: (filter, query = "") => {
			const models = filter === "scoped"
				? buildScopedModels(getVisibleScopedIds(savedEnabledIds, desiredEnabledIds), ctx.modelRegistry)
				: availableModels;
			return sortModels(models)
				.filter((model) => matchesModel(model, query))
				.map((model) => {
					const fullId = getFullModelId(model);
					const scoped = isScoped(fullId);
					return {
						value: fullId,
						label: model.id,
						description: `[${model.provider}]`,
						selectedDescription: getModelDisplayName(model),
						prefixIcon: scoped ? "●" : "○",
						prefixIconColor: scoped ? "success" : "dim",
						checked: ctx.model && getFullModelId(ctx.model) === fullId ? true : undefined,
					};
				});
		},
		onSelect: (item) => done(item.value),
		onCancel: () => done("cancel"),
		onFilterChange: (filter) => {
			activeFilter = filter;
		},
		onInput: (data, filter, selectedItem) => {
			if (data === " ") {
				if (!selectedItem) return true;
				activeFilter = filter ?? activeFilter;
				activeValue = selectedItem.value;
				toggleScoped(selectedItem.value);
				return true;
			}
			if (data === "\x13") {
				activeFilter = filter ?? activeFilter;
				activeValue = selectedItem?.value ?? activeValue;
				void saveScopedModels().finally(() => tui.requestRender());
				return true;
			}
			return false;
		},
	}));

	if (result === "cancel") return;

	const slash = result.indexOf("/");
	const model = slash > 0 ? ctx.modelRegistry.find(result.slice(0, slash), result.slice(slash + 1)) : undefined;
	if (!model) {
		ctx.ui.notify(`Model not found: ${result}`, "error");
		return;
	}

	persistDefaultModel(model);
	const success = await pi.setModel(model);
	if (!success) {
		ctx.ui.notify(`No API key for ${model.provider}/${model.id}`, "error");
		return;
	}
	ctx.ui.notify(`Model: ${model.id}`, "info");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function modelLevelExtension(pi: ExtensionAPI): void {
	pi.registerCommand("models", {
		description: "Switch models and manage scoped model cycling",
		handler: async (args, ctx) => showModelsCommand(pi, args, ctx),
	});

	// Apply restrictions on session start (for the initial model).
	pi.on("session_start", async (_event, ctx) => {
		const config = readConfig();
		if (Object.keys(config).length === 0) return;
		applyModelRestrictions(pi, ctx, config);
	});

	// Re-apply whenever the model changes (cycle, manual set, etc.).
	// model_select fires AFTER the session has already set the new model and
	// called setThinkingLevel with the old preference, so the current level
	// may be invalid.  We fix it here.
	pi.on("model_select", async (_event, ctx) => {
		const config = readConfig();
		if (Object.keys(config).length === 0) return;
		applyModelRestrictions(pi, ctx, config);
	});
}
