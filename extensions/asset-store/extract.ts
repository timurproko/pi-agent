import * as fs from "node:fs";
import * as path from "node:path";
import { tempDir } from "./platform";

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

function sanitizePackagePathname(pathname: string): string {
	let out = pathname.replace(/\0/g, "");
	if (process.platform === "win32") out = out.replace(/[>:"|?*]/g, "_");
	return out;
}

function isInside(parent: string, child: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

async function extractTarToTemp(packagePath: string, tmpDir: string): Promise<void> {
	let tar: any;
	try {
		tar = await import("tar");
	} catch {
		throw new Error("Install extension dependency: npm install in ~/.pi/agent/extensions/asset-store");
	}
	await tar.x({ file: packagePath, cwd: tmpDir, strict: false, preservePaths: false });
}

export async function extractUnityPackage(packagePath: string, outputPath: string, onProgress?: (progress: ExtractProgress) => void): Promise<ExtractResult> {
	const resolvedPackage = path.resolve(packagePath);
	const resolvedOutput = path.resolve(outputPath);
	fs.mkdirSync(resolvedOutput, { recursive: true });
	const tmpDir = tempDir("asset-store-unitypackage-");
	try {
		await extractTarToTemp(resolvedPackage, tmpDir);
		const items: Array<{ assetPath: string; outPath: string }> = [];
		for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const entryDir = path.join(tmpDir, entry.name);
			const pathnameFile = path.join(entryDir, "pathname");
			const assetFile = path.join(entryDir, "asset");
			if (!fs.existsSync(pathnameFile) || !fs.existsSync(assetFile)) continue;
			let pathname = fs.readFileSync(pathnameFile, "utf8");
			if (pathname.endsWith("\n")) pathname = pathname.slice(0, -1);
			pathname = sanitizePackagePathname(pathname);
			const outPath = path.resolve(resolvedOutput, pathname);
			if (!isInside(resolvedOutput, outPath)) continue;
			items.push({ assetPath: assetFile, outPath });
		}
		onProgress?.({ done: 0, total: items.length });
		let done = 0;
		for (const item of items) {
			fs.mkdirSync(path.dirname(item.outPath), { recursive: true });
			fs.renameSync(item.assetPath, item.outPath);
			done += 1;
			onProgress?.({ done, total: items.length });
		}
		return { ok: true, files: done, outputPath: resolvedOutput, message: `Extracting complete: ${done} success, 0 failed` };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, files: 0, outputPath: resolvedOutput, message: `Extraction failed: ${message}` };
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

export function getExtractRoot(downloadDir: string): string {
	return path.join(path.dirname(path.resolve(downloadDir)), "extracts");
}

export function listUnityPackages(downloadDir: string): string[] {
	if (!fs.existsSync(downloadDir)) return [];
	return fs.readdirSync(downloadDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".unitypackage"))
		.map((entry) => path.join(downloadDir, entry.name))
		.sort((a, b) => path.basename(a).toLowerCase().localeCompare(path.basename(b).toLowerCase()));
}
