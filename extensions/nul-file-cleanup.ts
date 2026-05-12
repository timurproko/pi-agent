import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isBashToolResult } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Automatically deletes Windows `nul` files created by tools that
 * redirect to /dev/null (which on Windows can create a literal "nul" file).
 */
export default function (pi: ExtensionAPI) {
  function tryDeleteNul(dir: string) {
    const nulPath = path.join(dir, "nul");
    try {
      const stat = fs.statSync(nulPath);
      if (stat.isFile()) {
        fs.unlinkSync(nulPath);
      }
    } catch {}
  }

  pi.on("tool_result", async (event, ctx) => {
    const dirsToCheck = new Set<string>();
    dirsToCheck.add(ctx.cwd);

    if (isBashToolResult(event)) {
      const cmd = (event.input as { command?: string })?.command ?? "";
      const cdMatch = cmd.match(/cd\s+["']?([^"'\s;&|]+)/);
      if (cdMatch) {
        dirsToCheck.add(path.resolve(ctx.cwd, cdMatch[1]));
      }
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = (event.input as { path?: string })?.path;
      if (filePath) {
        dirsToCheck.add(path.dirname(path.resolve(ctx.cwd, filePath)));
      }
    }

    for (const dir of dirsToCheck) {
      tryDeleteNul(dir);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    tryDeleteNul(ctx.cwd);
  });
}
