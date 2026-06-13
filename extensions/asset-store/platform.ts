import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssetStoreConfig } from "./config";
import { extensionDataRoot, getActiveAccount } from "./config";

export function formatSize(n: number): string {
	const value = Number(n) || 0;
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
	return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatEta(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) return "--:--";
	let s = Math.floor(seconds);
	const h = Math.floor(s / 3600);
	s %= 3600;
	const m = Math.floor(s / 60);
	s %= 60;
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function barProgressLine(done: number, total: number, unit = ""): string {
	const safeTotal = Math.max(0, Math.floor(total || 0));
	const safeDone = Math.max(0, Math.floor(done || 0));
	const pct = safeTotal <= 0 ? 0 : Math.min(Math.floor((safeDone * 100) / safeTotal), 100);
	const barLen = 25;
	const filled = Math.floor((barLen * pct) / 100);
	const suffix = unit ? ` ${unit}` : "";
	return `${"█".repeat(filled)}${"░".repeat(barLen - filled)} ${String(pct).padStart(3)}%  ${safeDone}/${safeTotal}${suffix}`;
}

export function downloadProgressLine(downloaded: number, totalSize: number, speed: number, finished = false): string {
	let actualDownloaded = Math.max(0, downloaded || 0);
	if (finished && totalSize > 0 && actualDownloaded < totalSize) actualDownloaded = totalSize;
	if (totalSize > 0) {
		const pct = Math.min(Math.floor((actualDownloaded * 100) / totalSize), 100);
		const barLen = 25;
		const filled = Math.floor((barLen * pct) / 100);
		const eta = speed > 0 ? formatEta((totalSize - actualDownloaded) / speed) : "--:--";
		return `${"█".repeat(filled)}${"░".repeat(barLen - filled)} ${String(pct).padStart(3)}%  ${formatSize(actualDownloaded)}/${formatSize(totalSize)}  ${formatSize(speed)}/s  ETA ${eta}`;
	}
	return `Downloaded ${formatSize(actualDownloaded)}  ${formatSize(speed)}/s`;
}

export function safePackageFilename(assetName: string, assetId: string): string {
	let name = String(assetName || "").trim();
	if (name.toLowerCase().endsWith(".unitypackage")) name = name.slice(0, -".unitypackage".length);
	if (!name) name = String(assetId);
	name = name.replace(/[\\/]/g, "_");
	name = name.replace(/[\x00-\x1f<>:"|?*]/g, "_");
	name = name.replace(/\s+/g, " ").trim().replace(/[ .]+$/g, "");
	if (!name) name = String(assetId);
	if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) name = `${name}_${assetId}`;
	return `${name.slice(0, 220)}.unitypackage`;
}

export function resolveDownloadDir(config: AssetStoreConfig, _cwd: string): string {
	const account = getActiveAccount(config);
	const configured = account.download_dir || config.download_dir || "./downloads";
	return path.isAbsolute(configured) ? configured : path.resolve(extensionDataRoot(), configured);
}

export function displayPath(target: string, cwd: string): string {
	const resolved = path.resolve(target);
	const base = path.resolve(cwd);
	const rel = path.relative(base, resolved);
	if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return `/${rel.split(path.sep).join("/")}`;
	return resolved.split(path.sep).join("/");
}

function isWsl(): boolean {
	if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
	try {
		return fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
	} catch {
		return false;
	}
}

function detached(command: string, args: string[]): void {
	const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
	child.unref();
}

export function openFolder(target: string): void {
	fs.mkdirSync(target, { recursive: true });
	const resolved = path.resolve(target);
	if (process.platform === "win32") {
		detached("cmd.exe", ["/c", "start", "", resolved]);
		return;
	}
	if (process.platform === "darwin") {
		detached("open", [resolved]);
		return;
	}
	for (const opener of ["xdg-open", "wslview"]) {
		try {
			detached(opener, [resolved]);
			return;
		} catch {}
	}
	if (isWsl()) {
		const explorer = "/mnt/c/Windows/explorer.exe";
		if (fs.existsSync(explorer)) {
			const child = spawn("wslpath", ["-w", resolved], { stdio: ["ignore", "pipe", "ignore"] });
			let out = "";
			child.stdout.on("data", (d) => { out += String(d); });
			child.on("close", () => {
				const win = out.trim();
				if (win) detached(explorer, [win]);
			});
		}
	}
}

export function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
