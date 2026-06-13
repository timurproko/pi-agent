import * as fs from "node:fs";
import * as path from "node:path";
import type { AssetStoreConfig } from "./config";
import { getActiveCookie, getMaxWorkers, getRetry, getTimeoutMs } from "./config";
import { accountDataPaths, appendJsonLine, appendTextLine, extractProductIdsFromList, loadExistingDetailIds, loadExistingList } from "./storage";

export const GRAPHQL_URL = "https://assetstore.unity.com/api/graphql/batch";
export const DOWNLOAD_URL = "https://assetstore.unity.com/api/downloads";

const COMMON_HEADERS: Record<string, string> = {
	"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
	accept: "application/json, text/plain, */*",
	"accept-language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-CN;q=0.6,ja;q=0.5",
	origin: "https://assetstore.unity.com",
	referer: "https://assetstore.unity.com/",
	"sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
	"sec-ch-ua-mobile": "?0",
	"sec-ch-ua-platform": '"Windows"',
	"sec-fetch-dest": "empty",
	"sec-fetch-mode": "cors",
	"sec-fetch-site": "same-origin",
	dnt: "1",
	"x-requested-with": "XMLHttpRequest",
	"x-source": "storefront",
};

export const SEARCH_QUERY = `query SearchMyAssets($page: Int, $pageSize: Int, $q: [String], $tagging: [String!], $assignFrom: [String!], $ids: [String!], $sortBy: Int, $reverse: Boolean, $other: String) {
  searchMyAssets(page: $page, pageSize: $pageSize, q: $q, tagging: $tagging, assignFrom: $assignFrom, ids: $ids, sortBy: $sortBy, reverse: $reverse, other: $other) {
    results {
      id
      orderId
      grantTime
      tagging
      assignFrom
      product {
        id
        productId
        itemId
        name
        mainImage {
          icon75
          icon
          __typename
        }
        publisher {
          id
          name
          __typename
        }
        publishNotes
        state
        currentVersion {
          name
          publishedDate
          __typename
        }
        downloadSize
        __typename
      }
      __typename
    }
    organizations
    total
    category {
      name
      count
      __typename
    }
    publisherSuggest {
      name
      count
      __typename
    }
    __typename
  }
}
`;

export const PRODUCT_QUERY = `query Product($id: ID!) {
  product(id: $id) {
    ...product
    packageInListHotness
    reviews(rows: 2, sortBy: "rating") {
      ...reviews
      __typename
    }
    __typename
  }
}

fragment product on Product {
  id
  productId
  itemId
  slug
  name
  description
  aiDescription
  elevatorPitch
  keyFeatures
  compatibilityInfo
  customLicense
  rating {
    average
    count
    __typename
  }
  currentVersion {
    id
    name
    publishedDate
    __typename
  }
  reviewCount
  downloadSize
  assetCount
  publisher {
    id
    name
    url
    supportUrl
    supportEmail
    gaAccount
    gaPrefix
    __typename
  }
  userOverview {
    lastDownloadAt: last_downloaded_at
    __typename
  }
  mainImage {
    big
    facebook
    small
    icon
    icon75
    __typename
  }
  originalPrice {
    itemId
    originalPrice
    finalPrice
    isFree
    discount {
      save
      percentage
      type
      saleType
      __typename
    }
    currency
    entitlementType
    __typename
  }
  images {
    type
    imageUrl
    thumbnailUrl
    __typename
  }
  category {
    id
    name
    slug
    longName
    __typename
  }
  firstPublishedDate
  publishNotes
  supportedUnityVersions
  state
  overlay
  overlayText
  plusProSale
  licenseText
  vspProperties {
    ... on ExternalVSPProduct {
      externalLink
      __typename
    }
    __typename
  }
  __typename
}

fragment reviews on Reviews {
  count
  canRate: can_rate
  canReply: can_reply
  canComment: can_comment
  hasCommented: has_commented
  totalEntries: total_entries
  lastPage: last_page
  comments {
    id
    date
    editable
    rating
    user {
      id
      name
      profileUrl
      avatar
      __typename
    }
    isHelpful: is_helpful {
      count
      score
      __typename
    }
    subject
    version
    full
    is_complimentary
    vote
    replies {
      id
      editable
      date
      version
      full
      user {
        id
        name
        profileUrl
        avatar
        __typename
      }
      isHelpful: is_helpful {
        count
        score
        __typename
      }
      __typename
    }
    __typename
  }
  __typename
}
`;

export class CookieInvalidError extends Error {
	constructor(message = "Cookie expired or invalid") {
		super(message);
		this.name = "CookieInvalidError";
	}
}

export interface FetchProgress {
	phase: "pages" | "details" | "complete";
	done: number;
	total: number;
	message?: string;
}

export function extractCsrf(cookie: string): string {
	const text = String(cookie || "");
	for (const name of ["_csrf", "__Host-next-auth.csrf-token", "__Secure-next-auth.csrf-token", "next-auth.csrf-token"]) {
		const re = new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]+)`);
		const match = text.match(re);
		if (match) {
			try {
				return decodeURIComponent(match[1]!).split("|", 1)[0] ?? "";
			} catch {
				return match[1]!.split("|", 1)[0] ?? "";
			}
		}
	}
	return "";
}

export function makeGraphqlHeaders(config: AssetStoreConfig, operations: string): Record<string, string> {
	const cookie = getActiveCookie(config);
	return {
		...COMMON_HEADERS,
		"content-type": "application/json;charset=UTF-8",
		cookie,
		"x-csrf-token": extractCsrf(cookie),
		operations,
	};
}

export function makeDownloadHeaders(config: AssetStoreConfig): Record<string, string> {
	const headers: Record<string, string> = {
		...COMMON_HEADERS,
		accept: "*/*",
		cookie: getActiveCookie(config),
		"accept-encoding": "gzip, deflate, br, zstd",
	};
	for (const key of ["content-type", "origin", "x-requested-with", "x-source", "dnt"]) delete headers[key];
	return headers;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		if (signal) {
			const abort = () => { clearTimeout(t); reject(new Error("Aborted")); };
			if (signal.aborted) abort();
			signal.addEventListener("abort", abort, { once: true });
		}
	});
}

export async function requestWithRetry(url: string, init: RequestInit, config: AssetStoreConfig, signal?: AbortSignal): Promise<Response> {
	const retry = getRetry(config);
	let lastError: unknown;
	for (let attempt = 1; attempt <= retry; attempt += 1) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), getTimeoutMs(config));
		const abort = () => controller.abort();
		if (signal) signal.addEventListener("abort", abort, { once: true });
		try {
			const resp = await fetch(url, { ...init, signal: controller.signal });
			if (resp.status === 400 || resp.status === 401 || resp.status === 403 || (url === GRAPHQL_URL && resp.status >= 500)) {
				let detail = "";
				try {
					detail = (await resp.clone().text()).replace(/\s+/g, " ").trim().slice(0, 160);
				} catch {}
				throw new CookieInvalidError(detail ? `Cookie expired or invalid (HTTP ${resp.status}: ${detail})` : `Cookie expired or invalid (HTTP ${resp.status})`);
			}
			if (resp.status >= 500 && attempt < retry) {
				await sleep(2 ** attempt * 1000, signal);
				continue;
			}
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			return resp;
		} catch (err) {
			if (err instanceof CookieInvalidError) throw err;
			lastError = err;
			if (attempt < retry) {
				await sleep(2 ** attempt * 1000, signal);
				continue;
			}
			throw err;
		} finally {
			clearTimeout(timeout);
			if (signal) signal.removeEventListener("abort", abort);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchAssetListPage(config: AssetStoreConfig, page: number, pageSize = 100, signal?: AbortSignal): Promise<any> {
	const payload = [{ query: SEARCH_QUERY, variables: { page, pageSize, q: [], tagging: [], ids: [], assignFrom: [], sortBy: 7 }, operationName: "SearchMyAssets" }];
	const resp = await requestWithRetry(GRAPHQL_URL, { method: "POST", headers: makeGraphqlHeaders(config, "SearchMyAssets"), body: JSON.stringify(payload) }, config, signal);
	return await resp.json();
}

export async function fetchProductDetails(config: AssetStoreConfig, productIds: string[], signal?: AbortSignal): Promise<any[]> {
	if (productIds.length === 0) return [];
	const payload = productIds.map((id) => ({ query: PRODUCT_QUERY, variables: { id }, operationName: "Product" }));
	const resp = await requestWithRetry(GRAPHQL_URL, { method: "POST", headers: makeGraphqlHeaders(config, productIds.map(() => "Product").join(",")), body: JSON.stringify(payload) }, config, signal);
	return await resp.json();
}

async function promisePool<T, R>(items: T[], workers: number, task: (item: T, index: number) => Promise<R>): Promise<Array<R | undefined>> {
	const results: Array<R | undefined> = new Array(items.length);
	let next = 0;
	const run = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await task(items[index]!, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(workers, items.length) }, run));
	return results;
}

export async function runFetchList(config: AssetStoreConfig, cwd: string, onProgress?: (progress: FetchProgress) => void, signal?: AbortSignal): Promise<boolean> {
	const pageSize = 100;
	const detailBatchSize = 100;
	const { listPath, infoPath, idsPath } = accountDataPaths(config, cwd);
	const maxWorkers = getMaxWorkers(config);
	const existingPages = loadExistingList(listPath);

	if (!existingPages.has(0)) {
		const first = await fetchAssetListPage(config, 0, pageSize, signal);
		const record = { ...first?.[0]?.data?.searchMyAssets, page: 0 };
		appendJsonLine(listPath, record);
		existingPages.set(0, record);
	}

	const total = Number(existingPages.get(0)?.total ?? 0) || 0;
	const totalPages = Math.ceil(total / pageSize);
	const missingPages = Array.from({ length: totalPages }, (_v, i) => i).filter((p) => !existingPages.has(p));
	const estTotalBatches = total ? Math.ceil(total / detailBatchSize) : 0;
	const progressTotal = Math.max(totalPages + estTotalBatches, 1);
	onProgress?.({ phase: "pages", done: existingPages.size, total: progressTotal });

	await promisePool(missingPages, maxWorkers, async (page) => {
		const data = await fetchAssetListPage(config, page, pageSize, signal);
		const record = { ...data?.[0]?.data?.searchMyAssets, page };
		appendJsonLine(listPath, record);
		existingPages.set(page, record);
		onProgress?.({ phase: "pages", done: existingPages.size, total: progressTotal });
		return record;
	});

	const stillMissing = Array.from({ length: totalPages }, (_v, i) => i).filter((p) => !existingPages.has(p));
	if (stillMissing.length > 0) {
		onProgress?.({ phase: "complete", done: existingPages.size, total: progressTotal, message: `${stillMissing.length} pages still missing` });
		return false;
	}

	const allProductIds = extractProductIdsFromList(existingPages);
	const alreadyFetched = loadExistingDetailIds(infoPath);
	const pendingIds = allProductIds.filter((pid) => !alreadyFetched.has(pid));
	if (pendingIds.length === 0) {
		onProgress?.({ phase: "complete", done: progressTotal, total: progressTotal, message: `Fetching complete: ${allProductIds.length} success, 0 failed` });
		return true;
	}

	const existingIdsFile = new Set<string>();
	if (fs.existsSync(idsPath)) {
		for (const line of fs.readFileSync(idsPath, "utf8").split(/\r?\n/)) if (line.trim() && !line.startsWith("#")) existingIdsFile.add(line.trim());
	}
	for (const id of alreadyFetched) existingIdsFile.add(id);

	const batches: string[][] = [];
	for (let i = 0; i < pendingIds.length; i += detailBatchSize) batches.push(pendingIds.slice(i, i + detailBatchSize));
	let progressDone = existingPages.size;
	let infoCount = 0;
	onProgress?.({ phase: "details", done: progressDone, total: progressTotal });
	await promisePool(batches, maxWorkers, async (batch) => {
		const details = await fetchProductDetails(config, batch, signal);
		for (const item of details) {
			const product = item?.data?.product;
			if (!product) continue;
			appendJsonLine(infoPath, product);
			const pid = String(product.id ?? "");
			if (pid && !existingIdsFile.has(pid)) {
				appendTextLine(idsPath, pid);
				existingIdsFile.add(pid);
			}
			infoCount += 1;
		}
		progressDone += 1;
		onProgress?.({ phase: "details", done: progressDone, total: progressTotal });
		return true;
	});
	const failedDetails = pendingIds.length - infoCount;
	onProgress?.({ phase: "complete", done: progressTotal, total: progressTotal, message: `Fetching complete: ${alreadyFetched.size + infoCount} success, ${failedDetails} failed` });
	return failedDetails === 0;
}

export function parseFilename(response: Response, assetId: string): string {
	const cd = response.headers.get("content-disposition") ?? "";
	const quoted = cd.match(/filename="(.+?)"/);
	if (quoted) return decodeURIComponent(quoted[1]!);
	const utf8 = cd.match(/filename\*=UTF-8''(.+)/);
	if (utf8) return decodeURIComponent(utf8[1]!);
	return `${assetId}.unitypackage`;
}

export function downloadUrl(assetId: string): string {
	return `${DOWNLOAD_URL}/${assetId}`;
}
