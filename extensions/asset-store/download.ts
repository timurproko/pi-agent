import * as fs from "node:fs";
import * as path from "node:path";
import type { AssetStoreConfig } from "./config";
import { extensionDataRoot, getActiveAccount, getRetry, getTimeoutMs } from "./config";
import { displayPath, downloadProgressLine, formatSize, resolveDownloadDir, safePackageFilename } from "./platform";
import type { ProductInfo } from "./storage";
import { makeDownloadHeaders, parseFilename, downloadUrl } from "./unity-api";

export interface DownloadEnvironment {
	downloadDir: string;
	cacheDir: string;
}

export interface DownloadProgress {
	downloaded: number;
	totalSize: number;
	speed: number;
	line: string;
	finished?: boolean;
}

export interface DownloadResult {
	assetId: string;
	ok: boolean;
	message: string;
	filename?: string;
	size?: number;
}

function safeCacheSlug(name: string): string {
	const slug = String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return slug || "account";
}

function removeLegacyDownloadCache(downloadDir: string, cacheDir: string): void {
	const legacyCacheDir = path.join(downloadDir, ".cache");
	if (fs.existsSync(legacyCacheDir)) {
		for (const entry of fs.readdirSync(legacyCacheDir)) {
			if (!entry.endsWith(".meta")) continue;
			const oldPath = path.join(legacyCacheDir, entry);
			const newPath = path.join(cacheDir, entry);
			if (!fs.existsSync(newPath)) fs.renameSync(oldPath, newPath);
		}
		fs.rmSync(legacyCacheDir, { recursive: true, force: true });
	}
}

export function prepareDownloadEnvironment(config: AssetStoreConfig, cwd: string): DownloadEnvironment {
	const downloadDir = resolveDownloadDir(config, cwd);
	fs.mkdirSync(downloadDir, { recursive: true });
	const cacheDir = path.join(extensionDataRoot(), "data", "download-cache", safeCacheSlug(getActiveAccount(config).name));
	fs.mkdirSync(cacheDir, { recursive: true });
	removeLegacyDownloadCache(downloadDir, cacheDir);
	for (const entry of fs.readdirSync(downloadDir)) {
		if (!/^\..+\.meta$/.test(entry)) continue;
		const oldPath = path.join(downloadDir, entry);
		const newPath = path.join(cacheDir, entry.slice(1));
		if (!fs.existsSync(newPath)) fs.renameSync(oldPath, newPath);
		else fs.rmSync(oldPath, { force: true });
	}
	return { downloadDir, cacheDir };
}

function desiredFilenameForAsset(assetId: string, infoMap: Map<string, ProductInfo>): string {
	return safePackageFilename(infoMap.get(assetId)?.name ?? "", assetId);
}

function readMeta(metaPath: string): { filename?: string } {
	try {
		return JSON.parse(fs.readFileSync(metaPath, "utf8"));
	} catch {
		return {};
	}
}

function writeMeta(metaPath: string, filename: string): void {
	fs.mkdirSync(path.dirname(metaPath), { recursive: true });
	fs.writeFileSync(metaPath, JSON.stringify({ filename }) + "\n", "utf8");
}

export function preCheckDownloads(assetIds: string[], env: DownloadEnvironment, infoMap: Map<string, ProductInfo>): { skipped: Array<[string, string]>; pending: string[] } {
	const localFiles = new Map<string, string>();
	for (const entry of fs.readdirSync(env.downloadDir, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.toLowerCase().endsWith(".unitypackage")) localFiles.set(entry.name.toLowerCase(), path.join(env.downloadDir, entry.name));
	}
	const skipped: Array<[string, string]> = [];
	const pending: string[] = [];
	for (const aid of assetIds) {
		const metaPath = path.join(env.cacheDir, `${aid}.meta`);
		const desired = desiredFilenameForAsset(aid, infoMap);
		const meta = fs.existsSync(metaPath) ? readMeta(metaPath) : {};
		const cached = meta.filename;
		if (cached) {
			const filepath = path.join(env.downloadDir, cached);
			if (fs.existsSync(filepath)) {
				if (cached !== desired) {
					const desiredPath = path.join(env.downloadDir, desired);
					if (!fs.existsSync(desiredPath)) fs.renameSync(filepath, desiredPath);
					writeMeta(metaPath, desired);
					skipped.push([aid, desired]);
				} else {
					skipped.push([aid, cached]);
				}
				continue;
			}
		}
		const info = infoMap.get(aid);
		if (info?.name) {
			const exact = localFiles.get(desired.toLowerCase());
			if (exact) {
				writeMeta(metaPath, path.basename(exact));
				skipped.push([aid, path.basename(exact)]);
				continue;
			}
			const lowerName = info.name.toLowerCase();
			let matched: string | undefined;
			for (const [fnameLower, fpath] of localFiles) {
				if (fnameLower.includes(lowerName)) {
					matched = path.basename(fpath);
					break;
				}
			}
			if (matched) {
				writeMeta(metaPath, matched);
				skipped.push([aid, matched]);
				continue;
			}
		}
		pending.push(aid);
	}
	return { skipped, pending };
}

export function displayDownloadSummary(downloadDir: string, cwd: string, assetName: string, line: string): string[] {
	return [`Directory: ${displayPath(downloadDir, cwd)}`, assetName, line];
}

export async function downloadAsset(
	assetId: string,
	config: AssetStoreConfig,
	env: DownloadEnvironment,
	options: {
		totalSize?: number;
		desiredFilename?: string;
		signal?: AbortSignal;
		onProgress?: (progress: DownloadProgress) => void;
	} = {},
): Promise<DownloadResult> {
	const headers = makeDownloadHeaders(config);
	const retry = getRetry(config);
	const timeoutMs = getTimeoutMs(config, 300);
	const metaPath = path.join(env.cacheDir, `${assetId}.meta`);
	for (let attempt = 1; attempt <= retry; attempt += 1) {
		try {
			let tmpPath: string | undefined;
			let resumedBytes = 0;
			const requestHeaders: Record<string, string> = { ...headers };
			const meta = fs.existsSync(metaPath) ? readMeta(metaPath) : {};
			if (meta.filename) {
				tmpPath = path.join(env.downloadDir, `${meta.filename}.tmp`);
				if (fs.existsSync(tmpPath)) resumedBytes = fs.statSync(tmpPath).size;
			}
			if (resumedBytes > 0) requestHeaders.Range = `bytes=${resumedBytes}-`;

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			const abort = () => controller.abort();
			options.signal?.addEventListener("abort", abort, { once: true });
			let resp: Response;
			try {
				resp = await fetch(downloadUrl(assetId), { headers: requestHeaders, signal: controller.signal });
			} finally {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
			}

			if (resp.status === 401) return { assetId, ok: false, message: "Cookie expired or invalid" };
			if (resp.status === 403) return { assetId, ok: false, message: "No permission to download (403)" };
			if (resp.status === 404) return { assetId, ok: false, message: "Resource not found (404)" };
			if (resp.status === 416) {
				const filename = options.desiredFilename || parseFilename(resp, assetId);
				const finalPath = path.join(env.downloadDir, filename);
				if (tmpPath && fs.existsSync(tmpPath)) {
					fs.renameSync(tmpPath, finalPath);
					writeMeta(metaPath, filename);
					return { assetId, ok: true, filename, message: `Resume complete (full): ${filename}`, size: fs.statSync(finalPath).size };
				}
			}
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

			const filename = options.desiredFilename || parseFilename(resp, assetId);
			const finalPath = path.join(env.downloadDir, filename);
			writeMeta(metaPath, filename);
			if (fs.existsSync(finalPath)) return { assetId, ok: true, filename, message: "File exists, downloading skipped", size: fs.statSync(finalPath).size };
			tmpPath = path.join(env.downloadDir, `${filename}.tmp`);
			const isResumed = resp.status === 206;
			if (!isResumed) resumedBytes = 0;

			let effectiveTotal = options.totalSize || 0;
			const contentRange = resp.headers.get("content-range") ?? "";
			const rangeTotal = contentRange.match(/\/(\d+)/)?.[1];
			if (!effectiveTotal && rangeTotal) effectiveTotal = Number(rangeTotal) || 0;
			const cl = resp.headers.get("content-length");
			if (!effectiveTotal && cl) effectiveTotal = (Number(cl) || 0) + resumedBytes;

			let downloaded = resumedBytes;
			const start = Date.now();
			let lastRender = 0;
			const stream = fs.createWriteStream(tmpPath, { flags: isResumed ? "a" : "w" });
			if (!resp.body) throw new Error("Download response has no body");
			for await (const chunk of resp.body as any as AsyncIterable<Uint8Array>) {
				stream.write(Buffer.from(chunk));
				downloaded += chunk.length;
				const elapsed = Math.max(0.001, (Date.now() - start) / 1000);
				const speed = (downloaded - resumedBytes) / elapsed;
				const now = Date.now();
				if (now - lastRender >= 150) {
					lastRender = now;
					options.onProgress?.({ downloaded, totalSize: effectiveTotal, speed, line: downloadProgressLine(downloaded, effectiveTotal, speed) });
				}
			}
			await new Promise<void>((resolve, reject) => stream.end((err?: Error) => err ? reject(err) : resolve()));
			const elapsed = Math.max(0.001, (Date.now() - start) / 1000);
			const speed = (downloaded - resumedBytes) / elapsed;
			options.onProgress?.({ downloaded, totalSize: effectiveTotal, speed, line: downloadProgressLine(downloaded, effectiveTotal, speed, true), finished: true });
			fs.renameSync(tmpPath, finalPath);
			return { assetId, ok: true, filename, size: downloaded, message: `Done${isResumed ? " (resumed)" : ""}: ${filename} (${formatSize(downloaded)})` };
		} catch (err) {
			if (options.signal?.aborted) return { assetId, ok: false, message: "Download cancelled" };
			if (attempt < retry) {
				await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
				continue;
			}
			const message = err instanceof Error ? err.message : String(err);
			return { assetId, ok: false, message: `Failed (retried ${retry} times): ${message}` };
		}
	}
	return { assetId, ok: false, message: "Unknown error" };
}

export function desiredFilename(assetId: string, infoMap: Map<string, ProductInfo>): string {
	return desiredFilenameForAsset(assetId, infoMap);
}
