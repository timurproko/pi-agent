import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { configPathForCwd, getActiveAccount, loadConfig, normalizeCookieInput, saveActiveAccount, saveActiveAccountCookie, saveConfig, type AssetStoreConfig } from "./config";
import { desiredFilename, downloadAsset, prepareDownloadEnvironment, preCheckDownloads } from "./download";
import { extractUnityPackage, getExtractRoot, listUnityPackages } from "./extract";
import { barProgressLine, displayPath, formatSize, openFolder } from "./platform";
import { filterAssets, loadInfoMap, cleanDisplayName, accountDataPaths } from "./storage";
import { CookieInvalidError, runFetchList } from "./unity-api";
import { AssetIdInputDialog, chooseFromModal, clearProgressWidget, fixedWidthIdNameLabel, setProgressWidget, textPrompt } from "./ui";

const EXTENSION_NAME = "Asset Store";

type MainAction = "account" | "search" | "download" | "extract";

function notifyError(ctx: ExtensionCommandContext, err: unknown): void {
	if (err instanceof CookieInvalidError) {
		ctx.ui.notify(`${err.message}. Update it in Account settings > Enter cookie.`, "error");
		return;
	}
	ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
}

function loadOrCreateConfig(ctx: ExtensionCommandContext): { config: AssetStoreConfig; configPath: string } {
	const configPath = configPathForCwd(ctx.cwd);
	const config = loadConfig(configPath);
	if (!fs.existsSync(configPath)) saveConfig(config, configPath);
	return { config, configPath };
}

function updateStatus(ctx: ExtensionCommandContext, config?: AssetStoreConfig, phase?: string): void {
	if (!ctx.hasUI) return;
	if (!config) {
		ctx.ui.setStatus("asset-store", undefined);
		return;
	}
	const active = getActiveAccount(config).name;
	ctx.ui.setStatus("asset-store", ctx.ui.theme.fg("accent", `asset:${active}${phase ? ` ${phase}` : ""}`));
}

async function runWithProgress<T>(ctx: ExtensionCommandContext, title: string, work: (progress: (lines: string[], done?: number, total?: number) => void) => Promise<T>): Promise<T> {
	let progressLines = ["Starting..."];
	let latestDone = 0;
	let latestTotal = 1;
	const wrapped = await ctx.ui.custom<{ ok: true; value: T } | { ok: false; error: unknown }>((tui, theme, keybindings, done) => {
		let settled = false;
		const component = {
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.cancel")) {
					// UI-only cancellation; underlying task may finish quickly. AbortSignal support is handled by individual functions where passed.
				}
			},
			render(width: number) {
				const border = theme.fg("border", "─".repeat(Math.max(1, width)));
				const lines = [border, theme.fg("accent", theme.bold(title)), "", ...progressLines, "", theme.fg("dim", "Working..."), border];
				return lines.map((line) => truncateToWidth(line, width));
			},
			invalidate() {},
		};
		const progress = (lines: string[], doneCount = latestDone, total = latestTotal) => {
			progressLines = lines;
			latestDone = doneCount;
			latestTotal = total;
			setProgressWidget(ctx, title, doneCount, total, lines[0]);
			tui.requestRender();
		};
		work(progress)
			.then((result) => { if (!settled) { settled = true; clearProgressWidget(ctx); done({ ok: true, value: result }); } })
			.catch((error) => { if (!settled) { settled = true; clearProgressWidget(ctx); done({ ok: false, error }); } });
		return component;
	});
	if (wrapped.ok) return wrapped.value;
	throw (wrapped as { ok: false; error: unknown }).error;
}

async function accountSettings(ctx: ExtensionCommandContext): Promise<void> {
	let { config, configPath } = loadOrCreateConfig(ctx);
	while (true) {
		updateStatus(ctx, config, "settings");
		const active = getActiveAccount(config).name;
		const action = await chooseFromModal<"switch" | "cookie" | "open-config">(ctx, {
			title: "Account settings",
			subtitle: `Active account: ${active}`,
			items: [
				{ value: "switch", label: "Switch account", description: config.accounts.length > 1 ? active : "only one account" },
				{ value: "cookie", label: "Enter cookie", description: "paste Cookie header for active account" },
				{ value: "open-config", label: "Show config path", description: displayPath(configPath, ctx.cwd) },
			],
			shortcuts: "↑↓ navigate • enter select • esc back",
		});
		if (!action) return;
		if (action === "switch") {
			const selected = await chooseFromModal<string>(ctx, {
				title: "Switch account",
				items: config.accounts.map((account) => ({ value: account.name, label: account.name, description: account.name === config.active_account ? "(active)" : undefined, checked: account.name === config.active_account })),
				shortcuts: "↑↓ navigate • enter select • esc back",
			});
			if (selected && selected !== config.active_account) {
				saveActiveAccount(selected, configPath);
				config = loadConfig(configPath);
				ctx.ui.notify(`Active account: ${selected}`, "info");
			}
		} else if (action === "cookie") {
			const cookie = await textPrompt(ctx, `Enter cookie for ${active} account`, "Paste raw Cookie header or full 'Cookie: ...' header. Cookie is saved to config.json and not stored in the Pi session.");
			if (cookie && cookie.trim()) {
				saveActiveAccountCookie(config, cookie, configPath);
				config = loadConfig(configPath);
				ctx.ui.notify(`Cookie saved for ${active} account`, "info");
			}
		} else if (action === "open-config") {
			ctx.ui.notify(`Config: ${configPath}`, "info");
		}
	}
}

function resultItemsFromInfo(infoMap: Map<string, { name: string; size: number }>, ids: string[]) {
	return ids.map((pid) => ({
		value: pid,
		label: fixedWidthIdNameLabel(pid, cleanDisplayName(infoMap.get(pid)?.name ?? "")),
		description: infoMap.get(pid)?.size ? formatSize(infoMap.get(pid)!.size) : undefined,
	}));
}

async function fetchLibraryForUi(ctx: ExtensionCommandContext, config: AssetStoreConfig): Promise<boolean> {
	return await runWithProgress(ctx, "Fetch assets", async (progress) => {
		return await runFetchList(config, ctx.cwd, (p) => {
			progress([p.message || (p.phase === "pages" ? "Fetching asset list" : p.phase === "details" ? "Fetching asset details" : "Fetching complete"), barProgressLine(p.done, p.total)], p.done, p.total);
		});
	});
}

async function searchAssets(ctx: ExtensionCommandContext): Promise<void> {
	const { config } = loadOrCreateConfig(ctx);
	updateStatus(ctx, config, "search");
	try {
		await fetchLibraryForUi(ctx, config);
		const { infoPath } = accountDataPaths(config, ctx.cwd);
		const infoMap = loadInfoMap(infoPath);
		if (infoMap.size === 0) {
			ctx.ui.notify("No asset details in asset_info.jsonl. Check your cookie or try again.", "warning");
			return;
		}
		const selected = await ctx.ui.custom<{ id?: string; query: string } | undefined>((tui, theme, keybindings, done) => {
			return new (class {
				private query = "";
				private selected = 0;
				private get ids() { return filterAssets(infoMap, this.query); }
				handleInput(data: string) {
					if (keybindings.matches(data, "tui.select.cancel")) return done(undefined);
					if (data === "\r" || data === "\n") return done({ id: this.ids[this.selected], query: this.query });
					if (data === "\x1b[A") this.selected = Math.max(0, this.selected - 1);
					else if (data === "\x1b[B") this.selected = Math.min(Math.max(0, this.ids.length - 1), this.selected + 1);
					else if (data === "\x7f" || data === "\b") { this.query = this.query.slice(0, -1); this.selected = 0; }
					else if (data.length === 1 && data.charCodeAt(0) >= 32) { this.query += data; this.selected = 0; }
					tui.requestRender();
				}
				render(width: number) {
					const ids = this.ids;
					this.selected = Math.min(this.selected, Math.max(0, ids.length - 1));
					const lines = [theme.fg("border", "─".repeat(width)), theme.fg("accent", theme.bold(`Search assets (${ids.length})`)), "", `Query: ${this.query || theme.fg("dim", "<empty = full list>")}`, ""];
					const visible = ids.slice(Math.max(0, this.selected - 6), Math.max(0, this.selected - 6) + 12);
					const start = Math.max(0, this.selected - 6);
					for (let i = 0; i < visible.length; i += 1) {
						const pid = visible[i]!;
						const text = fixedWidthIdNameLabel(pid, cleanDisplayName(infoMap.get(pid)?.name ?? ""));
						lines.push((start + i === this.selected ? theme.fg("accent", "→ ") : "  ") + text);
					}
					if (ids.length === 0) lines.push(theme.fg("muted", "  No assets match your search."));
					lines.push("", theme.fg("dim", "type to search • ↑↓ navigate • enter close • esc back"), theme.fg("border", "─".repeat(width)));
					return lines.map((l) => truncateToWidth(l, width));
				}
				invalidate() {}
			})();
		});
		if (selected?.id) {
			const info = infoMap.get(selected.id);
			ctx.ui.notify(`${selected.id} ${info?.name ?? ""}`, "info");
		}
	} catch (err) {
		notifyError(ctx, err);
	} finally {
		clearProgressWidget(ctx);
	}
}

async function downloadAssets(ctx: ExtensionCommandContext): Promise<void> {
	const { config } = loadOrCreateConfig(ctx);
	updateStatus(ctx, config, "download");
	const env = prepareDownloadEnvironment(config, ctx.cwd);
	const raw = await ctx.ui.custom<string | undefined>((_tui, theme, _keybindings, done) => new AssetIdInputDialog(theme, "Download assets", [`Directory: ${displayPath(env.downloadDir, ctx.cwd)}`, "Enter asset ID to start downloading"], done));
	if (!raw) return;
	if (raw === ".") {
		openFolder(env.downloadDir);
		return;
	}
	if (!/^\d+$/.test(raw)) return;
	const { infoPath } = accountDataPaths(config, ctx.cwd);
	const infoMap = loadInfoMap(infoPath);
	const { skipped, pending } = preCheckDownloads([raw], env, infoMap);
	if (skipped.length > 0) {
		ctx.ui.notify("File exists, downloading skipped", "info");
		return;
	}
	if (pending.length === 0) return;
	const aid = pending[0]!;
	const filename = desiredFilename(aid, infoMap);
	try {
		const result = await runWithProgress(ctx, "Download assets", async (progress) => {
			return await downloadAsset(aid, config, env, {
				totalSize: infoMap.get(aid)?.size ?? 0,
				desiredFilename: filename,
				onProgress: (p) => progress([`Directory: ${displayPath(env.downloadDir, ctx.cwd)}`, `Asset: ${filename}`, p.line], p.totalSize ? p.downloaded : 0, p.totalSize || 1),
			});
		});
		const downloadedSize = result.size ? formatSize(result.size) : "0 B";
		ctx.ui.notify(result.ok ? `Download complete: ${downloadedSize}, 1 success, 0 failed` : `Download complete: 0 B, 0 success, 1 failed`, result.ok ? "info" : "error");
	} catch (err) {
		notifyError(ctx, err);
	} finally {
		clearProgressWidget(ctx);
	}
}

async function extractAssets(ctx: ExtensionCommandContext): Promise<void> {
	const { config } = loadOrCreateConfig(ctx);
	updateStatus(ctx, config, "extract");
	const env = prepareDownloadEnvironment(config, ctx.cwd);
	const extractRoot = getExtractRoot(env.downloadDir);
	const packages = listUnityPackages(env.downloadDir);
	const items: Array<{ value: string; label: string; description?: string }> = packages.map((pkg, i) => ({ value: pkg, label: `${i + 1}. ${path.basename(pkg)}` }));
	items.push({ value: ".", label: "Open extracts folder", description: packages.length === 0 ? "No .unitypackage files in download folder" : undefined });
	const selected = await chooseFromModal<string>(ctx, {
		title: "Extract assets",
		subtitle: `Directory: ${displayPath(extractRoot, ctx.cwd)}`,
		items,
		shortcuts: "↑↓ navigate • enter select • esc back",
		noItemsText: "No .unitypackage files in the download folder.",
	});
	if (!selected) return;
	if (selected === ".") {
		openFolder(extractRoot);
		return;
	}
	const outDir = path.join(extractRoot, path.basename(selected, path.extname(selected)));
	try {
		const result = await runWithProgress(ctx, "Extract assets", async (progress) => {
			return await extractUnityPackage(selected, outDir, (p) => progress([`Directory: ${displayPath(extractRoot, ctx.cwd)}`, `Asset: ${path.basename(selected)}`, barProgressLine(p.done, p.total, "Files")], p.done, p.total || 1));
		});
		ctx.ui.notify(result.message, result.ok ? "info" : "error");
	} catch (err) {
		notifyError(ctx, err);
	} finally {
		clearProgressWidget(ctx);
	}
}

async function mainMenu(ctx: ExtensionCommandContext): Promise<void> {
	let { config } = loadOrCreateConfig(ctx);
	while (true) {
		updateStatus(ctx, config);
		const choice = await chooseFromModal<MainAction>(ctx, {
			title: "Unity asset store downloader",
			subtitle: `Active account: ${getActiveAccount(config).name}`,
			items: [
				{ value: "account", label: "1. Account settings" },
				{ value: "search", label: "2. Search assets" },
				{ value: "download", label: "3. Download assets" },
				{ value: "extract", label: "4. Extract assets" },
			],
			shortcuts: "↑↓ navigate • enter select • esc exit",
		});
		if (!choice) break;
		if (choice === "account") await accountSettings(ctx);
		else if (choice === "search") await searchAssets(ctx);
		else if (choice === "download") await downloadAssets(ctx);
		else if (choice === "extract") await extractAssets(ctx);
		config = loadConfig(configPathForCwd(ctx.cwd));
	}
	updateStatus(ctx, undefined);
}

function registerTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "asset_store_search",
		label: "Asset Store Search",
		description: "Fetch/resume Unity Asset Store library data and search owned assets by id or name. Does not expose cookies.",
		promptSnippet: "Search the configured Unity Asset Store account library by id or name",
		promptGuidelines: ["Use asset_store_search when the user asks to search their Unity Asset Store purchased library."],
		parameters: Type.Object({ query: Type.Optional(Type.String({ description: "Substring to search; empty lists all fetched assets" })) }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const configPath = configPathForCwd(ctx.cwd);
			const config = loadConfig(configPath);
			await runFetchList(config, ctx.cwd, undefined, signal);
			const { infoPath } = accountDataPaths(config, ctx.cwd);
			const infoMap = loadInfoMap(infoPath);
			const ids = filterAssets(infoMap, params.query ?? "");
			const lines = resultItemsFromInfo(infoMap, ids).slice(0, 50).map((item) => item.label);
			return { content: [{ type: "text", text: `Found ${ids.length} assets${ids.length > 50 ? " (showing first 50)" : ""}\n${lines.join("\n")}` }], details: { count: ids.length, ids: ids.slice(0, 200) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("asset_store_search ")) + theme.fg("muted", args.query ?? "<all>"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "✓ ") + theme.fg("muted", String(result.content[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "Done")), 0, 0); },
	});

	pi.registerTool({
		name: "asset_store_download",
		label: "Asset Store Download",
		description: "Download one Unity Asset Store .unitypackage by numeric asset id using configured account cookie. Does not expose cookies.",
		promptSnippet: "Download a Unity Asset Store package by asset id",
		promptGuidelines: ["Use asset_store_download when the user asks to download a specific Unity Asset Store asset id."],
		parameters: Type.Object({ assetId: Type.String({ description: "Numeric Unity Asset Store product id" }) }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!/^\d+$/.test(params.assetId)) throw new Error("assetId must be numeric");
			const config = loadConfig(configPathForCwd(ctx.cwd));
			const env = prepareDownloadEnvironment(config, ctx.cwd);
			const { infoPath } = accountDataPaths(config, ctx.cwd);
			const infoMap = loadInfoMap(infoPath);
			const { skipped, pending } = preCheckDownloads([params.assetId], env, infoMap);
			if (skipped.length) return { content: [{ type: "text", text: "File exists, downloading skipped" }], details: { ok: true, skipped: true, filename: skipped[0]![1] } };
			const filename = desiredFilename(params.assetId, infoMap);
			const result = await downloadAsset(pending[0]!, config, env, { desiredFilename: filename, totalSize: infoMap.get(params.assetId)?.size ?? 0, signal });
			return { content: [{ type: "text", text: result.ok ? `Download complete: ${result.filename ?? filename}` : result.message }], details: { ok: result.ok, filename: result.filename, size: result.size } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("asset_store_download ")) + theme.fg("accent", args.assetId), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg((result.details as any)?.ok ? "success" : "error", (result.details as any)?.ok ? "✓ Downloaded" : "Download failed"), 0, 0); },
	});

	pi.registerTool({
		name: "asset_store_extract",
		label: "Asset Store Extract",
		description: "Extract one downloaded .unitypackage from the active account download_dir into the sibling extracts folder.",
		promptSnippet: "Extract a downloaded Unity .unitypackage safely",
		promptGuidelines: ["Use asset_store_extract when the user asks to unpack a downloaded Unity .unitypackage."],
		parameters: Type.Object({ packageName: Type.String({ description: "Downloaded .unitypackage filename or absolute path" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const config = loadConfig(configPathForCwd(ctx.cwd));
			const env = prepareDownloadEnvironment(config, ctx.cwd);
			const pkgPath = path.isAbsolute(params.packageName) ? params.packageName : path.join(env.downloadDir, params.packageName);
			const extractRoot = getExtractRoot(env.downloadDir);
			const outDir = path.join(extractRoot, path.basename(pkgPath, path.extname(pkgPath)));
			const result = await extractUnityPackage(pkgPath, outDir);
			return { content: [{ type: "text", text: result.message }], details: { ok: result.ok, files: result.files, outputPath: result.outputPath } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("asset_store_extract ")) + theme.fg("muted", args.packageName), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg((result.details as any)?.ok ? "success" : "error", result.content[0]?.type === "text" ? result.content[0].text : "Done"), 0, 0); },
	});
}

export default function assetStoreDownloader(pi: ExtensionAPI) {
	pi.registerCommand("asset-store", {
		description: "Unity Asset Store downloader",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/asset-store requires interactive TUI mode", "error");
				return;
			}
			await mainMenu(ctx);
		},
	});
	registerTools(pi);
}
