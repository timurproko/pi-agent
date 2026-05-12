import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * model-level extension
 *
 * Restricts thinking-level cycling/selection to only the levels a model
 * actually supports on its provider. When switching to a model with fewer
 * levels, the current level is auto-clamped downward to the closest allowed
 * one.
 *
 * Config: ~/.pi/agent/model-levels.json
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

const CONFIG_FILE = "model-levels.json";

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
		const configPath = path.join(getAgentDir(), CONFIG_FILE);
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
// Extension entry point
// ---------------------------------------------------------------------------

export default function modelLevelExtension(pi: ExtensionAPI): void {
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
