/**
 * 📋 pi-paste — Smart paste extension for Pi.
 *
 * Intercepts Ctrl+V pastes in the terminal and automatically handles
 * images, folder paths, file paths, URLs, and Houdini node paths —
 * inserting compact tags into your draft and expanding them on send.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { chainEditor } from "./_editor-chain.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

type PasteContext = ExtensionContext | ExtensionCommandContext;

interface ClipboardImage {
  bytes: Uint8Array;
  mimeType: string;
}

interface ClipboardModule {
  hasImage: () => boolean;
  getImageBinary: () => Promise<Array<number> | Uint8Array>;
}

interface PendingImage {
  type: "image";
  tag: string;
  data: string;
  mimeType: string;
}

interface PendingFolder {
  tag: string;
  fullPath: string;
}

interface PendingFile {
  tag: string;
  fullPath: string;
}

interface PendingUrl {
  tag: string;
  url: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Unknown error";
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

// ─── PowerShell ──────────────────────────────────────────────────────────────

interface PowerShellCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  missingCommand: boolean;
  reason?: string;
}

interface RunPowerShellCommandOptions {
  args?: string[];
  encoded?: boolean;
  maxBuffer: number;
  sta?: boolean;
  timeout: number;
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runPowerShellCommand(
  script: string,
  options: RunPowerShellCommandOptions,
): PowerShellCommandResult {
  if (process.platform !== "win32") {
    return { ok: false, stdout: "", stderr: "", missingCommand: false, reason: "PowerShell only on Windows." };
  }
  const commandArgs = [
    "-NoProfile", "-NonInteractive",
    ...(options.sta ? ["-STA"] : []),
    ...(options.encoded ? ["-EncodedCommand", encodePowerShell(script)] : ["-Command", script]),
    ...(options.args ?? []),
  ];
  const result = spawnSync("powershell.exe", commandArgs, {
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: true,
  });
  if (result.error) {
    return {
      ok: false, stdout: result.stdout ?? "", stderr: result.stderr ?? "",
      missingCommand: isErrnoException(result.error) && result.error.code === "ENOENT",
      reason: getErrorMessage(result.error),
    };
  }
  return {
    ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "",
    missingCommand: false, reason: result.status === 0 ? undefined : `PowerShell exited with code ${result.status}`,
  };
}

// ─── Image MIME ──────────────────────────────────────────────────────────────

const PREFERRED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"] as const;
const SUPPORTED_IMAGE_MIME_TYPES: readonly string[] = PREFERRED_IMAGE_MIME_TYPES;

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

function selectPreferredImageMimeType(mimeTypes: readonly string[]): string | null {
  const normalized = mimeTypes
    .map((m) => m.trim()).filter((m) => m.length > 0)
    .map((m) => ({ raw: m, normalized: normalizeMimeType(m) }));
  for (const pref of SUPPORTED_IMAGE_MIME_TYPES) {
    const match = normalized.find((m) => m.normalized === pref);
    if (match) return match.raw;
  }
  const firstImage = normalized.find((m) => m.normalized.startsWith("image/"));
  return firstImage?.raw ?? null;
}

// ─── Image Size ──────────────────────────────────────────────────────────────

const IMAGE_TOOLS_MAX_IMAGE_BYTES_ENV_VAR = "PI_IMAGE_TOOLS_MAX_IMAGE_BYTES";
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function getMaxImageBytes(environment: NodeJS.ProcessEnv = process.env): number {
  const rawValue = environment[IMAGE_TOOLS_MAX_IMAGE_BYTES_ENV_VAR]?.trim();
  if (!rawValue) return DEFAULT_MAX_IMAGE_BYTES;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${IMAGE_TOOLS_MAX_IMAGE_BYTES_ENV_VAR} must be a positive byte count.`);
  }
  return Math.floor(parsed);
}

function formatByteLimit(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) { value /= 1024; unitIndex += 1; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function assertImageWithinByteLimit(sizeBytes: number, label: string, environment: NodeJS.ProcessEnv = process.env): void {
  const max = getMaxImageBytes(environment);
  if (sizeBytes > max) {
    throw new Error(`${label} is too large (${formatByteLimit(sizeBytes)}). Limit is ${formatByteLimit(max)}.`);
  }
}

// ─── Image Resize ────────────────────────────────────────────────────────────

const DEFAULT_MAX_BASE64_BYTES = 4.5 * 1024 * 1024;
const DEFAULT_MAX_DIMENSION = 2000;
const JPEG_QUALITY_STEPS = [85, 70, 55, 40];
const WASM_FILENAME = "photon_rs_bg.wasm";

const requireFromHere = createRequire(import.meta.url);
const fs = requireFromHere("fs") as typeof import("node:fs");

interface PhotonModule {
  PhotonImage: {
    new_from_byteslice(bytes: Uint8Array): {
      get_width(): number; get_height(): number;
      get_bytes(): Uint8Array; get_bytes_jpeg(quality: number): Uint8Array; free(): void;
    };
  };
  resize(image: any, width: number, height: number, filter: number): {
    get_bytes(): Uint8Array; get_bytes_jpeg(quality: number): Uint8Array; free(): void;
  };
  SamplingFilter: { Lanczos3: number };
}

let photonModule: PhotonModule | null = null;
let loadPromise: Promise<PhotonModule | null> | null = null;

function getFallbackWasmPaths(): string[] {
  const execDir = path.dirname(process.execPath);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(execDir, WASM_FILENAME),
    path.join(execDir, "photon", WASM_FILENAME),
    path.join(process.cwd(), WASM_FILENAME),
    path.join(here, "..", WASM_FILENAME),
  ];
}

function patchPhotonWasmRead(): () => void {
  const originalReadFileSync = fs.readFileSync.bind(fs);
  const fallbackPaths = getFallbackWasmPaths();
  const mutableFs = fs as unknown as { readFileSync: typeof fs.readFileSync };
  const patchedReadFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    const [file, options] = args;
    const resolved = typeof file === "string" ? file : file instanceof URL ? fileURLToPath(file) : null;
    if (resolved?.endsWith(WASM_FILENAME)) {
      try { return originalReadFileSync(...args); }
      catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code && err.code !== "ENOENT") throw error;
        for (const fallback of fallbackPaths) {
          if (!fs.existsSync(fallback)) continue;
          return options === undefined ? originalReadFileSync(fallback) : originalReadFileSync(fallback, options);
        }
        throw error;
      }
    }
    return originalReadFileSync(...args);
  }) as typeof fs.readFileSync;
  try { mutableFs.readFileSync = patchedReadFileSync; }
  catch { Object.defineProperty(fs, "readFileSync", { value: patchedReadFileSync, writable: true, configurable: true }); }
  return () => {
    try { mutableFs.readFileSync = originalReadFileSync; }
    catch { Object.defineProperty(fs, "readFileSync", { value: originalReadFileSync, writable: true, configurable: true }); }
  };
}

async function loadPhoton(): Promise<PhotonModule | null> {
  if (photonModule) return photonModule;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const restore = patchPhotonWasmRead();
    try {
      const mod = (await import("@silvia-odwyer/photon-node")) as unknown as PhotonModule;
      photonModule = mod;
      return mod;
    } catch { photonModule = null; return null; }
    finally { restore(); }
  })();
  return loadPromise;
}

function base64Size(bytes: Uint8Array): number {
  return Math.ceil(bytes.length / 3) * 4;
}

interface ResizedClipboardImage { data: string; mimeType: string; wasResized: boolean; }

async function resizeClipboardImage(
  bytes: Uint8Array, mimeType: string, maxBase64Bytes: number = DEFAULT_MAX_BASE64_BYTES,
): Promise<ResizedClipboardImage | null> {
  if (base64Size(bytes) < maxBase64Bytes) {
    return { data: Buffer.from(bytes).toString("base64"), mimeType, wasResized: false };
  }
  const photon = await loadPhoton();
  if (!photon) return null;
  let image: ReturnType<PhotonModule["PhotonImage"]["new_from_byteslice"]> | null = null;
  try {
    image = photon.PhotonImage.new_from_byteslice(bytes);
    let targetWidth = image.get_width();
    let targetHeight = image.get_height();
    if (targetWidth > DEFAULT_MAX_DIMENSION) {
      targetHeight = Math.max(1, Math.round((targetHeight * DEFAULT_MAX_DIMENSION) / targetWidth));
      targetWidth = DEFAULT_MAX_DIMENSION;
    }
    if (targetHeight > DEFAULT_MAX_DIMENSION) {
      targetWidth = Math.max(1, Math.round((targetWidth * DEFAULT_MAX_DIMENSION) / targetHeight));
      targetHeight = DEFAULT_MAX_DIMENSION;
    }
    let currentWidth = targetWidth, currentHeight = targetHeight;
    while (true) {
      const resized = photon.resize(image, currentWidth, currentHeight, photon.SamplingFilter.Lanczos3);
      try {
        const candidates = [
          { bytes: resized.get_bytes(), mimeType: "image/png" },
          ...JPEG_QUALITY_STEPS.map(q => ({ bytes: resized.get_bytes_jpeg(q), mimeType: "image/jpeg" })),
        ];
        for (const c of candidates) {
          if (base64Size(c.bytes) < maxBase64Bytes) {
            return { data: Buffer.from(c.bytes).toString("base64"), mimeType: c.mimeType, wasResized: true };
          }
        }
      } finally { resized.free(); }
      if (currentWidth <= 1 && currentHeight <= 1) break;
      const nw = Math.max(1, Math.floor(currentWidth * 0.75));
      const nh = Math.max(1, Math.floor(currentHeight * 0.75));
      if (nw === currentWidth && nh === currentHeight) break;
      currentWidth = nw; currentHeight = nh;
    }
    return null;
  } catch { return null; }
  finally { if (image) try { image.free(); } catch {} }
}

// ─── Clipboard ───────────────────────────────────────────────────────────────

const LIST_TYPES_TIMEOUT_MS = 1000;
const READ_TIMEOUT_MS = 5000;
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;
let cachedClipboardModule: ClipboardModule | null | undefined;

interface CommandResult { ok: boolean; stdout: Buffer; missingCommand: boolean; }
interface ClipboardReadResult { available: boolean; image: ClipboardImage | null; }

function hasGraphicalSession(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return platform !== "linux" || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

function isWaylandSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

// Build a list of plausible base URLs to resolve `@mariozechner/clipboard` from.
// The native module is bundled inside pi's installed package, NOT next to this
// extension file. createRequire(import.meta.url) (the extension path) cannot
// see it, so we also try the SDK package's location and process.execPath.
function collectClipboardRequireBases(): string[] {
  const bases = new Set<string>();
  bases.add(import.meta.url);
  try {
    // Node 20.6+: import.meta.resolve is sync and returns a file:// URL.
    const resolveFn = (import.meta as { resolve?: (s: string) => string }).resolve;
    if (typeof resolveFn === "function") {
      const sdkUrl = resolveFn("@earendil-works/pi-coding-agent");
      if (sdkUrl) bases.add(sdkUrl);
    }
  } catch {}
  try {
    if (process.execPath) bases.add(process.execPath);
  } catch {}
  return [...bases];
}

function loadClipboardModule(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ClipboardModule | null {
  if (cachedClipboardModule !== undefined) return cachedClipboardModule;
  if (environment.TERMUX_VERSION || !hasGraphicalSession(platform, environment)) {
    cachedClipboardModule = null; return null;
  }
  for (const base of collectClipboardRequireBases()) {
    try {
      const req = createRequire(base);
      const mod = req("@mariozechner/clipboard") as ClipboardModule;
      if (mod && typeof mod.hasImage === "function") {
        cachedClipboardModule = mod;
        return mod;
      }
    } catch {}
  }
  cachedClipboardModule = null;
  return cachedClipboardModule;
}

function clipboardHasImageSync(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const clipboard = loadClipboardModule(platform, environment);
    if (clipboard && typeof clipboard.hasImage === "function") return Boolean(clipboard.hasImage());
  } catch {}
  if (platform === "win32") {
    try {
      const probe = runPowerShellCommand(
        "Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { 'yes' } else { 'no' }",
        { encoded: true, sta: true, timeout: 1500, maxBuffer: 1024 },
      );
      return probe.ok && probe.stdout.trim() === "yes";
    } catch { return false; }
  }
  return false;
}

function runCommand(command: string, args: string[], timeout: number): CommandResult {
  const result = spawnSync(command, args, { timeout, maxBuffer: MAX_BUFFER_BYTES });
  if (result.error) {
    return { ok: false, stdout: Buffer.alloc(0), missingCommand: isErrnoException(result.error) && result.error.code === "ENOENT" };
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  return { ok: result.status === 0, stdout, missingCommand: false };
}

async function readClipboardImageViaNativeModule(
  platform: NodeJS.Platform, environment: NodeJS.ProcessEnv,
): Promise<ClipboardReadResult> {
  const clipboard = loadClipboardModule(platform, environment);
  if (!clipboard) return { available: false, image: null };
  if (!clipboard.hasImage()) return { available: true, image: null };
  const imageData = await clipboard.getImageBinary();
  if (!imageData || imageData.length === 0) return { available: true, image: null };
  const bytes = imageData instanceof Uint8Array ? imageData : Uint8Array.from(imageData);
  return { available: true, image: { bytes, mimeType: "image/png" } };
}

function readClipboardImageViaPowerShell(): ClipboardReadResult {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { return }
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) { return }
$stream = New-Object System.IO.MemoryStream
try { $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($stream.ToArray()) }
finally { $stream.Dispose(); $image.Dispose() }
`;
  const result = runPowerShellCommand(script, { encoded: true, sta: true, timeout: READ_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES });
  if (result.missingCommand) return { available: false, image: null };
  if (!result.ok) return { available: true, image: null };
  const base64 = result.stdout.trim();
  if (!base64) return { available: true, image: null };
  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0) return { available: true, image: null };
    return { available: true, image: { bytes: new Uint8Array(bytes), mimeType: "image/png" } };
  } catch { return { available: true, image: null }; }
}

function readClipboardImageViaWlPaste(): ClipboardReadResult {
  const listTypes = runCommand("wl-paste", ["--list-types"], LIST_TYPES_TIMEOUT_MS);
  if (listTypes.missingCommand) return { available: false, image: null };
  if (!listTypes.ok) return { available: true, image: null };
  const mimeTypes = listTypes.stdout.toString("utf8").split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
  const selected = selectPreferredImageMimeType(mimeTypes);
  if (!selected) return { available: true, image: null };
  const imageData = runCommand("wl-paste", ["--type", selected, "--no-newline"], READ_TIMEOUT_MS);
  if (!imageData.ok || imageData.stdout.length === 0) return { available: true, image: null };
  return { available: true, image: { bytes: new Uint8Array(imageData.stdout), mimeType: normalizeMimeType(selected) } };
}

function readClipboardImageViaXclip(): ClipboardReadResult {
  const targets = runCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], LIST_TYPES_TIMEOUT_MS);
  if (targets.missingCommand) return { available: false, image: null };
  const advertised = targets.ok ? targets.stdout.toString("utf8").split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0) : [];
  const preferred = advertised.length > 0 ? selectPreferredImageMimeType(advertised) : null;
  const toTry = preferred ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES] : [...SUPPORTED_IMAGE_MIME_TYPES];
  for (const mime of toTry) {
    const imageData = runCommand("xclip", ["-selection", "clipboard", "-t", mime, "-o"], READ_TIMEOUT_MS);
    if (imageData.ok && imageData.stdout.length > 0) {
      return { available: true, image: { bytes: new Uint8Array(imageData.stdout), mimeType: normalizeMimeType(mime) } };
    }
  }
  return { available: true, image: null };
}

async function readClipboardImage(options?: {
  environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
  const environment = options?.environment ?? process.env;
  const platform = options?.platform ?? process.platform;
  if (environment.TERMUX_VERSION) return null;
  if (!hasGraphicalSession(platform, environment)) {
    throw new Error("Clipboard image paste requires a graphical desktop session.");
  }
  const results: ClipboardReadResult[] = [];
  const record = (r: ClipboardReadResult): ClipboardImage | null => { results.push(r); return r.image; };
  if (platform === "win32") {
    const native = record(await readClipboardImageViaNativeModule(platform, environment));
    if (native) return native;
    const ps = record(readClipboardImageViaPowerShell());
    if (ps) return ps;
  } else if (platform === "linux") {
    const readers = isWaylandSession(environment)
      ? [readClipboardImageViaWlPaste, readClipboardImageViaXclip]
      : [readClipboardImageViaXclip, readClipboardImageViaWlPaste];
    for (const reader of readers) { const img = record(reader()); if (img) return img; }
    const native = record(await readClipboardImageViaNativeModule(platform, environment));
    if (native) return native;
  } else {
    const native = record(await readClipboardImageViaNativeModule(platform, environment));
    if (native) return native;
  }
  if (results.some(r => r.available)) return null;
  throw new Error(`No clipboard image reader available on ${platform}.`);
}

// ─── Houdini Paths ───────────────────────────────────────────────────────────

const HOUDINI_ROOTS = ["obj", "stage", "out", "mat", "ch", "img", "shop", "tasks", "cop2"];
const HOUDINI_PATH_RE = new RegExp(`\\/(${HOUDINI_ROOTS.join("|")})(\\/[\\w-]+)+`, "g");
const HOUDINI_CHIP_RE = /\[🟧 [^\]]+\]/gu;

function containsHoudiniPath(text: string): boolean {
  HOUDINI_PATH_RE.lastIndex = 0;
  return HOUDINI_PATH_RE.test(text);
}

function replaceHoudiniPaths(content: string, pathMap: Map<string, string>): string | undefined {
  HOUDINI_PATH_RE.lastIndex = 0;
  if (!HOUDINI_PATH_RE.test(content)) return undefined;
  HOUDINI_PATH_RE.lastIndex = 0;
  const transformed = content.replace(HOUDINI_PATH_RE, (match) => {
    const segments = match.split("/").filter(Boolean);
    const nodeName = segments[segments.length - 1]!;
    let chip = `[🟧 ${nodeName}]`;
    if (pathMap.has(chip) && pathMap.get(chip) !== match) {
      const parent = segments[segments.length - 2] ?? segments[0];
      chip = `[🟧 ${parent}/${nodeName}]`;
    }
    pathMap.set(chip, match);
    return chip;
  });
  return transformed === content ? undefined : transformed;
}

function expandHoudiniChips(text: string, pathMap: Map<string, string>): { text: string; changed: boolean } {
  let changed = false;
  let result = text;
  for (const [chip, fullPath] of pathMap) {
    if (result.includes(chip)) { result = result.replaceAll(chip, fullPath); changed = true; }
  }
  return { text: result, changed };
}

// ─── Paste Interceptor ──────────────────────────────────────────────────────

const PASTE_BEGIN = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const CLIPBOARD_CACHE_MS = 250;
const WIN_PATH_RE = /^[A-Za-z]:\\/;
const UNIX_PATH_RE = /^\//;

function isDirectoryPath(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) return false;
  if (!WIN_PATH_RE.test(trimmed) && !UNIX_PATH_RE.test(trimmed)) return false;
  try { return existsSync(trimmed) && statSync(trimmed).isDirectory(); } catch { return false; }
}

function isFilePath(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) return false;
  if (!WIN_PATH_RE.test(trimmed) && !UNIX_PATH_RE.test(trimmed)) return false;
  try { return existsSync(trimmed) && statSync(trimmed).isFile(); } catch { return false; }
}

function makeFolderTag(folderPath: string): string {
  return `[📁 ${path.basename(folderPath.trim())}]`;
}

const IMAGE_EXT_RE = /\.(jpe?g|png)$/i;
function makeFileTag(filePath: string): string {
  const name = path.basename(filePath.trim());
  return IMAGE_EXT_RE.test(name) ? `[🖼  ${name}]` : `[📄 ${name}]`;
}

const URL_RE = /^https?:\/\/[^\s]+$/i;
function isUrl(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) return false;
  return URL_RE.test(trimmed);
}

const URL_DISPLAY_MAX = 40;
function makeUrlTag(url: string): string {
  const trimmed = url.trim();
  return trimmed.length <= URL_DISPLAY_MAX ? `[🔗 ${trimmed}]` : `[🔗 ${trimmed.slice(0, URL_DISPLAY_MAX)}...]`;
}

interface InterceptorState {
  swallowing: boolean;
  pendingTail: string;
  lastProbeAtMs: number;
  lastProbeResult: boolean;
}

// ─── Chip backspace handling ────────────────────────────────────────────────
//
// When the user presses Backspace and the editor text ends with one of the
// paste-extension's [emoji ...] chips, we delete the whole chip in one shot
// so each block behaves like a single character.

const BACKSPACE_CHARS = new Set(["\x7f", "\b"]);

// VT/xterm sequence for the forward-Delete key (Del). Some terminals also emit
// \x1b[P for the same key.
const DELETE_KEYS = new Set(["\x1b[3~", "\x1b[P"]);

const CHIP_BODY_RE_SRC =
  "(?:\\[\\u{1F4F7} clipboard-[a-f0-9]+\\.png\\]|\\[\\u{1F4C1} [^\\]]+\\]|\\[(?:\\u{1F4C4}|\\u{1F5BC}) {1,2}[^\\]]+\\]|\\[\\u{1F517} [^\\]]+\\]|\\[\\u{1F7E7} [^\\]]+\\])";

// Matches any chip produced by this extension at the END of the editor text.
// Trailing whitespace (the space we insert after a chip) is allowed.
const CHIP_AT_END_RE = new RegExp(`${CHIP_BODY_RE_SRC}\\s*$`, "u");

// Matches any chip at the START of a string. Leading whitespace is allowed.
const CHIP_AT_START_RE = new RegExp(`^\\s*${CHIP_BODY_RE_SRC}`, "u");

// Returns a leading space if the text the chip is about to be appended to
// is non-empty and does not already end with whitespace. The chip insertion
// happens via the terminal-input data stream, so we check (in order):
//   1. the prefix from the current input buffer (chars before the paste)
//   2. the editor's current text (whatever was typed previously)
function leadingSpaceFor(ui: ExtensionUIContext, prefix: string): string {
  const tail = prefix.length > 0 ? prefix : safeGetEditorText(ui);
  if (tail.length === 0) return "";
  const lastChar = tail.slice(-1);
  if (/\s/.test(lastChar)) return "";
  return " ";
}

function safeGetEditorText(ui: ExtensionUIContext): string {
  try {
    if (typeof ui.getEditorText === "function") return ui.getEditorText() ?? "";
  } catch {}
  return "";
}

function tryDeleteTrailingChip(ui: ExtensionUIContext): boolean {
  return mutateEditor(ui, (text) => {
    const match = text.match(CHIP_AT_END_RE);
    if (!match || match.index === undefined) return null;
    return text.slice(0, match.index).replace(/[ \t]+$/, "");
  });
}

// Forward-delete a chip that sits immediately after the cursor.
//
// We don't get cursor position from the SDK so we use a shadow cursor tracked
// from observed keystrokes (arrows / Home / End / printable input). When the
// shadow is "unknown" we degrade to a no-op rather than guessing.
function tryForwardDeleteChipAtCursor(
  ui: ExtensionUIContext,
  cursor: ShadowCursor,
): boolean {
  return mutateEditor(ui, (text) => {
    if (text.length === 0) return null;
    const offset = resolveCursorOffset(cursor, text);
    if (offset === null) return null;
    const after = text.slice(offset);
    const match = after.match(CHIP_AT_START_RE);
    if (!match) return null;
    const before = text.slice(0, offset).replace(/[ \t]+$/, "");
    const remainder = after.slice(match[0].length).replace(/^[ \t]+/, "");
    cursor.mode = "offset";
    cursor.offset = before.length;
    const joiner = before.length > 0 && remainder.length > 0 ? " " : "";
    return before + joiner + remainder;
  });
}

function mutateEditor(
  ui: ExtensionUIContext,
  transform: (text: string) => string | null,
): boolean {
  try {
    if (typeof ui.getEditorText !== "function" || typeof ui.setEditorText !== "function") {
      return false;
    }
    const text = ui.getEditorText();
    if (text === undefined || text === null) return false;
    const next = transform(text);
    if (next === null || next === text) return false;
    ui.setEditorText(next);
    try { ui.setStatus("pi-paste-render", undefined); } catch {}
    return true;
  } catch {
    return false;
  }
}

// ─── Shadow cursor ──────────────────────────────────────────────────────────
//
// Tracks a best-effort cursor position so forward Delete can find a chip
// immediately after the cursor. States:
//   "end"     → cursor at editor.text.length
//   "start"   → cursor at 0
//   "offset"  → cursor at the stored .offset
//   "unknown" → we lost track; chip-aware Delete is disabled
type ShadowCursor = {
  mode: "end" | "start" | "offset" | "unknown";
  offset: number;
};

function makeShadowCursor(): ShadowCursor {
  return { mode: "end", offset: 0 };
}

function resolveCursorOffset(cursor: ShadowCursor, text: string): number | null {
  switch (cursor.mode) {
    case "start":  return 0;
    case "end":    return text.length;
    case "offset": return Math.max(0, Math.min(cursor.offset, text.length));
    default:       return null;
  }
}

const ARROW_LEFT  = "\x1b[D";
const ARROW_RIGHT = "\x1b[C";
const ARROW_UP    = "\x1b[A";
const ARROW_DOWN  = "\x1b[B";
const HOME_KEYS = new Set(["\x1b[H", "\x1b[1~", "\x1b[7~", "\x01"]);
const END_KEYS  = new Set(["\x1b[F", "\x1b[4~", "\x1b[8~", "\x05"]);

function updateShadowCursorForInput(
  cursor: ShadowCursor,
  data: string,
  ui: ExtensionUIContext,
): void {
  if (data.length === 0) return;
  if (HOME_KEYS.has(data)) { cursor.mode = "start"; cursor.offset = 0; return; }
  if (END_KEYS.has(data))  { cursor.mode = "end";   cursor.offset = 0; return; }
  if (BACKSPACE_CHARS.has(data)) {
    const text = safeGetEditorText(ui);
    const cur = resolveCursorOffset(cursor, text);
    if (cur === null) return;
    const next = Math.max(0, cur - 1);
    cursor.mode = next === 0 ? "start" : next >= text.length - 1 ? "end" : "offset";
    cursor.offset = next;
    return;
  }
  if (DELETE_KEYS.has(data)) {
    // Forward delete: cursor stays put; text shrinks by 1 after editor handles it.
    const text = safeGetEditorText(ui);
    const cur = resolveCursorOffset(cursor, text);
    if (cur === null) return;
    cursor.mode = cur === 0 ? "start" : cur >= text.length - 1 ? "end" : "offset";
    cursor.offset = cur;
    return;
  }
  if (data === ARROW_LEFT || data === ARROW_RIGHT) {
    const text = safeGetEditorText(ui);
    const cur = resolveCursorOffset(cursor, text);
    if (cur === null) return;
    const next = data === ARROW_LEFT ? Math.max(0, cur - 1) : Math.min(text.length, cur + 1);
    cursor.mode = next === 0 ? "start" : next === text.length ? "end" : "offset";
    cursor.offset = next;
    return;
  }
  if (data === ARROW_UP || data === ARROW_DOWN) {
    cursor.mode = "unknown";
    return;
  }
  if (data.startsWith("\x1b")) {
    cursor.mode = "unknown";
    return;
  }
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      cursor.mode = "unknown";
      return;
    }
  }
  // Printable / pasted text inserted at the cursor: advance by data length.
  const text = safeGetEditorText(ui);
  const cur = resolveCursorOffset(cursor, text);
  if (cur === null) return;
  const newLen = text.length + data.length;
  const next = cur + data.length;
  cursor.mode = next >= newLen ? "end" : "offset";
  cursor.offset = next;
}

// ─── Chip navigation editor patch ─────────────────────────────────────
//
// Decorates any editor instance so each `[…]` chip behaves as a single
// character for arrow nav / word-jumps / backspace / delete. We monkey-patch
// the instance's `handleInput` instead of subclassing, so it composes cleanly
// with whatever editor another extension (e.g. modes) installed.
function patchChipNavigation(editor: any): any {
  if (!editor || editor.__chipNavPatched) return editor;
  const origHandle = editor.handleInput.bind(editor);

  const chipSpanBeforeCursor = (): number => {
    const cursor = editor.getCursor() as { line: number; col: number };
    const lines = editor.getLines() as string[];
    const curHead = (lines[cursor.line] ?? "").slice(0, cursor.col);
    const head = cursor.line === 0 ? curHead
      : lines.slice(0, cursor.line).join("\n") + "\n" + curHead;
    if (head.length === 0) return 0;
    const match = head.match(CHIP_AT_END_RE);
    if (!match || match.index === undefined) return 0;
    return head.length - match.index;
  };
  const chipSpanAfterCursor = (): number => {
    const cursor = editor.getCursor() as { line: number; col: number };
    const lines = editor.getLines() as string[];
    const curTail = (lines[cursor.line] ?? "").slice(cursor.col);
    const tail = cursor.line === lines.length - 1 ? curTail
      : curTail + "\n" + lines.slice(cursor.line + 1).join("\n");
    if (tail.length === 0) return 0;
    const match = tail.match(CHIP_AT_START_RE);
    if (!match) return 0;
    return match[0].length;
  };

  editor.handleInput = function (data: string): void {
    const kb = editor.keybindings;
    const isWordLeft  = kb && kb.matches(data, "tui.editor.cursorWordLeft");
    const isWordRight = kb && kb.matches(data, "tui.editor.cursorWordRight");

    if (data === "\x1b[D" || data === "\x1bOD" || isWordLeft) {
      const span = chipSpanBeforeCursor();
      if (span > 1) { for (let i = 0; i < span; i++) origHandle("\x1b[D"); return; }
    } else if (data === "\x1b[C" || data === "\x1bOC" || isWordRight) {
      const span = chipSpanAfterCursor();
      if (span > 1) { for (let i = 0; i < span; i++) origHandle("\x1b[C"); return; }
    } else if (data === "\x7f" || data === "\b") {
      const span = chipSpanBeforeCursor();
      if (span > 1) { for (let i = 0; i < span; i++) origHandle("\x7f"); return; }
    } else if (data === "\x1b[3~" || data === "\x1b[P") {
      const span = chipSpanAfterCursor();
      if (span > 1) { for (let i = 0; i < span; i++) origHandle("\x1b[3~"); return; }
    }
    origHandle(data);
  };
  editor.__chipNavPatched = true;
  return editor;
}

function probeClipboardImage(state: InterceptorState): boolean {
  const now = Date.now();
  if (now - state.lastProbeAtMs < CLIPBOARD_CACHE_MS) return state.lastProbeResult;
  const result = clipboardHasImageSync();
  state.lastProbeAtMs = now;
  state.lastProbeResult = result;
  return result;
}

function registerPasteInterceptor(
  ui: ExtensionUIContext,
  ctx: PasteContext,
  handler: (ctx: PasteContext, tag: string) => void,
  generateTag: () => string,
  folderHandler?: (ctx: PasteContext, fullPath: string, tag: string) => void,
  fileHandler?: (ctx: PasteContext, fullPath: string, tag: string) => void,
  urlHandler?: (ctx: PasteContext, url: string, tag: string) => void,
  houdiniPathMap?: Map<string, string>,
): () => void {
  if (!ui || typeof ui.onTerminalInput !== "function") return () => {};

  const state: InterceptorState = { swallowing: false, pendingTail: "", lastProbeAtMs: 0, lastProbeResult: false };

  const triggerImagePaste = (): string => {
    const tag = generateTag();
    // Defer the actual clipboard read off the input-handler tick. The async
    // body of pasteImageFromClipboard runs synchronously up to its first
    // await — that prelude includes loadClipboardModule(), clipboard.hasImage()
    // (Win32 OpenClipboard can block briefly), and the sync prologue of the
    // native getImageBinary(). Punting to setImmediate lets the editor paint
    // the chip placeholder we just returned before any clipboard I/O runs.
    setImmediate(() => handler(ctx, tag));
    return tag;
  };

  const unsubscribe = ui.onTerminalInput((data: string) => {
    // Backspace / Delete / arrow chip-as-one-char behaviour is added by
    // patchChipNavigation() via chainEditor() in installChipEditor(). This
    // listener only needs to handle paste bursts.

    const buffer = state.pendingTail + data;
    state.pendingTail = "";

    if (!state.swallowing) {
      const beginIdx = buffer.indexOf(PASTE_BEGIN);
      if (beginIdx === -1) {
        let holdBack = 0;
        const maxCheck = Math.min(buffer.length, PASTE_BEGIN.length - 1);
        for (let len = 1; len <= maxCheck; len++) {
          if (buffer.slice(buffer.length - len) === PASTE_BEGIN.slice(0, len)) holdBack = len;
        }
        const passthrough = buffer.slice(0, buffer.length - holdBack);
        state.pendingTail = buffer.slice(buffer.length - holdBack);
        if (passthrough.length === 0 && holdBack > 0) return { consume: true };
        return passthrough === data ? undefined : { data: passthrough };
      }

      // Empty bracketed paste => assume image. We do NOT probe the clipboard
      // here: any sync probe (native or PowerShell) blocks the keystroke,
      // making Ctrl+V feel laggy. Instead, optimistically insert the chip
      // placeholder immediately and kick off the real clipboard read fully
      // async via startImageRead(). If the read finds no image, the input
      // hook strips the unmatched tag at send time and we already notify
      // the user via pasteImageFromClipboard().
      const restForProbe = buffer.slice(beginIdx + PASTE_BEGIN.length);
      const endForProbe = restForProbe.indexOf(PASTE_END);
      const seenContent = endForProbe === -1 ? restForProbe : restForProbe.slice(0, endForProbe);
      const hasImage = seenContent.length === 0;
      if (!hasImage) {
        if (folderHandler) {
          const rest = buffer.slice(beginIdx + PASTE_BEGIN.length);
          const endIdx = rest.indexOf(PASTE_END);
          if (endIdx !== -1) {
            const content = rest.slice(0, endIdx);
            if (isDirectoryPath(content)) {
              const prefix = buffer.slice(0, beginIdx);
              const tail = rest.slice(endIdx + PASTE_END.length);
              const tag = makeFolderTag(content);
              folderHandler(ctx, content.trim(), tag);
              return { data: prefix + leadingSpaceFor(ui, prefix) + tag + " " + tail };
            }
            if (fileHandler && isFilePath(content)) {
              const prefix = buffer.slice(0, beginIdx);
              const tail = rest.slice(endIdx + PASTE_END.length);
              const tag = makeFileTag(content);
              fileHandler(ctx, content.trim(), tag);
              return { data: prefix + leadingSpaceFor(ui, prefix) + tag + " " + tail };
            }
            if (urlHandler && isUrl(content)) {
              const prefix = buffer.slice(0, beginIdx);
              const tail = rest.slice(endIdx + PASTE_END.length);
              const trimmedUrl = content.trim();
              const tag = makeUrlTag(trimmedUrl);
              urlHandler(ctx, trimmedUrl, tag);
              return { data: prefix + leadingSpaceFor(ui, prefix) + tag + " " + tail };
            }
            if (houdiniPathMap && containsHoudiniPath(content)) {
              const transformed = replaceHoudiniPaths(content, houdiniPathMap);
              if (transformed !== undefined) {
                const prefix = buffer.slice(0, beginIdx);
                const tail = rest.slice(endIdx + PASTE_END.length);
                const lead = transformed.startsWith("[") ? leadingSpaceFor(ui, prefix) : "";
                // Trailing space after the final chip (only if the transformed
                // content ends with one and the next char isn't already
                // whitespace) so chips stay visually separated from whatever
                // the user types next — matches behaviour of folder/file/url/image.
                const endsWithChip = /\]$/u.test(transformed);
                const nextChar = tail.charAt(0);
                const trail = endsWithChip && nextChar !== "" && !/\s/.test(nextChar) ? " "
                            : endsWithChip && nextChar === "" ? " "
                            : "";
                return { data: prefix + lead + transformed + trail + tail };
              }
            }
          }
        }
        return buffer === data ? undefined : { data: buffer };
      }

      const prefix = buffer.slice(0, beginIdx);
      const rest = buffer.slice(beginIdx + PASTE_BEGIN.length);
      state.swallowing = true;
      const tag = triggerImagePaste();
      const lead = leadingSpaceFor(ui, prefix);
      const placeholder = `${lead}${tag} `;
      const endIdx = rest.indexOf(PASTE_END);
      if (endIdx === -1) {
        state.pendingTail = "";
        return { data: prefix + placeholder };
      }
      state.swallowing = false;
      const tail = rest.slice(endIdx + PASTE_END.length);
      return { data: prefix + placeholder + tail };
    }

    const endIdx = buffer.indexOf(PASTE_END);
    if (endIdx === -1) {
      const safeLen = Math.max(0, buffer.length - (PASTE_END.length - 1));
      state.pendingTail = buffer.slice(safeLen);
      return { consume: true };
    }
    state.swallowing = false;
    const tail = buffer.slice(endIdx + PASTE_END.length);
    return tail.length > 0 ? { data: tail } : { consume: true };
  });

  return unsubscribe;
}

// ─── Main Extension ──────────────────────────────────────────────────────────

function generateImageTag(): string {
  const hash = randomBytes(3).toString("hex");
  return `[📷 clipboard-${hash}.png]`;
}

const API_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function resizeImageViaPowerShell(
  bytes: Uint8Array,
  maxBytes: number = API_MAX_IMAGE_BYTES,
): { data: string; mimeType: string } | null {
  if (process.platform !== "win32") return null;
  // Write raw bytes to a temp file to avoid PowerShell command-line size limits
  const os = requireFromHere("os") as typeof import("node:os");
  const tmpDir = os.tmpdir();
  const tmpIn = path.join(tmpDir, `pi-paste-in-${randomBytes(4).toString("hex")}.bin`);
  const tmpOut = path.join(tmpDir, `pi-paste-out-${randomBytes(4).toString("hex")}.txt`);
  try {
    fs.writeFileSync(tmpIn, bytes);
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$maxBytes = ${maxBytes}
$bytes = [System.IO.File]::ReadAllBytes('${tmpIn.replace(/\\/g, "\\\\")}')
$ms = New-Object System.IO.MemoryStream(,$bytes)
$img = [System.Drawing.Image]::FromStream($ms)
$w = $img.Width; $h = $img.Height
$maxDim = 2000
if ($w -gt $maxDim -or $h -gt $maxDim) {
  if ($w -ge $h) { $h = [Math]::Max(1, [int]($h * $maxDim / $w)); $w = $maxDim }
  else { $w = [Math]::Max(1, [int]($w * $maxDim / $h)); $h = $maxDim }
}
$qualities = @(85,70,55,40,25)
$scale = 1.0
for ($attempt = 0; $attempt -lt 10; $attempt++) {
  $nw = [Math]::Max(1, [int]($w * $scale))
  $nh = [Math]::Max(1, [int]($h * $scale))
  $bmp = New-Object System.Drawing.Bitmap($nw, $nh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $nw, $nh)
  $g.Dispose()
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  foreach ($q in $qualities) {
    $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$q)
    $out = New-Object System.IO.MemoryStream
    $bmp.Save($out, $codec, $ep)
    if ($out.Length -le $maxBytes) {
      $result = [System.Convert]::ToBase64String($out.ToArray())
      [System.IO.File]::WriteAllText('${tmpOut.replace(/\\/g, "\\\\")}', $result)
      $out.Dispose(); $bmp.Dispose(); $img.Dispose(); $ms.Dispose()
      return
    }
    $out.Dispose()
  }
  $bmp.Dispose()
  $scale *= 0.7
}
$img.Dispose(); $ms.Dispose()
Write-Error 'Could not compress image below limit'
`;
    const result = runPowerShellCommand(script, {
      encoded: true, sta: true, timeout: 15000, maxBuffer: 1024 * 64,
    });
    if (!result.ok) return null;
    // Read result from output temp file
    if (!fs.existsSync(tmpOut)) return null;
    const b64 = fs.readFileSync(tmpOut, "utf8").trim();
    if (!b64) return null;
    return { data: b64, mimeType: "image/jpeg" };
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

async function prepareImageForAttachment(image: ClipboardImage): Promise<{ data: string; mimeType: string }> {
  assertImageWithinByteLimit(image.bytes.length, "Image attachment");
  const resized = await resizeClipboardImage(image.bytes, image.mimeType);
  if (resized) return { data: resized.data, mimeType: resized.mimeType };
  // Photon unavailable — if image exceeds API limit, try PowerShell fallback
  if (image.bytes.length > API_MAX_IMAGE_BYTES) {
    const psResult = resizeImageViaPowerShell(image.bytes);
    if (psResult) return psResult;
    throw new Error(
      `Image is ${formatByteLimit(image.bytes.length)} but the API limit is ${formatByteLimit(API_MAX_IMAGE_BYTES)}. ` +
      `Install @silvia-odwyer/photon-node for automatic resizing.`,
    );
  }
  return { data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType };
}

export default function piPasteExtension(pi: ExtensionAPI): void {
  // Pre-warm clipboard module + photon WASM at extension load so the first
  // image paste in a session never pays native-module init cost. Both are
  // best-effort; failures are silent.
  try { loadClipboardModule(); } catch {}
  setImmediate(() => { void loadPhoton().catch(() => {}); });

  const pendingImages: PendingImage[] = [];
  const pendingFolders: PendingFolder[] = [];
  const pendingFiles: PendingFile[] = [];
  const pendingUrls: PendingUrl[] = [];
  const inflightReads: Promise<void>[] = [];
  const houdiniPathMap = new Map<string, string>();

  const pasteImageFromClipboard = async (ctx: PasteContext, tag: string): Promise<void> => {
    if (!ctx.hasUI) return;
    try {
      const image = await readClipboardImage();
      if (!image) {
        ctx.ui.notify("No image in clipboard – placeholder will be ignored.", "warning");
        return;
      }
      const prepared = await prepareImageForAttachment(image);
      pendingImages.push({ type: "image", tag, data: prepared.data, mimeType: prepared.mimeType });
    } catch (error) {
      ctx.ui.notify(`Image paste failed: ${getErrorMessage(error)}`, "warning");
    }
  };

  const startImageRead = (ctx: PasteContext, tag: string): void => {
    const promise = pasteImageFromClipboard(ctx, tag);
    inflightReads.push(promise);
    void promise.finally(() => {
      const idx = inflightReads.indexOf(promise);
      if (idx !== -1) inflightReads.splice(idx, 1);
    });
  };

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" as const };

    const hasImageTags = /\[\u{1F4F7} clipboard-[a-f0-9]+\.png\]/u.test(event.text);
    const hasFolderTags = /\[\u{1F4C1} [^\]]+\]/u.test(event.text);
    const hasFileTags = /\[(?:\u{1F4C4}|\u{1F5BC}) {1,2}[^\]]+\]/u.test(event.text);
    const hasUrlTags = /\[\u{1F517} [^\]]+\]/u.test(event.text);
    const hasHoudiniChips = HOUDINI_CHIP_RE.test(event.text);

    if (!hasImageTags && !hasFolderTags && !hasFileTags && !hasUrlTags && !hasHoudiniChips &&
        pendingImages.length === 0 && pendingFolders.length === 0 &&
        pendingFiles.length === 0 && pendingUrls.length === 0 && inflightReads.length === 0) {
      return { action: "continue" as const };
    }

    if (inflightReads.length > 0) await Promise.all([...inflightReads]);

    if (pendingImages.length === 0 && pendingFolders.length === 0 &&
        pendingFiles.length === 0 && pendingUrls.length === 0 &&
        !hasImageTags && !hasFolderTags && !hasFileTags && !hasUrlTags && !hasHoudiniChips) {
      return { action: "continue" as const };
    }

    const images = pendingImages.splice(0);
    const folders = pendingFolders.splice(0);
    const files = pendingFiles.splice(0);
    const urls = pendingUrls.splice(0);

    let cleanedText = event.text;
    const successTags = new Set(images.map(img => img.tag));
    cleanedText = cleanedText
      .replace(/\[\u{1F4F7} clipboard-[a-f0-9]+\.png\]/gu, (match) => successTags.has(match) ? match : "")
      .replace(/\n{3,}/g, "\n\n").trim();

    const folderMap = new Map(folders.map(f => [f.tag, f.fullPath]));
    const fileMap = new Map(files.map(f => [f.tag, f.fullPath]));
    const urlMap = new Map(urls.map(u => [u.tag, u.url]));

    cleanedText = cleanedText
      .replace(/\[\u{1F4C1} [^\]]+\]/gu, (match) => folderMap.get(match) ?? match)
      .replace(/\[(?:\u{1F4C4}|\u{1F5BC}) {1,2}[^\]]+\]/gu, (match) => fileMap.get(match) ?? match)
      .replace(/\[\u{1F517} [^\]]+\]/gu, (match) => urlMap.get(match) ?? match);

    if (houdiniPathMap.size > 0) {
      const expanded = expandHoudiniChips(cleanedText, houdiniPathMap);
      if (expanded.changed) cleanedText = expanded.text;
    }

    // Final safety: ensure no image exceeds the API byte limit (5MB decoded)
    const safeImages = await Promise.all(
      [...(event.images ?? []), ...images].map(async (img) => {
        const rawBytes = Buffer.from(img.data, "base64").length;
        if (rawBytes <= API_MAX_IMAGE_BYTES) return img;
        // Image is too large — attempt PowerShell resize
        const bytes = Buffer.from(img.data, "base64");
        const resized = await resizeClipboardImage(new Uint8Array(bytes), img.mimeType);
        if (resized && Buffer.from(resized.data, "base64").length <= API_MAX_IMAGE_BYTES) {
          return { ...img, data: resized.data, mimeType: resized.mimeType };
        }
        const psResult = resizeImageViaPowerShell(new Uint8Array(bytes));
        if (psResult && Buffer.from(psResult.data, "base64").length <= API_MAX_IMAGE_BYTES) {
          return { ...img, data: psResult.data, mimeType: psResult.mimeType };
        }
        return null; // Drop image that can't be resized
      }),
    );
    const filteredImages = safeImages.filter((img): img is NonNullable<typeof img> => img !== null);

    return {
      action: "transform" as const,
      text: cleanedText,
      images: filteredImages,
    };
  });

  let pasteInterceptorUnsubscribe: (() => void) | undefined;
  let chipEditorInstalled = false;

  // Install chip-nav by decorating whatever editor is currently installed.
  // chainEditor() composes cleanly with other extensions (e.g. modes' border
  // editor) regardless of load order.
  const installChipEditor = (ctx: PasteContext): void => {
    if (chipEditorInstalled) return;
    if (!ctx.hasUI) return;
    if (chainEditor(ctx.ui, (editor) => patchChipNavigation(editor))) {
      chipEditorInstalled = true;
    }
  };

  const installPasteInterceptor = (ctx: PasteContext): void => {
    installChipEditor(ctx);
    if (pasteInterceptorUnsubscribe) return;
    if (!ctx.hasUI) return;
    try {
      pasteInterceptorUnsubscribe = registerPasteInterceptor(
        ctx.ui, ctx, startImageRead, generateImageTag,
        (_ctx: PasteContext, fullPath: string, tag: string) => { pendingFolders.push({ tag, fullPath }); },
        (_ctx: PasteContext, fullPath: string, tag: string) => { pendingFiles.push({ tag, fullPath }); },
        (_ctx: PasteContext, url: string, tag: string) => { pendingUrls.push({ tag, url }); },
        houdiniPathMap,
      );
    } catch {}
  };

  pi.on("session_start", async (_event, ctx) => {
    houdiniPathMap.clear();
    installPasteInterceptor(ctx);
    // Pre-warm clipboard module + photon WASM so the first paste doesn't pay
    // first-load cost. Both are best-effort and run off the hot path.
    try { loadClipboardModule(); } catch {}
    void loadPhoton().catch(() => {});
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    installPasteInterceptor(ctx);
  });
}
