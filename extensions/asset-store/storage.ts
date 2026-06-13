import * as fs from "node:fs";
import * as path from "node:path";
import { extensionDataRoot, type AssetStoreConfig } from "./config";

export interface ProductInfo {
	name: string;
	size: number;
}

export interface AccountDataPaths {
	listPath: string;
	infoPath: string;
	idsPath: string;
}

export function safeAccountSlug(name: string): string {
	const slug = String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return slug || "account";
}

export function accountDataPaths(config: AssetStoreConfig, _cwd: string): AccountDataPaths {
	const slug = safeAccountSlug(config.active_account || "");
	const dataDir = path.join(extensionDataRoot(), "data");
	fs.mkdirSync(dataDir, { recursive: true });
	return {
		listPath: path.join(dataDir, `asset_list.${slug}.jsonl`),
		infoPath: path.join(dataDir, `asset_info.${slug}.jsonl`),
		idsPath: path.join(dataDir, `asset_ids.${slug}.txt`),
	};
}

export function loadExistingList(listPath: string): Map<number, any> {
	const pages = new Map<number, any>();
	if (!fs.existsSync(listPath)) return pages;
	for (const line of fs.readFileSync(listPath, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const obj = JSON.parse(trimmed);
			if (typeof obj.page === "number") pages.set(obj.page, obj);
		} catch {
			// Match JSONL resume semantics: ignore corrupt/partial blank-adjacent rows.
		}
	}
	return pages;
}

export function loadExistingDetailIds(infoPath: string): Set<string> {
	const ids = new Set<string>();
	if (!fs.existsSync(infoPath)) return ids;
	for (const line of fs.readFileSync(infoPath, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const obj = JSON.parse(trimmed);
			const id = String(obj.id ?? "");
			if (id) ids.add(id);
		} catch {}
	}
	return ids;
}

export function extractProductIdsFromList(existingPages: Map<number, any>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const pageNum of [...existingPages.keys()].sort((a, b) => a - b)) {
		const page = existingPages.get(pageNum);
		for (const item of page?.results ?? []) {
			const id = String(item?.product?.id ?? "");
			if (!id || seen.has(id)) continue;
			seen.add(id);
			result.push(id);
		}
	}
	return result;
}

export function loadInfoMap(infoPath: string): Map<string, ProductInfo> {
	const info = new Map<string, ProductInfo>();
	if (!fs.existsSync(infoPath)) return info;
	for (const line of fs.readFileSync(infoPath, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const product = JSON.parse(trimmed);
			const id = String(product.id ?? "");
			if (!id) continue;
			info.set(id, { name: String(product.name ?? ""), size: Number(product.downloadSize ?? 0) || 0 });
		} catch {}
	}
	return info;
}

export function appendJsonLine(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf8");
}

export function appendTextLine(file: string, value: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, value + "\n", "utf8");
}

export function cleanDisplayName(name: string): string {
	return String(name || "").replace(/\s+/g, " ").trim();
}

export function filterAssets(infoMap: Map<string, ProductInfo>, query: string): string[] {
	const needle = query.trim().toLowerCase();
	const ids = [...infoMap.keys()];
	const sortKey = (pid: string): [number, number | string] => /^\d+$/.test(pid) ? [0, Number(pid)] : [1, pid];
	const sorted = ids.sort((a, b) => {
		const ak = sortKey(a);
		const bk = sortKey(b);
		return ak[0] - bk[0] || (ak[1] < bk[1] ? -1 : ak[1] > bk[1] ? 1 : 0);
	});
	if (!needle) return sorted;
	return sorted.filter((pid) => pid.toLowerCase().includes(needle) || (infoMap.get(pid)?.name ?? "").toLowerCase().includes(needle));
}
