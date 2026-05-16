/**
 * MCP List Extension
 *
 * Provides a /mcp-list command that shows all configured MCP servers
 * from mcp.json with clear visual indicators for connection state.
 *
 * Style matches the built-in Extensions dialog.
 *
 * Usage: Type /mcp-list to open the MCP server status dialog.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface McpServerInfo {
  name: string;
  toolCount: number;
  connected: boolean;
  type: "stdio" | "http";
}

export default function mcpListExtension(pi: ExtensionAPI) {
  function getMcpServers(): McpServerInfo[] {
    const configPath = join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".pi",
      "agent",
      "mcp.json",
    );

    let config: { mcpServers?: Record<string, any> } = {};
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      return [];
    }

    const mcpServers = config.mcpServers ?? {};

    // Get currently loaded tools to determine connection state
    const allTools = pi.getAllTools();
    const toolsByServer = new Map<string, number>();

    for (const tool of allTools) {
      const { source } = tool.sourceInfo;
      if (source === "builtin" || source === "sdk") continue;
      toolsByServer.set(source, (toolsByServer.get(source) ?? 0) + 1);
    }

    // Read cache for tool counts of disconnected servers
    const cachePath = join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".pi",
      "agent",
      "mcp-cache.json",
    );

    let cache: { servers?: Record<string, { tools?: any[] }> } = {};
    try {
      cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    } catch {}

    return Object.entries(mcpServers).map(([name, serverConfig]) => {
      const connected = toolsByServer.has(name);
      const loadedCount = toolsByServer.get(name) ?? 0;
      const cachedCount = cache.servers?.[name]?.tools?.length ?? 0;
      const type: "stdio" | "http" =
        serverConfig.type === "http" || serverConfig.url ? "http" : "stdio";

      return {
        name,
        toolCount: connected ? loadedCount : cachedCount,
        connected,
        type,
      };
    });
  }

  pi.registerCommand("mcp-list", {
    description: "Show MCP server connection status",
    handler: async (_args, ctx) => {
      const servers = getMcpServers();

      if (servers.length === 0) {
        ctx.ui.notify("No MCP servers configured in mcp.json", "warning");
        return;
      }

      await ctx.ui.custom((tui, theme, _kb, done) => {
        let selectedIndex = 0;

        const component = {
          render(width: number): string[] {
            const lines: string[] = [];
            // Top border (full width)
            lines.push(theme.fg("border", "─".repeat(width)));
            lines.push("");

            // Title
            lines.push(theme.fg("accent", theme.bold("MCP Servers")));
            lines.push("");

            // Server list
            // Pad badge and name columns for alignment
            const badgeWidth = 7; // [stdio] or [http] padded
            const nameWidth = Math.max(...servers.map(s => s.name.length));

            for (let i = 0; i < servers.length; i++) {
              const server = servers[i];
              const isSelected = i === selectedIndex;

              const cursor = isSelected ? "→ " : "  ";
              const badgeText = `[${server.type}]`.padEnd(badgeWidth);
              const paddedName = server.name.padEnd(nameWidth);

              const status = server.connected
                ? theme.fg("success", "✓")
                : theme.fg("dim", "×");

              if (isSelected) {
                // Entire row in accent color
                const row = `${cursor}${badgeText} ${paddedName}  ${server.connected ? "✓" : "×"}`;
                lines.push(theme.fg("accent", row));
              } else {
                const badge = theme.fg("dim", badgeText);
                lines.push(`${cursor}${badge} ${paddedName}  ${status}`);
              }
            }

            lines.push("");

            // Footer hints
            lines.push(
              theme.fg("dim", "space toggle · enter connect · esc cancel"),
            );

            // Bottom border (full width)
            lines.push(theme.fg("border", "─".repeat(width)));

            return lines;
          },

          handleInput(data: string) {
            if (data === "\x1B[A" || data === "k") {
              selectedIndex = Math.max(0, selectedIndex - 1);
            } else if (data === "\x1B[B" || data === "j") {
              selectedIndex = Math.min(servers.length - 1, selectedIndex + 1);
            } else if (data === "\x1B" || data === "q") {
              done(undefined);
              return;
            }
            tui.requestRender();
          },

          invalidate() {},
        };

        return component;
      });
    },
  });
}
