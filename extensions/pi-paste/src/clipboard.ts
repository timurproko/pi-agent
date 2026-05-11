import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { isErrnoException } from "./errors.js";
import { normalizeMimeType, selectPreferredImageMimeType, SUPPORTED_IMAGE_MIME_TYPES } from "./image-mime.js";
import { runPowerShellCommand } from "./powershell.js";
import type { ClipboardImage, ClipboardModule } from "./types.js";

const require = createRequire(import.meta.url);

const LIST_TYPES_TIMEOUT_MS = 1000;
const READ_TIMEOUT_MS = 5000;
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;
let cachedClipboardModule: ClipboardModule | null | undefined;

interface CommandResult {
  ok: boolean;
  stdout: Buffer;
  missingCommand: boolean;
}

interface ClipboardReadResult {
  available: boolean;
  image: ClipboardImage | null;
}

function hasGraphicalSession(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): boolean {
  return platform !== "linux" || Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
}

function isWaylandSession(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(environment.WAYLAND_DISPLAY) || environment.XDG_SESSION_TYPE === "wayland";
}

function loadClipboardModule(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ClipboardModule | null {
  if (cachedClipboardModule !== undefined) return cachedClipboardModule;
  if (environment.TERMUX_VERSION || !hasGraphicalSession(platform, environment)) {
    cachedClipboardModule = null;
    return null;
  }
  try {
    cachedClipboardModule = require("@mariozechner/clipboard") as ClipboardModule;
  } catch {
    cachedClipboardModule = null;
  }
  return cachedClipboardModule;
}

export function clipboardHasImageSync(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const clipboard = loadClipboardModule(platform, environment);
    if (clipboard && typeof clipboard.hasImage === "function") {
      return Boolean(clipboard.hasImage());
    }
  } catch { /* ignore */ }

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

async function readClipboardImageViaNativeModule(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): Promise<ClipboardReadResult> {
  const clipboard = loadClipboardModule(platform, environment);
  if (!clipboard) return { available: false, image: null };
  if (!clipboard.hasImage()) return { available: true, image: null };

  const imageData = await clipboard.getImageBinary();
  if (!imageData || imageData.length === 0) return { available: true, image: null };

  const bytes = imageData instanceof Uint8Array ? imageData : Uint8Array.from(imageData);
  return { available: true, image: { bytes, mimeType: "image/png" } };
}

function runCommand(command: string, args: string[], timeout: number): CommandResult {
  const result = spawnSync(command, args, { timeout, maxBuffer: MAX_BUFFER_BYTES });
  if (result.error) {
    return { ok: false, stdout: Buffer.alloc(0), missingCommand: isErrnoException(result.error) && result.error.code === "ENOENT" };
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  return { ok: result.status === 0, stdout, missingCommand: false };
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

export async function readClipboardImage(options?: {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
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
    for (const reader of readers) {
      const img = record(reader());
      if (img) return img;
    }
    const native = record(await readClipboardImageViaNativeModule(platform, environment));
    if (native) return native;
  } else {
    const native = record(await readClipboardImageViaNativeModule(platform, environment));
    if (native) return native;
  }

  if (results.some(r => r.available)) return null;
  throw new Error(`No clipboard image reader available on ${platform}.`);
}
