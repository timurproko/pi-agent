/**
 * pi-extensions
 *
 * Adds an `/extensions` command that shows all discovered extensions with
 * the option to enable / disable each one on the fly.
 *
 * UX is modeled after the scoped-models / `/tools` selector:
 *   - SettingsList with one row per extension
 *   - Toggle "enabled" / "disabled" on each row
 *   - On close, applies any pending toggles by renaming entry files on disk
 *     and runs ctx.reload() so changes take effect immediately
 *
 * Disable strategy
 * ----------------
 * Pi auto-discovers extensions from `~/.pi/agent/extensions/` and
 * `<cwd>/.pi/extensions/`. The discovery loader only picks up files ending
 * in `.ts` / `.js`, and resolves directory extensions via `package.json`'s
 * `pi.extensions` field or `index.ts` / `index.js`.
 *
 * To disable an extension we rename its entry file to add a `.disabled`
 * suffix (e.g. `foo.ts` -> `foo.ts.disabled`, or `bar/index.ts` ->
 * `bar/index.ts.disabled`). Re-enabling reverses the rename. After applying
 * changes we call `ctx.reload()` to re-run discovery.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, InteractiveMode } from "@earendil-works/pi-coding-agent";

/**
 * Scope of a discovered extension:
 * - "global":  installed via npm (declared in settings.json `packages` as
 *              `npm:<name>`, lives in the npm global node_modules folder)
 * - "local":   in ~/.pi/agent/extensions/
 * - "project": in <cwd>/.pi/extensions/
 */
type ExtensionScope = "global" | "local" | "project";

const SCOPE_ORDER: Record<ExtensionScope, number> = {
	global: 0,
	local: 1,
	project: 2,
};

interface ExtensionInfo {
	/** Display name (file name without extension or directory name). */
	name: string;
	scope: ExtensionScope;
	/** Absolute path to the entry file we toggle (single file, or index.ts inside dir). */
	entryFile: string;
	/** True if the entry file is currently active (no `.disabled` suffix). */
	enabled: boolean;
	/** True if this is the pi-extensions extension itself - never disable. */
	isSelf: boolean;
}

const SELF_DIRNAME = "pi-extensions";
const SELF_FILENAME = "extension-manager.ts";
const PI_MCP_DIRNAME = "pi-mcp";
const PI_MCP_STATUS_PATCH_KEY = "__piMcpStatusPatch";

type PiMcpPatchableUi = ExtensionContext["ui"] & {
	__piMcpStatusPatch?: {
		originalSetStatus: (key: string, text?: string) => void;
	};
};

function isExtensionFileName(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

function isDisabledExtensionFileName(name: string): boolean {
	return name.endsWith(".ts.disabled") || name.endsWith(".js.disabled");
}

/**
 * Files / directories whose name starts with `_` are treated as internal
 * helpers (e.g. shared utility modules imported by other extensions). They
 * are still loaded by pi's extension loader (which doesn't filter them), but
 * we hide them from the extension manager UI so the user can't accidentally
 * disable them.
 */
function isInternalHelperName(name: string): boolean {
	return name.startsWith("_");
}

function stripDisabled(name: string): string {
	return name.replace(/\.disabled$/, "");
}

function readPiManifestExtensions(packageJsonPath: string): string[] | null {
	try {
		const raw = fs.readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(raw);
		const arr = pkg?.pi?.extensions;
		if (Array.isArray(arr) && arr.every((x) => typeof x === "string") && arr.length > 0) {
			return arr;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Resolve the entry file we want to toggle for a directory-based extension.
 * Returns the absolute path and whether the file is currently enabled.
 * Returns null if we can't find a single sensible entry to toggle.
 */
function resolveDirEntry(dir: string): { entryFile: string; enabled: boolean } | null {
	const candidates: Array<{ enabledPath: string; disabledPath: string }> = [];

	// 1. package.json -> first listed pi.extensions entry
	const pkgPath = path.join(dir, "package.json");
	if (fs.existsSync(pkgPath)) {
		const declared = readPiManifestExtensions(pkgPath);
		if (declared) {
			for (const rel of declared) {
				const abs = path.resolve(dir, rel);
				candidates.push({ enabledPath: abs, disabledPath: `${abs}.disabled` });
			}
		}
	}

	// 2. Fallback: index.ts / index.js
	candidates.push({
		enabledPath: path.join(dir, "index.ts"),
		disabledPath: path.join(dir, "index.ts.disabled"),
	});
	candidates.push({
		enabledPath: path.join(dir, "index.js"),
		disabledPath: path.join(dir, "index.js.disabled"),
	});

	for (const c of candidates) {
		if (fs.existsSync(c.enabledPath)) return { entryFile: c.enabledPath, enabled: true };
		if (fs.existsSync(c.disabledPath)) return { entryFile: c.enabledPath, enabled: false };
	}
	return null;
}

/**
 * Resolve pi's npm root. Pi installs packages into the agent-local prefix
 * (`~/.pi/agent/npm/node_modules`); the legacy global npm root is no longer
 * consulted.
 */
function getPiNpmRoot(): string | null {
	const root = path.join(getAgentDir(), "npm", "node_modules");
	return fs.existsSync(root) ? root : null;
}

/** npm package names declared in settings.json `packages` (without `npm:` prefix). */
function readConfiguredNpmPackageNames(): string[] {
	try {
		const settingsPath = path.join(getAgentDir(), "settings.json");
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as { packages?: unknown };
		const pkgs = Array.isArray(raw.packages) ? raw.packages : [];
		return pkgs
			.filter((p): p is string => typeof p === "string" && p.startsWith("npm:"))
			.map((p) => p.slice("npm:".length));
	} catch {
		return [];
	}
}

/**
 * Discover npm-installed pi extensions from settings.json `packages`.
 *
 * Each entry in package.json's `pi.extensions` becomes one row. If a package
 * declares multiple entries we suffix the display name with the entry's
 * basename so users can tell sibling rows apart.
 */
function discoverNpmExtensions(): ExtensionInfo[] {
	const root = getPiNpmRoot();
	if (!root) return [];
	const out: ExtensionInfo[] = [];

	for (const pkgName of readConfiguredNpmPackageNames()) {
		const pkgDir = path.join(root, pkgName);
		const pkgJson = path.join(pkgDir, "package.json");
		if (!fs.existsSync(pkgJson)) continue;

		const declared = readPiManifestExtensions(pkgJson);
		if (!declared) continue;

		for (const rel of declared) {
			const enabledPath = path.resolve(pkgDir, rel);
			const disabledPath = `${enabledPath}.disabled`;
			const hasEnabled = fs.existsSync(enabledPath);
			const hasDisabled = !hasEnabled && fs.existsSync(disabledPath);
			if (!hasEnabled && !hasDisabled) continue;

			const displayName =
				declared.length > 1 ? `${pkgName}/${path.basename(rel)}` : pkgName;

			out.push({
				name: displayName,
				scope: "global",
				entryFile: enabledPath,
				enabled: hasEnabled,
				isSelf: false,
			});
		}
	}

	return out;
}

function discoverInDir(dir: string, scope: ExtensionScope): ExtensionInfo[] {
	const out: ExtensionInfo[] = [];
	if (!fs.existsSync(dir)) return out;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}

	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		const isFile = entry.isFile() || entry.isSymbolicLink();
		const isDir = entry.isDirectory() || entry.isSymbolicLink();

		// Hide internal helper modules (names starting with `_`) from the manager.
		const displayName = isFile && isDisabledExtensionFileName(entry.name)
			? stripDisabled(entry.name)
			: entry.name;
		if (isInternalHelperName(displayName)) continue;

		// Single-file extensions: foo.ts / foo.ts.disabled
		if (isFile && isExtensionFileName(entry.name)) {
			out.push({
				name: entry.name,
				scope,
				entryFile: entryPath,
				enabled: true,
				isSelf: entry.name === SELF_FILENAME,
			});
			continue;
		}
		if (isFile && isDisabledExtensionFileName(entry.name)) {
			const originalName = stripDisabled(entry.name);
			const enabledPath = path.join(dir, originalName);
			out.push({
				name: originalName,
				scope,
				entryFile: enabledPath,
				enabled: false,
				isSelf: originalName === SELF_FILENAME,
			});
			continue;
		}

		// Directory-based extensions
		if (isDir) {
			const resolved = resolveDirEntry(entryPath);
			if (!resolved) continue;
			out.push({
				name: entry.name,
				scope,
				entryFile: resolved.entryFile,
				enabled: resolved.enabled,
				isSelf: entry.name === SELF_DIRNAME,
			});
		}
	}

	// Sort: enabled first, then by name
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

function discoverAll(cwd: string): ExtensionInfo[] {
	const result: ExtensionInfo[] = [];
	// 1. npm-installed packages (settings.json `packages: ["npm:..."]`) — [global]
	result.push(...discoverNpmExtensions());
	// 2. ~/.pi/agent/extensions/ — [local]
	result.push(...discoverInDir(path.join(getAgentDir(), "extensions"), "local"));
	// 3. <cwd>/.pi/extensions/ — [project]
	result.push(...discoverInDir(path.join(cwd, ".pi", "extensions"), "project"));

	// Sort by scope (global → local → project), then by name within each group.
	result.sort((a, b) => {
		const scopeDiff = SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
		if (scopeDiff !== 0) return scopeDiff;
		return a.name.localeCompare(b.name);
	});
	return result;
}

function isPiMcpDisabled(cwd: string): boolean {
	return discoverAll(cwd).some((ext) => ext.name === PI_MCP_DIRNAME && !ext.enabled);
}

function readConfiguredMcpServerCount(): number {
	try {
		const configPath = path.join(getAgentDir(), "mcp.json");
		const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
			mcpServers?: Record<string, unknown>;
			"mcp-servers"?: Record<string, unknown>;
		};
		return Object.keys(raw.mcpServers ?? raw["mcp-servers"] ?? {}).length;
	} catch {
		return 0;
	}
}

function restoreStalePiMcpStatusPatch(ctx: ExtensionContext): void {
	if (!ctx.hasUI || !isPiMcpDisabled(ctx.cwd)) return;

	const ui = ctx.ui as PiMcpPatchableUi;
	const patch = ui[PI_MCP_STATUS_PATCH_KEY];
	if (!patch) return;

	ui.setStatus = patch.originalSetStatus as typeof ui.setStatus;
	delete ui[PI_MCP_STATUS_PATCH_KEY];

	// pi-mcp / pi-mcp-adapter is disabled — clear the slot entirely instead of
	// re-seeding `MCP: 0/N servers`. With the adapter off there is nothing to
	// connect, so an empty footer slot is the honest UI.
	ui.setStatus("mcp", undefined);
}

/**
 * Apply pending toggle decisions to the filesystem.
 * Returns the count of changes actually made.
 */
function applyToggles(
	exts: ExtensionInfo[],
	desired: Map<string, boolean>,
): { changed: number; errors: string[] } {
	let changed = 0;
	const errors: string[] = [];
	for (const ext of exts) {
		if (ext.isSelf) continue;
		const want = desired.get(ext.entryFile);
		if (want === undefined) continue;
		if (want === ext.enabled) continue;

		const enabledPath = ext.entryFile;
		const disabledPath = `${enabledPath}.disabled`;

		try {
			if (want) {
				// enable: rename .disabled -> original
				if (fs.existsSync(disabledPath)) {
					fs.renameSync(disabledPath, enabledPath);
					changed++;
				}
			} else {
				// disable: rename original -> .disabled
				if (fs.existsSync(enabledPath)) {
					fs.renameSync(enabledPath, disabledPath);
					changed++;
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${ext.name}: ${msg}`);
		}
	}
	return { changed, errors };
}

/**
 * Strip the built-in `[u]` / `[p]` / `[t]` scope tag that pi prepends to every
 * extension command's autocomplete description. Patches the InteractiveMode
 * prototype once per process.
 */
function stripAutocompleteScopeTag(): void {
	const proto = (InteractiveMode as unknown as { prototype: Record<string, unknown> }).prototype;
	if (!proto || (proto as { __piExtScopeTagStripped?: boolean }).__piExtScopeTagStripped) return;
	proto.prefixAutocompleteDescription = function (description?: string) {
		return description ?? "";
	};
	(proto as { __piExtScopeTagStripped?: boolean }).__piExtScopeTagStripped = true;
}

export default function piExtensionsExtension(pi: ExtensionAPI) {
	stripAutocompleteScopeTag();

	pi.on("session_start", async (_event, ctx) => {
		restoreStalePiMcpStatusPatch(ctx);
	});

	pi.registerCommand("extensions", {
		description: "Enable/disable extensions on the fly",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const exts = discoverAll(ctx.cwd);
			// Sort so extension-manager itself is always at the bottom
			exts.sort((a, b) => {
				if (a.isSelf !== b.isSelf) return a.isSelf ? 1 : -1;
				const scopeDiff = SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
				if (scopeDiff !== 0) return scopeDiff;
				return a.name.localeCompare(b.name);
			});

			if (exts.length === 0) {
				ctx.ui.notify("No extensions discovered.", "info");
				return;
			}

			// In-memory desired state, keyed by entryFile
			const desired = new Map<string, boolean>();
			for (const e of exts) desired.set(e.entryFile, e.enabled);

			const result = await ctx.ui.custom((tui, theme, _kb, done) => {
				let selectedIndex = 0;

				const component = {
					render(width: number): string[] {
						const lines: string[] = [];
						lines.push(theme.fg("border", "─".repeat(width)));
						lines.push("");
						lines.push(theme.fg("accent", theme.bold("Extensions")));
						lines.push("");

						for (let i = 0; i < exts.length; i++) {
							const ext = exts[i];
							const isSelected = i === selectedIndex;
							const isEnabled = desired.get(ext.entryFile) ?? ext.enabled;

							const statusIcon = isEnabled
								? theme.fg("success", "✓")
								: theme.fg("dim", "✗");

							const rawTag =
								ext.scope === "global" ? "[global]" : ext.scope === "local" ? "[local]" : "[project]";
							const scopeTag = theme.fg("dim", rawTag);

							const cursor = isSelected ? "→ " : "  ";

							if (isSelected) {
								lines.push(theme.fg("accent", cursor) + theme.fg("accent", ext.name) + " " + scopeTag + " " + statusIcon);
							} else {
								lines.push(`${cursor}${ext.name} ${scopeTag} ${statusIcon}`);
							}
						}

						// Unsaved indicator
						const hasChanges = exts.some(ext => (desired.get(ext.entryFile) ?? ext.enabled) !== ext.enabled);

						lines.push("");
						lines.push(theme.fg("dim", "↑↓ navigate · enter toggle · ctrl+a toggle all · ctrl+s save & reload · esc cancel"));
						if (hasChanges) {
							lines.push(theme.fg("warning", "(unsaved)"));
						}
						lines.push(theme.fg("border", "─".repeat(width)));

						return lines;
					},

					handleInput(data: string) {
						if (data === "\x1B[A" || data === "k") {
							selectedIndex = selectedIndex === 0 ? exts.length - 1 : selectedIndex - 1;
						} else if (data === "\x1B[B" || data === "j") {
							selectedIndex = selectedIndex === exts.length - 1 ? 0 : selectedIndex + 1;
						} else if (data === "\x1B" || data === "q") {
							done("cancel");
							return;
						} else if (data === "\r" || data === "\n") {
							// Enter: toggle selected extension
							const ext = exts[selectedIndex];
							const current = desired.get(ext.entryFile) ?? ext.enabled;
							desired.set(ext.entryFile, !current);
						} else if (data === "\x01") {
							// Ctrl+A: toggle all extensions
							const toggleable = exts.filter(e => !e.isSelf);
							const allEnabled = toggleable.every(e => desired.get(e.entryFile) ?? e.enabled);
							for (const ext of toggleable) {
								desired.set(ext.entryFile, !allEnabled);
							}
						} else if (data === "\x13") {
							// Ctrl+S: save & apply
							done("apply");
							return;
						}
						tui.requestRender();
					},

					invalidate() {},
				};

				return component;
			});

			// Esc / cancel: do nothing, no reload
			if (result !== "apply") {
				return;
			}

			// Apply pending toggles
			const { changed, errors } = applyToggles(exts, desired);
			restoreStalePiMcpStatusPatch(ctx);
			for (const err of errors) {
				ctx.ui.notify(`Failed to toggle: ${err}`, "error");
			}

			if (changed > 0) {
				ctx.ui.notify(
					`Updated ${changed} extension${changed === 1 ? "" : "s"}, reloading...`,
					"info",
				);
				// Fire-and-forget reload so the handler returns immediately and focus
				// is back on the editor before pi shows its "Reloading..." focus box.
				// Otherwise users press Esc a second time to dismiss what looks like
				// a stuck overlay (it isn't - the reload box just ignores Esc).
				void ctx.reload();
				return;
			}

			ctx.ui.notify("No changes.", "info");
		},
	});
}
