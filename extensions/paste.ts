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

const piRequire = createRequire(import.meta.url);

function loadClipboardModule(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ClipboardModule | null {
  if (cachedClipboardModule !== undefined) return cachedClipboardModule;
  if (environment.TERMUX_VERSION || !hasGraphicalSession(platform, environment)) {
    cachedClipboardModule = null; return null;
  }
  try { cachedClipboardModule = piRequire("@mariozechner/clipboard") as ClipboardModule; }
  catch { cachedClipboardModule = null; }
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
    handler(ctx, tag);
    return tag;
  };

  const unsubscribe = ui.onTerminalInput((data: string) => {
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

      const hasImage = probeClipboardImage(state);
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
              return { data: prefix + tag + " " + tail };
            }
            if (fileHandler && isFilePath(content)) {
              const prefix = buffer.slice(0, beginIdx);
              const tail = rest.slice(endIdx + PASTE_END.length);
              const tag = makeFileTag(content);
              fileHandler(ctx, content.trim(), tag);
              return { data: prefix + tag + " " + tail };
            }
            if (urlHandler && isUrl(content)) {
              const prefix = buffer.slice(0, beginIdx);
              const tail = rest.slice(endIdx + PASTE_END.length);
              const trimmedUrl = content.trim();
              const tag = makeUrlTag(trimmedUrl);
              urlHandler(ctx, trimmedUrl, tag);
              return { data: prefix + tag + " " + tail };
            }
            if (houdiniPathMap && containsHoudiniPath(content)) {
              const transformed = replaceHoudiniPaths(content, houdiniPathMap);
              if (transformed !== undefined) {
                const prefix = buffer.slice(0, beginIdx);
                const tail = rest.slice(endIdx + PASTE_END.length);
                return { data: prefix + transformed + tail };
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
      const placeholder = `${tag} `;
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

async function prepareImageForAttachment(image: ClipboardImage): Promise<{ data: string; mimeType: string }> {
  assertImageWithinByteLimit(image.bytes.length, "Image attachment");
  const resized = await resizeClipboardImage(image.bytes, image.mimeType);
  if (resized) return { data: resized.data, mimeType: resized.mimeType };
  return { data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType };
}

export default function piPasteExtension(pi: ExtensionAPI): void {
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

    return {
      action: "transform" as const,
      text: cleanedText,
      images: [...(event.images ?? []), ...images],
    };
  });

  let pasteInterceptorUnsubscribe: (() => void) | undefined;

  const installPasteInterceptor = (ctx: PasteContext): void => {
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
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    installPasteInterceptor(ctx);
  });
}
