import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface AssetStoreAccount {
	name: string;
	cookie: string;
	download_dir?: string;
}

export interface AssetStoreConfig {
	accounts: AssetStoreAccount[];
	active_account: string;
	max_workers?: number;
	retry?: number;
	timeout?: number;
	download_dir?: string;
	cookie?: string;
	[key: string]: unknown;
}

const EXTENSION_ROOT = path.dirname(fileURLToPath(import.meta.url));

export function extensionDataRoot(): string {
	return EXTENSION_ROOT;
}

export function configPathForCwd(_cwd: string): string {
	return path.join(extensionDataRoot(), "config.json");
}

export function normalizeCookieInput(cookie: unknown): string {
	let text = String(cookie ?? "").trim();
	if (text.toLowerCase().startsWith("cookie:")) {
		text = text.split(":", 2)[1]?.trim() ?? "";
	}
	return text.split(/\s+/).join(" ");
}

export function normalizeConfig(input: unknown): AssetStoreConfig {
	const raw = input && typeof input === "object" && !Array.isArray(input)
		? { ...(input as Record<string, unknown>) }
		: {};
	let accounts = Array.isArray(raw.accounts) ? raw.accounts : undefined;
	if (!accounts || accounts.length === 0) {
		accounts = [{ name: "Account 1", cookie: raw.cookie ?? "" }];
	}

	const cleaned: AssetStoreAccount[] = [];
	for (let i = 0; i < accounts.length; i += 1) {
		const account = accounts[i];
		if (!account || typeof account !== "object" || Array.isArray(account)) continue;
		const obj = account as Record<string, unknown>;
		const name = String(obj.name ?? "").trim() || `Account ${i + 1}`;
		const cookie = normalizeCookieInput(obj.cookie ?? "");
		const downloadDir = typeof obj.download_dir === "string" && obj.download_dir.trim()
			? obj.download_dir.trim()
			: undefined;
		const cleanedAccount: AssetStoreAccount = { name, cookie };
		if (downloadDir) cleanedAccount.download_dir = downloadDir;
		cleaned.push(cleanedAccount);
	}

	if (cleaned.length === 0) {
		cleaned.push({ name: "Account 1", cookie: normalizeCookieInput(raw.cookie ?? "") });
	}

	const names = cleaned.map((a) => a.name);
	const active = String(raw.active_account ?? "").trim();
	return {
		...raw,
		accounts: cleaned,
		active_account: active && names.includes(active) ? active : names[0]!,
	} as AssetStoreConfig;
}

export function loadConfig(configPath: string): AssetStoreConfig {
	if (!fs.existsSync(configPath)) {
		return normalizeConfig({ accounts: [{ name: "Account 1", cookie: "" }], active_account: "Account 1", max_workers: 3, retry: 3, timeout: 300 });
	}
	const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
	return normalizeConfig(raw);
}

export function saveConfig(config: AssetStoreConfig, configPath: string): void {
	const normalized = normalizeConfig(config);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
}

export function saveActiveAccount(activeAccount: string, configPath: string): void {
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch {
		raw = {};
	}
	raw.active_account = String(activeAccount || "").trim();
	saveConfig(normalizeConfig(raw), configPath);
}

export function saveActiveAccountCookie(config: AssetStoreConfig, cookie: string, configPath: string): void {
	const normalized = normalizeConfig(config);
	for (const account of normalized.accounts) {
		if (account.name === normalized.active_account) {
			account.cookie = normalizeCookieInput(cookie);
			break;
		}
	}
	saveConfig(normalized, configPath);
}

export function getActiveAccount(config: AssetStoreConfig): AssetStoreAccount {
	const normalized = normalizeConfig(config);
	return normalized.accounts.find((a) => a.name === normalized.active_account) ?? normalized.accounts[0]!;
}

export function getActiveCookie(config: AssetStoreConfig): string {
	return getActiveAccount(config).cookie || "";
}

export function getRetry(config: AssetStoreConfig): number {
	const retry = Number(config.retry ?? 3);
	return Number.isFinite(retry) && retry > 0 ? Math.floor(retry) : 3;
}

export function getTimeoutMs(config: AssetStoreConfig, fallbackSeconds = 60): number {
	const timeout = Number(config.timeout ?? fallbackSeconds);
	return (Number.isFinite(timeout) && timeout > 0 ? timeout : fallbackSeconds) * 1000;
}

export function getMaxWorkers(config: AssetStoreConfig): number {
	const value = Number(config.max_workers ?? 3);
	return Math.max(1, Math.min(12, Number.isFinite(value) ? Math.floor(value) : 3));
}

export function redactCookie(value: unknown): string {
	return String(value ?? "").replace(/cookie\s*:\s*[^\n\r]+/gi, "Cookie: [redacted]").replace(/(?:^|;\s*)([^=;\s]+)=([^;]+)/g, (_m, name) => `${name}=[redacted]`);
}
