import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tar from "tar";
import { configPathForCwd, extensionDataRoot, normalizeConfig, normalizeCookieInput } from "../config.ts";
import { extractUnityPackage } from "../extract.ts";
import { formatSize, resolveDownloadDir, safePackageFilename } from "../platform.ts";
import { accountDataPaths, safeAccountSlug, filterAssets } from "../storage.ts";
import { extractCsrf } from "../unity-api.ts";

test("normalizes legacy config and cookies", () => {
	const cfg = normalizeConfig({ cookie: " Cookie: a=1;  b=2 ", max_workers: 5 });
	assert.equal(cfg.accounts.length, 1);
	assert.equal(cfg.accounts[0].name, "Account 1");
	assert.equal(cfg.accounts[0].cookie, "a=1; b=2");
	assert.equal(cfg.active_account, "Account 1");
	assert.equal(cfg.max_workers, 5);
	assert.equal(normalizeCookieInput("Cookie: x=1;   y=2"), "x=1; y=2");
});

test("normalizes account names and active account", () => {
	const cfg = normalizeConfig({ accounts: [{ name: "", cookie: "" }, { name: "Work", cookie: "c=3", download_dir: " ./dl " }], active_account: "missing" });
	assert.equal(cfg.accounts[0].name, "Account 1");
	assert.equal(cfg.accounts[1].download_dir, "./dl");
	assert.equal(cfg.active_account, "Account 1");
});

test("extracts csrf token variants", () => {
	assert.equal(extractCsrf("a=1; _csrf=abc%7Cdef; b=2"), "abc");
	assert.equal(extractCsrf("__Secure-next-auth.csrf-token=tok%7C123"), "tok");
	assert.equal(extractCsrf("none=1"), "");
});

test("safe filename parity", () => {
	assert.equal(safePackageFilename("CON", "123"), "CON_123.unitypackage");
	assert.equal(safePackageFilename("Bad/File:Name?.unitypackage", "9"), "Bad_File_Name_.unitypackage");
	assert.equal(safePackageFilename("   ", "9"), "9.unitypackage");
	assert.equal(safePackageFilename("A".repeat(300), "1").length, 220 + ".unitypackage".length);
});

test("slug, size and search helpers", () => {
	assert.equal(safeAccountSlug("My Account!!"), "my_account");
	assert.equal(safeAccountSlug("---"), "account");
	assert.equal(formatSize(1024), "1.0 KB");
	const info = new Map([["20", { name: "Tree Pack", size: 10 }], ["3", { name: "Water FX", size: 20 }]]);
	assert.deepEqual(filterAssets(info, ""), ["3", "20"]);
	assert.deepEqual(filterAssets(info, "tree"), ["20"]);
	assert.deepEqual(filterAssets(info, "3"), ["3"]);
});

test("extension data stores are rooted in the extension folder", () => {
	const cfg = normalizeConfig({ accounts: [{ name: "Personal", cookie: "", download_dir: "./custom-downloads" }], active_account: "Personal" });
	const root = extensionDataRoot();
	assert.equal(configPathForCwd("/tmp/other"), path.join(root, "config.json"));
	assert.equal(accountDataPaths(cfg, "/tmp/other").infoPath, path.join(root, "data", "asset_info.personal.jsonl"));
	assert.equal(resolveDownloadDir(cfg, "/tmp/other"), path.join(root, "custom-downloads"));
	assert.equal(resolveDownloadDir(normalizeConfig({ accounts: [{ name: "Personal", cookie: "" }], active_account: "Personal" }), "/tmp/other"), path.join(root, "downloads"));
});

test("extracts unitypackage safely and skips traversal", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asd-test-"));
	const src = path.join(tmp, "src");
	fs.mkdirSync(path.join(src, "good"), { recursive: true });
	fs.writeFileSync(path.join(src, "good", "pathname"), "Assets/Good.txt\n");
	fs.writeFileSync(path.join(src, "good", "asset"), "ok");
	fs.mkdirSync(path.join(src, "bad"), { recursive: true });
	fs.writeFileSync(path.join(src, "bad", "pathname"), "../evil.txt\n");
	fs.writeFileSync(path.join(src, "bad", "asset"), "bad");
	const pkg = path.join(tmp, "fixture.unitypackage");
	await tar.c({ gzip: true, cwd: src, file: pkg }, ["good", "bad"]);
	const out = path.join(tmp, "out");
	const result = await extractUnityPackage(pkg, out);
	assert.equal(result.ok, true);
	assert.equal(result.files, 1);
	assert.equal(fs.readFileSync(path.join(out, "Assets", "Good.txt"), "utf8"), "ok");
	assert.equal(fs.existsSync(path.join(tmp, "evil.txt")), false);
	fs.rmSync(tmp, { recursive: true, force: true });
});
