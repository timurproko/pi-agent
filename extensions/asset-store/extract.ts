import * as fs from "node:fs";
import * as path from "node:path";
import { barProgressLine, downloadProgressLine, tempDir } from "./platform";

export interface ExtractProgress {
	done: number;
	total: number;
	message?: string;
}

export interface ExtractResult {
	ok: boolean;
	files: number;
	outputPath: string;
	message: string;
}

function readPackagePathname(rawPathname: string): string {
	return rawPathname.replace(/\0/g, "").split(/\r?\n/, 1)[0] ?? "";
}

function sanitizePackagePathname(pathname: string): string {
	const normalized = readPackagePathname(pathname)
		.replace(/\\/g, "/");
	const parts = normalized.split("/").map((part) => {
		let out = part.replace(/[\x00-\x1f]/g, "_");
		if (process.platform === "win32") {
			out = out.replace(/[<>:"|?*]/g, "_").replace(/[ .]+$/g, "");
		}
		return out;
	}).filter((part) => part && part !== ".");
	return parts.join(path.sep);
}

function isInside(parent: string, child: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function isUnsafePackagePathname(pathname: string): boolean {
	const normalized = readPackagePathname(pathname).replace(/\\/g, "/");
	if (path.isAbsolute(normalized) || /^[a-z]:\//i.test(normalized)) return true;
	return normalized.split("/").some((part) => part === "..");
}

async function extractTarToTemp(packagePath: string, tmpDir: string, onProgress?: (progress: ExtractProgress) => void): Promise<void> {
	let tar: any;
	try {
		tar = await import("tar");
	} catch {
		throw new Error("Install extension dependency: npm install in ~/.pi/agent/extensions/asset-store");
	}
	const total = fs.statSync(packagePath).size;
	let done = 0;
	let lastRender = 0;
	const start = Date.now();
	onProgress?.({ done: 0, total: total || 1, message: downloadProgressLine(0, total, 0) });
	const input = fs.createReadStream(packagePath);
	const extractor = tar.x({ cwd: tmpDir, strict: false, preservePaths: false });
	input.on("data", (chunk: Buffer) => {
		done += chunk.length;
		const now = Date.now();
		if (now - lastRender >= 150) {
			lastRender = now;
			const elapsed = Math.max(0.001, (now - start) / 1000);
			const speed = done / elapsed;
			onProgress?.({ done, total: total || 1, message: downloadProgressLine(done, total, speed) });
		}
	});
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			err ? reject(err) : resolve();
		};
		input.on("error", finish);
		extractor.on("error", finish);
		extractor.on("finish", () => finish());
		extractor.on("close", () => finish());
		input.pipe(extractor);
	});
	const elapsed = Math.max(0.001, (Date.now() - start) / 1000);
	onProgress?.({ done: total || done, total: total || done || 1, message: downloadProgressLine(total || done, total || done, done / elapsed, true) });
}

export async function extractUnityPackage(packagePath: string, outputPath: string, onProgress?: (progress: ExtractProgress) => void): Promise<ExtractResult> {
	const resolvedPackage = path.resolve(packagePath);
	const resolvedOutput = path.resolve(outputPath);
	fs.mkdirSync(resolvedOutput, { recursive: true });
	const tmpDir = tempDir("asset-store-unitypackage-");
	try {
		await extractTarToTemp(resolvedPackage, tmpDir, onProgress);
		const items: Array<{ assetPath: string; outPath: string }> = [];
		for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const entryDir = path.join(tmpDir, entry.name);
			const pathnameFile = path.join(entryDir, "pathname");
			const assetFile = path.join(entryDir, "asset");
			if (!fs.existsSync(pathnameFile) || !fs.existsSync(assetFile)) continue;
			let pathname = fs.readFileSync(pathnameFile, "utf8");
			if (isUnsafePackagePathname(pathname)) continue;
			pathname = sanitizePackagePathname(pathname);
			const outPath = path.resolve(resolvedOutput, pathname);
			if (!isInside(resolvedOutput, outPath)) continue;
			items.push({ assetPath: assetFile, outPath });
		}
		onProgress?.({ done: 0, total: items.length || 1, message: barProgressLine(0, items.length || 1, "Files") });
		let done = 0;
		let failed = 0;
		for (const item of items) {
			try {
				fs.mkdirSync(path.dirname(item.outPath), { recursive: true });
				fs.copyFileSync(item.assetPath, item.outPath);
				done += 1;
			} catch {
				failed += 1;
			}
			onProgress?.({ done: done + failed, total: items.length || 1, message: barProgressLine(done + failed, items.length || 1, "Files") });
		}
		return { ok: failed === 0, files: done, outputPath: resolvedOutput, message: `Extracting complete: ${done} success, ${failed} failed` };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, files: 0, outputPath: resolvedOutput, message: `Extraction failed: ${message}` };
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

export function getExtractRoot(downloadDir: string): string {
	return path.resolve(downloadDir);
}

export function listUnityPackages(downloadDir: string): string[] {
	if (!fs.existsSync(downloadDir)) return [];
	return fs.readdirSync(downloadDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".unitypackage"))
		.map((entry) => path.join(downloadDir, entry.name))
		.sort((a, b) => path.basename(a).toLowerCase().localeCompare(path.basename(b).toLowerCase()));
}
