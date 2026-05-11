import { existsSync, statSync } from "node:fs";
import * as path from "node:path";

import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";

import { clipboardHasImageSync } from "./clipboard.js";
import type { PasteContext } from "./types.js";

const PASTE_BEGIN = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const CLIPBOARD_CACHE_MS = 250;

const WIN_PATH_RE = /^[A-Za-z]:\\/;
const UNIX_PATH_RE = /^\//;

function isDirectoryPath(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) return false;
  if (!WIN_PATH_RE.test(trimmed) && !UNIX_PATH_RE.test(trimmed)) return false;
  try {
    return existsSync(trimmed) && statSync(trimmed).isDirectory();
  } catch {
    return false;
  }
}

function isFilePath(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) return false;
  if (!WIN_PATH_RE.test(trimmed) && !UNIX_PATH_RE.test(trimmed)) return false;
  try {
    return existsSync(trimmed) && statSync(trimmed).isFile();
  } catch {
    return false;
  }
}

function makeFolderTag(folderPath: string): string {
  return `[📁 ${path.basename(folderPath.trim())}]`;
}

const IMAGE_EXT_RE = /\.(jpe?g|png)$/i;

function makeFileTag(filePath: string): string {
  const name = path.basename(filePath.trim());
  if (IMAGE_EXT_RE.test(name)) {
    return `[🖼  ${name}]`;
  }
  return `[📄 ${name}]`;
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
  if (trimmed.length <= URL_DISPLAY_MAX) {
    return `[🔗 ${trimmed}]`;
  }
  return `[🔗 ${trimmed.slice(0, URL_DISPLAY_MAX)}...]`;
}


interface InterceptorState {
  swallowing: boolean;
  pendingTail: string;
  lastProbeAtMs: number;
  lastProbeResult: boolean;
}

function probeClipboardImage(state: InterceptorState): boolean {
  const now = Date.now();
  if (now - state.lastProbeAtMs < CLIPBOARD_CACHE_MS) {
    return state.lastProbeResult;
  }
  const result = clipboardHasImageSync();
  state.lastProbeAtMs = now;
  state.lastProbeResult = result;
  return result;
}

export function registerPasteInterceptor(
  ui: ExtensionUIContext,
  ctx: PasteContext,
  handler: (ctx: PasteContext, tag: string) => void,
  generateTag: () => string,
  folderHandler?: (ctx: PasteContext, fullPath: string, tag: string) => void,
  fileHandler?: (ctx: PasteContext, fullPath: string, tag: string) => void,
  urlHandler?: (ctx: PasteContext, url: string, tag: string) => void,
): () => void {
  if (!ui || typeof ui.onTerminalInput !== "function") {
    return () => {};
  }

  const state: InterceptorState = {
    swallowing: false,
    pendingTail: "",
    lastProbeAtMs: 0,
    lastProbeResult: false,
  };

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
          if (buffer.slice(buffer.length - len) === PASTE_BEGIN.slice(0, len)) {
            holdBack = len;
          }
        }
        const passthrough = buffer.slice(0, buffer.length - holdBack);
        state.pendingTail = buffer.slice(buffer.length - holdBack);
        if (passthrough.length === 0 && holdBack > 0) {
          return { consume: true };
        }
        return passthrough === data ? undefined : { data: passthrough };
      }

      const hasImage = probeClipboardImage(state);
      if (!hasImage) {
        // Check for folder path in single-chunk paste
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
