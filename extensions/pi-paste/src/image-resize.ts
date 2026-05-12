/**
 * Minimal image resizer for pi-paste.
 *
 * Anthropic's API rejects images whose base64 payload exceeds 5 MB.
 * Clipboard PNGs from large screenshots routinely blow past that limit.
 * This helper uses Photon (WASM) — which is already installed indirectly
 * via pi-coding-agent — to scale and re-encode the image until the
 * base64 payload fits comfortably below the limit.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// 4.5 MB of base64 payload leaves a small safety margin under Anthropic's 5 MB cap.
const DEFAULT_MAX_BASE64_BYTES = 4.5 * 1024 * 1024;
const DEFAULT_MAX_DIMENSION = 2000;
const JPEG_QUALITY_STEPS = [85, 70, 55, 40];

const WASM_FILENAME = "photon_rs_bg.wasm";

const requireFromHere = createRequire(import.meta.url);
const fs = requireFromHere("fs") as typeof import("node:fs");

interface PhotonModule {
  PhotonImage: {
    new_from_byteslice(bytes: Uint8Array): {
      get_width(): number;
      get_height(): number;
      get_bytes(): Uint8Array;
      get_bytes_jpeg(quality: number): Uint8Array;
      free(): void;
    };
  };
  resize(
    image: { get_width(): number; get_height(): number; free(): void },
    width: number,
    height: number,
    filter: number,
  ): {
    get_bytes(): Uint8Array;
    get_bytes_jpeg(quality: number): Uint8Array;
    free(): void;
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
    const resolved =
      typeof file === "string"
        ? file
        : file instanceof URL
          ? fileURLToPath(file)
          : null;
    if (resolved?.endsWith(WASM_FILENAME)) {
      try {
        return originalReadFileSync(...args);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code && err.code !== "ENOENT") throw error;
        for (const fallback of fallbackPaths) {
          if (!fs.existsSync(fallback)) continue;
          return options === undefined
            ? originalReadFileSync(fallback)
            : originalReadFileSync(fallback, options);
        }
        throw error;
      }
    }
    return originalReadFileSync(...args);
  }) as typeof fs.readFileSync;
  try {
    mutableFs.readFileSync = patchedReadFileSync;
  } catch {
    Object.defineProperty(fs, "readFileSync", {
      value: patchedReadFileSync,
      writable: true,
      configurable: true,
    });
  }
  return () => {
    try {
      mutableFs.readFileSync = originalReadFileSync;
    } catch {
      Object.defineProperty(fs, "readFileSync", {
        value: originalReadFileSync,
        writable: true,
        configurable: true,
      });
    }
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
    } catch {
      photonModule = null;
      return null;
    } finally {
      restore();
    }
  })();
  return loadPromise;
}

function base64Size(bytes: Uint8Array): number {
  // base64 length = ceil(n / 3) * 4
  return Math.ceil(bytes.length / 3) * 4;
}

export interface ResizedClipboardImage {
  data: string; // base64
  mimeType: string;
  wasResized: boolean;
}

/**
 * Resize an in-memory image so its base64 representation fits under maxBase64Bytes.
 * Returns null if Photon is unavailable or the image can't be shrunk small enough.
 */
export async function resizeClipboardImage(
  bytes: Uint8Array,
  mimeType: string,
  maxBase64Bytes: number = DEFAULT_MAX_BASE64_BYTES,
): Promise<ResizedClipboardImage | null> {
  if (base64Size(bytes) < maxBase64Bytes) {
    return {
      data: Buffer.from(bytes).toString("base64"),
      mimeType,
      wasResized: false,
    };
  }

  const photon = await loadPhoton();
  if (!photon) return null;

  let image: ReturnType<PhotonModule["PhotonImage"]["new_from_byteslice"]> | null = null;
  try {
    image = photon.PhotonImage.new_from_byteslice(bytes);
    const originalWidth = image.get_width();
    const originalHeight = image.get_height();

    let targetWidth = originalWidth;
    let targetHeight = originalHeight;
    if (targetWidth > DEFAULT_MAX_DIMENSION) {
      targetHeight = Math.max(1, Math.round((targetHeight * DEFAULT_MAX_DIMENSION) / targetWidth));
      targetWidth = DEFAULT_MAX_DIMENSION;
    }
    if (targetHeight > DEFAULT_MAX_DIMENSION) {
      targetWidth = Math.max(1, Math.round((targetWidth * DEFAULT_MAX_DIMENSION) / targetHeight));
      targetHeight = DEFAULT_MAX_DIMENSION;
    }

    let currentWidth = targetWidth;
    let currentHeight = targetHeight;
    while (true) {
      const resized = photon.resize(image, currentWidth, currentHeight, photon.SamplingFilter.Lanczos3);
      try {
        const candidates: Array<{ bytes: Uint8Array; mimeType: string }> = [
          { bytes: resized.get_bytes(), mimeType: "image/png" },
        ];
        for (const q of JPEG_QUALITY_STEPS) {
          candidates.push({ bytes: resized.get_bytes_jpeg(q), mimeType: "image/jpeg" });
        }
        for (const c of candidates) {
          if (base64Size(c.bytes) < maxBase64Bytes) {
            return {
              data: Buffer.from(c.bytes).toString("base64"),
              mimeType: c.mimeType,
              wasResized: true,
            };
          }
        }
      } finally {
        resized.free();
      }

      if (currentWidth <= 1 && currentHeight <= 1) break;
      const nextWidth = currentWidth <= 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
      const nextHeight = currentHeight <= 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
      if (nextWidth === currentWidth && nextHeight === currentHeight) break;
      currentWidth = nextWidth;
      currentHeight = nextHeight;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (image) {
      try {
        image.free();
      } catch {
        // ignore
      }
    }
  }
}
