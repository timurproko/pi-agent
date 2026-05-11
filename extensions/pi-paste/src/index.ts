import { randomBytes } from "node:crypto";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { readClipboardImage } from "./clipboard.js";
import { getErrorMessage } from "./errors.js";
import { assertImageWithinByteLimit } from "./image-size.js";
import { registerPasteInterceptor } from "./paste-interceptor.js";
import type { ClipboardImage, PasteContext } from "./types.js";

function generateImageTag(): string {
  const hash = randomBytes(3).toString("hex");
  return `[📷 clipboard-${hash}.png]`;
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


function imageToBase64(image: ClipboardImage): string {
  assertImageWithinByteLimit(image.bytes.length, "Image attachment");
  return Buffer.from(image.bytes).toString("base64");
}

export default function imageToolsExtension(pi: ExtensionAPI): void {
  const pendingImages: PendingImage[] = [];
  const pendingFolders: PendingFolder[] = [];
  const pendingFiles: PendingFile[] = [];
  const pendingUrls: PendingUrl[] = [];
  const inflightReads: Promise<void>[] = [];

  const pasteImageFromClipboard = async (ctx: PasteContext, tag: string): Promise<void> => {
    if (!ctx.hasUI) return;

    try {
      const image = await readClipboardImage();
      if (!image) {
        ctx.ui.notify("No image in clipboard \u2013 placeholder will be ignored.", "warning");
        return;
      }

      pendingImages.push({
        type: "image",
        tag,
        data: imageToBase64(image),
        mimeType: image.mimeType,
      });
    } catch (error) {
      ctx.ui.notify(`Image paste failed: ${getErrorMessage(error)}`, "warning");
    }
  };

  // Wrapper that tracks in-flight reads so input handler can await them
  const startImageRead = (ctx: PasteContext, tag: string): void => {
    const promise = pasteImageFromClipboard(ctx, tag);
    inflightReads.push(promise);
    void promise.finally(() => {
      const idx = inflightReads.indexOf(promise);
      if (idx !== -1) inflightReads.splice(idx, 1);
    });
  };

  // On submit, wait for any in-flight reads, then attach images and strip tags
  pi.on("input", async (event) => {
    if (event.source === "extension") {
      return { action: "continue" as const };
    }

    // Check if text contains any image tags — if so, wait for reads to finish
    const hasImageTags = /\[\u{1F4F7} clipboard-[a-f0-9]+\.png\]/u.test(event.text);
    const hasFolderTags = /\[\u{1F4C1} [^\]]+\]/u.test(event.text);
    const hasFileTags = /\[(?:\u{1F4C4}|\u{1F5BC}) {1,2}[^\]]+\]/u.test(event.text);
    const hasUrlTags = /\[\u{1F517} [^\]]+\]/u.test(event.text);

    if (!hasImageTags && !hasFolderTags && !hasFileTags && !hasUrlTags && pendingImages.length === 0 && pendingFolders.length === 0 && pendingFiles.length === 0 && pendingUrls.length === 0 && inflightReads.length === 0) {
      return { action: "continue" as const };
    }

    // Wait for all in-flight clipboard reads to complete
    if (inflightReads.length > 0) {
      await Promise.all([...inflightReads]);
    }

    if (pendingImages.length === 0 && pendingFolders.length === 0 && pendingFiles.length === 0 && pendingUrls.length === 0 && !hasImageTags && !hasFolderTags && !hasFileTags && !hasUrlTags) {
      return { action: "continue" as const };
    }

    const images = pendingImages.splice(0);
    const folders = pendingFolders.splice(0);
    const files = pendingFiles.splice(0);
    const urls = pendingUrls.splice(0);

    // Keep image tags visible in the sent message as visual indicators
    // Only strip orphan tags from failed reads
    let cleanedText = event.text;
    const successTags = new Set(images.map(img => img.tag));
    cleanedText = cleanedText
      .replace(/\[\u{1F4F7} clipboard-[a-f0-9]+\.png\]/gu, (match) =>
        successTags.has(match) ? match : ""
      )
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // Expand short display tags back to full paths / URLs for the agent
    const folderMap = new Map(folders.map(f => [f.tag, f.fullPath]));
    const fileMap = new Map(files.map(f => [f.tag, f.fullPath]));
    const urlMap = new Map(urls.map(u => [u.tag, u.url]));

    cleanedText = cleanedText
      .replace(/\[\u{1F4C1} [^\]]+\]/gu, (match) => {
        const full = folderMap.get(match);
        return full ?? match;
      })
      .replace(/\[(?:\u{1F4C4}|\u{1F5BC}) {1,2}[^\]]+\]/gu, (match) => {
        const full = fileMap.get(match);
        return full ?? match;
      })
      .replace(/\[\u{1F517} [^\]]+\]/gu, (match) => {
        const full = urlMap.get(match);
        return full ?? match;
      });

    return {
      action: "transform" as const,
      text: cleanedText,
      images: [
        ...(event.images ?? []),
        ...images,
      ],
    };
  });

  // Install paste interceptor on session start
  let pasteInterceptorUnsubscribe: (() => void) | undefined;

  const installPasteInterceptor = (ctx: PasteContext): void => {
    if (pasteInterceptorUnsubscribe) return;
    if (!ctx.hasUI) return;

    try {
      pasteInterceptorUnsubscribe = registerPasteInterceptor(
        ctx.ui,
        ctx,
        startImageRead,
        generateImageTag,
        (_ctx: PasteContext, fullPath: string, tag: string) => {
          pendingFolders.push({ tag, fullPath });
        },
        (_ctx: PasteContext, fullPath: string, tag: string) => {
          pendingFiles.push({ tag, fullPath });
        },
        (_ctx: PasteContext, url: string, tag: string) => {
          pendingUrls.push({ tag, url });
        },
      );
    } catch {
      // silently fail
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    installPasteInterceptor(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    installPasteInterceptor(ctx);
  });
}
