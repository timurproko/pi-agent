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
import { getAgentDir, getSettingsListTheme, InteractiveMode, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";

interface ExtensionInfo {
	/** Display name (file name without extension or directory name). */
	name: string;
	/** "global" (~/.pi/agent/extensions) or "project" (<cwd>/.pi/extensions). */
	scope: "global" | "project";
	/** Absolute path to the entry file we toggle (single file, or index.ts inside dir). */
	entryFile: string;
	/** True if the entry file is currently active (no `.disabled` suffix). */
	enabled: boolean;
	/** True if this is the pi-extensions extension itself - never disable. */
	isSelf: boolean;
}

const SELF_DIRNAME = "pi-extensions";
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

function discoverInDir(dir: string, scope: "global" | "project"): ExtensionInfo[] {
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

		// Single-file extensions: foo.ts / foo.ts.disabled
		if (isFile && isExtensionFileName(entry.name)) {
			out.push({
				name: entry.name,
				scope,
				entryFile: entryPath,
				enabled: true,
				isSelf: false,
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
				isSelf: false,
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
	result.push(...discoverInDir(path.join(getAgentDir(), "extensions"), "global"));
	result.push(...discoverInDir(path.join(cwd, ".pi", "extensions"), "project"));
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

	// Clear the already-formatted bulb status left behind by pi-mcp. Then seed
	// the same plain status shape emitted by pi-mcp-adapter so the footer does
	// not continue to show stale bulbs until the adapter updates again.
	const total = readConfiguredMcpServerCount();
	ui.setStatus("mcp", total > 0 ? `MCP: 0/${total} servers` : undefined);
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
			const exts = discoverAll(ctx.cwd).filter((e) => !e.isSelf);

			if (exts.length === 0) {
				ctx.ui.notify("No extensions discovered.", "info");
				return;
			}

			// In-memory desired state, keyed by entryFile
			const desired = new Map<string, boolean>();
			for (const e of exts) desired.set(e.entryFile, e.enabled);

			const result = await ctx.ui.custom((tui, theme, kb, done) => {
				const items: SettingItem[] = exts.map((ext) => {
					const scopeTag = ext.scope === "global" ? "[global]" : "[project]";
					return {
						id: ext.entryFile,
						label: `${scopeTag} ${ext.name}`,
						currentValue: desired.get(ext.entryFile) ? "enabled" : "disabled",
						values: ["enabled", "disabled"],
					};
				});

				const container = new Container();

				// Top border + spacer + title (matches the built-in scoped-models layout)
				container.addChild(new DynamicBorder((s) => theme.fg("border", s)));
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(theme.fg("accent", theme.bold("Extensions")), 0, 0),
				);
				container.addChild(new Spacer(1));

				const list = new SettingsList(
					items,
					Math.min(items.length + 2, 20),
					getSettingsListTheme(),
					(id, newValue) => {
						desired.set(id, newValue === "enabled");
					},
					() => done("cancel"),
				);

				// Suppress the built-in "Enter/Space to change · Esc to cancel" hint.
				(list as unknown as { addHintLine: (lines: string[], width: number) => void }).addHintLine =
					() => {};

				container.addChild(list);
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							"enter apply & reload · space toggle · esc cancel",
						),
						0,
						0,
					),
				);
				container.addChild(new DynamicBorder((s) => theme.fg("border", s)));

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						// Enter applies & reloads; Esc (handled by list.onCancel) closes
						// without applying; Space (forwarded to list) cycles the value.
						if (kb.matches(data, "tui.select.confirm")) {
							done("apply");
							return;
						}
						list.handleInput?.(data);
						tui.requestRender();
					},
				};
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
