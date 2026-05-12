import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const project = path.basename(ctx.cwd);
    ctx.ui.setTitle(`pi • ${project}`);
  });
}
