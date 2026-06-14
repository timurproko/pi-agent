import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { EditorModal, type EditorModalFilter, type EditorModalItem } from "../core/editor-ui";
import { configPathForCwd, getActiveAccount, loadConfig, normalizeCookieInput, saveActiveAccount, saveActiveAccountCookie, saveConfig, type AssetStoreConfig } from "./config";
import { desiredFilename, downloadAsset, prepareDownloadEnvironment, preCheckDownloads } from "./download";
import { extractUnityPackage, getExtractRoot, listUnityPackages } from "./extract";
import { barProgressLine, displayPath, formatSize, openFolder } from "./platform";
import { filterAssets, loadInfoMap, cleanDisplayName, accountDataPaths } from "./storage";
import { CookieInvalidError, runFetchList } from "./unity-api";
import { AssetIdInputDialog, chooseFromModal, clearProgressWidget, fixedWidthIdNameLabel, textPrompt } from "./ui";

const EXTENSION_NAME = "Asset Store";
const SETTINGS_COMMAND = "asset-store-settings";
const STATUS_KEY = "aaa-pi-plan-mode";

type AssetAction = "download" | "extract" | "open-downloads" | "settings";
type BrowserResult = { action: "asset"; accountName: string; assetId: string } | { action: "refresh"; accountName: string } | "cancel";
type SettingsCommandEvent = { args?: string; ctx?: ExtensionCommandContext; extensionName?: string; title?: string; shortcuts?: string; done?: () => void };

function notifyError(ctx: ExtensionCommandContext, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	if (message === "Download cancelled") {
		ctx.ui.notify(message, "warning");
		return;
	}
	if (err instanceof CookieInvalidError) {
		ctx.ui.notify(`${err.message}. Update it in Account settings > Enter cookie.`, "error");
		return;
	}
	ctx.ui.notify(message, "error");
}

function loadOrCreateConfig(ctx: ExtensionCommandContext): { config: AssetStoreConfig; configPath: string } {
	const configPath = configPathForCwd(ctx.cwd);
	const config = loadConfig(configPath);
	if (!fs.existsSync(configPath)) saveConfig(config, configPath);
	return { config, configPath };
}

function ensureExtensionSettingsFile(): void {
	const settingsPath = path.join(path.dirname(configPathForCwd(process.cwd())), "settings.json");
	let raw: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
	} catch {}
	if (raw.__settingsCommand === SETTINGS_COMMAND && fs.existsSync(settingsPath)) return;
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(settingsPath, JSON.stringify({ ...raw, __settingsCommand: SETTINGS_COMMAND }, null, 2) + "\n", "utf8");
}

function configForAccount(config: AssetStoreConfig, accountName: string): AssetStoreConfig {
	return { ...config, active_account: accountName };
}

function restoreBaseStatus(ctx: ExtensionCommandContext): void {
	ctx.ui.setStatus("asset-store", undefined);
	const mode = (globalThis as any).__piModeWorkflow?.getMode?.();
	const label = mode === "ask" ? "ask" : mode === "plan" ? "plan" : "cmd";
	const color = mode === "ask" ? "success" : mode === "plan" ? "accent" : "piPlanCmdMode";
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color as any, label));
	((globalThis as any).__piMcpsRefreshStatus ?? (globalThis as any).__piMcpRefreshStatus)?.();
}

function updateStatus(ctx: ExtensionCommandContext, config?: AssetStoreConfig, _phase?: string): void {
	if (!ctx.hasUI) return;
	if (!config) {
		restoreBaseStatus(ctx);
		return;
	}
	ctx.ui.setStatus("asset-store", undefined);
	ctx.ui.setStatus("mcp", undefined);
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "asset store"));
}

async function runWithProgress<T>(ctx: ExtensionCommandContext, title: string, work: (progress: (lines: string[], done?: number, total?: number) => void, signal: AbortSignal) => Promise<T>): Promise<T> {
	let progressLines = ["Starting..."];
	let latestDone = 0;
	let latestTotal = 1;
	const wrapped = await ctx.ui.custom<{ ok: true; value: T } | { ok: false; error: unknown }>((tui, theme, keybindings, done) => {
		let settled = false;
		const controller = new AbortController();
		const cancel = () => {
			if (settled) return;
			settled = true;
			controller.abort();
			clearProgressWidget(ctx);
			done({ ok: false, error: new Error("Download cancelled") });
		};
		const component = {
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.cancel")) cancel();
			},
			render(width: number) {
				const border = theme.fg("border", "─".repeat(Math.max(1, width)));
				const lines = [border, theme.fg("accent", theme.bold(title)), "", ...progressLines, "", theme.fg("dim", "Working... • Esc = cancel"), border];
				return lines.map((line) => truncateToWidth(line, width));
			},
			invalidate() {},
		};
		const progress = (lines: string[], doneCount = latestDone, total = latestTotal) => {
			progressLines = lines;
			latestDone = doneCount;
			latestTotal = total;
			tui.requestRender();
		};
		work(progress, controller.signal)
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

function assetItemsFromInfo(infoMap: Map<string, { name: string; size: number }>, ids: string[], _accountName: string): Array<EditorModalItem<string>> {
	return ids.map((pid) => {
		const info = infoMap.get(pid);
		const name = cleanDisplayName(info?.name ?? "") || pid;
		const size = info?.size ? formatSize(info.size) : "";
		return {
			value: pid,
			label: name,
			selectedDescription: size || undefined,
		};
	});
}

async function fetchLibraryForUi(ctx: ExtensionCommandContext, config: AssetStoreConfig): Promise<boolean> {
	return await runWithProgress(ctx, "Fetch assets", async (progress) => {
		return await runFetchList(config, ctx.cwd, (p) => {
			progress([p.message || (p.phase === "pages" ? "Fetching asset list" : p.phase === "details" ? "Fetching asset details" : "Fetching complete"), barProgressLine(p.done, p.total)], p.done, p.total);
		});
	});
}

async function fetchLibraryForAccountUi(ctx: ExtensionCommandContext, config: AssetStoreConfig, accountName: string): Promise<boolean> {
	return await fetchLibraryForUi(ctx, configForAccount(config, accountName));
}

async function ensureLibraryForAccountUi(ctx: ExtensionCommandContext, config: AssetStoreConfig, accountName: string): Promise<void> {
	const scoped = configForAccount(config, accountName);
	const { infoPath } = accountDataPaths(scoped, ctx.cwd);
	if (loadInfoMap(infoPath).size > 0) return;
	await fetchLibraryForAccountUi(ctx, config, accountName);
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
		const result = await runWithProgress(ctx, "Download assets", async (progress, signal) => {
			return await downloadAsset(aid, config, env, {
				totalSize: infoMap.get(aid)?.size ?? 0,
				desiredFilename: filename,
				signal,
				onProgress: (p) => progress([`Asset: ${filename}`, p.line], p.totalSize ? p.downloaded : 0, p.totalSize || 1),
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
	items.push({ value: ".", label: "Open Downloads folder", description: packages.length === 0 ? "No .unitypackage files in download folder" : undefined });
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

function findDownloadedPackageForAsset(env: { downloadDir: string }, assetId: string, infoMap: Map<string, { name: string; size: number }>): string | undefined {
	const desired = desiredFilename(assetId, infoMap);
	const desiredPath = path.join(env.downloadDir, desired);
	if (fs.existsSync(desiredPath)) return desiredPath;
	const name = cleanDisplayName(infoMap.get(assetId)?.name ?? "").toLowerCase();
	for (const pkg of listUnityPackages(env.downloadDir)) {
		const base = path.basename(pkg).toLowerCase();
		if (base === desired.toLowerCase() || base.includes(assetId) || (name && base.includes(name))) return pkg;
	}
	return undefined;
}

async function runDownloadForAsset(ctx: ExtensionCommandContext, config: AssetStoreConfig, assetId: string): Promise<void> {
	const env = prepareDownloadEnvironment(config, ctx.cwd);
	const { infoPath } = accountDataPaths(config, ctx.cwd);
	const infoMap = loadInfoMap(infoPath);
	const { skipped, pending } = preCheckDownloads([assetId], env, infoMap);
	if (skipped.length > 0) {
		ctx.ui.notify("File exists, downloading skipped", "info");
		return;
	}
	const aid = pending[0];
	if (!aid) return;
	const filename = desiredFilename(aid, infoMap);
	const result = await runWithProgress(ctx, "Download asset", async (progress, signal) => {
		return await downloadAsset(aid, config, env, {
			totalSize: infoMap.get(aid)?.size ?? 0,
			desiredFilename: filename,
			signal,
			onProgress: (p) => progress([`Asset: ${filename}`, p.line], p.totalSize ? p.downloaded : 0, p.totalSize || 1),
		});
	});
	const downloadedSize = result.size ? formatSize(result.size) : "0 B";
	ctx.ui.notify(result.ok ? `Download complete: ${downloadedSize}, 1 success, 0 failed` : result.message, result.ok ? "info" : "error");
}

async function runExtractForAsset(ctx: ExtensionCommandContext, config: AssetStoreConfig, assetId: string): Promise<void> {
	const env = prepareDownloadEnvironment(config, ctx.cwd);
	const { infoPath } = accountDataPaths(config, ctx.cwd);
	const infoMap = loadInfoMap(infoPath);
	const pkgPath = findDownloadedPackageForAsset(env, assetId, infoMap);
	if (!pkgPath) {
		ctx.ui.notify("No downloaded .unitypackage found for this asset. Download it first.", "warning");
		return;
	}
	const extractRoot = getExtractRoot(env.downloadDir);
	const outDir = path.join(extractRoot, path.basename(pkgPath, path.extname(pkgPath)));
	const result = await runWithProgress(ctx, "Extract asset", async (progress) => {
		return await extractUnityPackage(pkgPath, outDir, (p) => progress([`Directory: ${displayPath(extractRoot, ctx.cwd)}`, `Asset: ${path.basename(pkgPath)}`, barProgressLine(p.done, p.total, "Files")], p.done, p.total || 1));
	});
	ctx.ui.notify(result.message, result.ok ? "info" : "error");
}

async function assetActions(ctx: ExtensionCommandContext, accountName: string, assetId: string): Promise<boolean> {
	const { config } = loadOrCreateConfig(ctx);
	const scoped = configForAccount(config, accountName);
	updateStatus(ctx, scoped, "actions");
	const { infoPath } = accountDataPaths(scoped, ctx.cwd);
	const infoMap = loadInfoMap(infoPath);
	const info = infoMap.get(assetId);
	const env = prepareDownloadEnvironment(scoped, ctx.cwd);
	const action = await chooseFromModal<AssetAction>(ctx, {
		title: `Actions for "${cleanDisplayName(info?.name ?? assetId)}"`,
		items: [
			{ value: "download", label: "Download", description: displayPath(env.downloadDir, ctx.cwd) },
			{ value: "extract", label: "Extract", description: displayPath(getExtractRoot(env.downloadDir), ctx.cwd) },
			{ value: "open-downloads", label: "Open Downloads folder" },
			{ value: "settings", label: "Account settings" },
		],
		shortcuts: "↑↓ navigate • enter select • esc back",
	});
	if (!action) return false;
	try {
		if (action === "download") await runDownloadForAsset(ctx, scoped, assetId);
		else if (action === "extract") await runExtractForAsset(ctx, scoped, assetId);
		else if (action === "open-downloads") openFolder(env.downloadDir);
		else if (action === "settings") await accountSettings(ctx);
	} catch (err) {
		notifyError(ctx, err);
	} finally {
		clearProgressWidget(ctx);
	}
	return action === "settings";
}

async function assetBrowser(ctx: ExtensionCommandContext): Promise<void> {
	let { config } = loadOrCreateConfig(ctx);
	let activeAccount = getActiveAccount(config).name;
	let activeAssetId: string | undefined;
	try {
		await ensureLibraryForAccountUi(ctx, config, activeAccount);
	} catch (err) {
		notifyError(ctx, err);
	}

	while (true) {
		config = loadConfig(configPathForCwd(ctx.cwd));
		if (!config.accounts.some((account) => account.name === activeAccount)) activeAccount = getActiveAccount(config).name;
		updateStatus(ctx, configForAccount(config, activeAccount));
		const cache = new Map<string, Map<string, { name: string; size: number }>>();
		const getInfoMap = (accountName: string) => {
			let infoMap = cache.get(accountName);
			if (!infoMap) {
				infoMap = loadInfoMap(accountDataPaths(configForAccount(config, accountName), ctx.cwd).infoPath);
				cache.set(accountName, infoMap);
			}
			return infoMap;
		};
		const filters: Array<EditorModalFilter<string>> | undefined = config.accounts.length > 1
			? config.accounts.map((account) => ({ value: account.name, label: account.name }))
			: undefined;
		const result = await ctx.ui.custom<BrowserResult>((tui, theme, keybindings, done) => new EditorModal<string, string>({
			tui,
			theme,
			keybindings,
			title: "Unity Asset Store",
			subtitle: undefined,
			filters,
			initialFilter: activeAccount,
			initialSelectedValue: activeAssetId,
			search: true,
			maxVisible: 12,
			shortcuts: `type to search • ↑↓ navigate${filters ? " • tab account" : ""} • enter actions • ctrl+r refresh • esc close`,
			noItemsText: (query) => query.trim() ? "No matching assets" : "No assets cached. Press ctrl+r to fetch this account.",
			descriptionGap: 4,
			getItems: (filter, query = "") => {
				const accountName = filter ?? activeAccount;
				const infoMap = getInfoMap(accountName);
				return assetItemsFromInfo(infoMap, filterAssets(infoMap, query), accountName);
			},
			onSelect: (item, filter) => done({ action: "asset", accountName: filter ?? activeAccount, assetId: item.value }),
			onCancel: () => done("cancel"),
			onFilterChange: (filter) => { activeAccount = filter; },
			onInput: (data, filter, selectedItem) => {
				if (data === "\x12") {
					done({ action: "refresh", accountName: filter ?? activeAccount });
					return true;
				}
				activeAssetId = selectedItem?.value ?? activeAssetId;
				return false;
			},
		}));
		if (result === "cancel") break;
		if (result.action === "refresh") {
			try {
				await fetchLibraryForAccountUi(ctx, config, result.accountName);
				activeAccount = result.accountName;
				activeAssetId = undefined;
			} catch (err) {
				notifyError(ctx, err);
			} finally {
				clearProgressWidget(ctx);
			}
			continue;
		}
		activeAccount = result.accountName;
		activeAssetId = result.assetId;
		const shouldReload = await assetActions(ctx, result.accountName, result.assetId);
		if (shouldReload) activeAssetId = result.assetId;
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
		description: "Extract one downloaded .unitypackage from the active account download_dir into the Downloads folder.",
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

function isSettingsCommandEvent(data: unknown): data is SettingsCommandEvent {
	if (!data || typeof data !== "object") return false;
	const ctx = (data as SettingsCommandEvent).ctx;
	return !!ctx?.ui && typeof ctx.ui.custom === "function";
}

export default function assetStoreDownloader(pi: ExtensionAPI) {
	ensureExtensionSettingsFile();
	(pi as unknown as { events: { on: (event: string, handler: (data: unknown) => void) => void } }).events.on(`command-settings:${SETTINGS_COMMAND}`, (data: unknown) => {
		if (!isSettingsCommandEvent(data) || !data.ctx) return;
		void accountSettings(data.ctx).finally(() => data.done?.());
	});
	pi.registerCommand("asset-store", {
		description: "Unity Asset Store downloader",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/asset-store requires interactive TUI mode", "error");
				return;
			}
			await assetBrowser(ctx);
		},
	});
	registerTools(pi);
}
