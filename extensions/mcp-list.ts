/**
 * MCP List Extension
 *
 * Provides a /mcp-list command that shows all configured MCP servers
 * with connection state detected dynamically from tool usage.
 *
 * Detection: reads mcp-cache.json which maps server → tool names.
 * When any tool is called successfully, checks if it belongs to a server.
 * No hardcoded server names or tool prefixes.
 *
 * Usage: Type /mcp-list to open the MCP server status dialog.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface McpServerInfo {
  name: string;
  toolCount: number;
  connected: boolean;
  type: "stdio" | "http";
}

export default function mcpListExtension(pi: ExtensionAPI) {
  const connectedServers = new Set<string>();

  // Build a reverse lookup: tool_name → server_name (from cache)
  let toolToServer = new Map<string, string>();

  function readConfiguredServers(): Record<string, any> {
    try {
      const configPath = join(getAgentDir(), "mcp.json");
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      return raw.mcpServers ?? raw["mcp-servers"] ?? {};
    } catch {
      return {};
    }
  }

  function readCache(): Record<string, { tools?: any[] }> {
    try {
      const cachePath = join(getAgentDir(), "mcp-cache.json");
      const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
      return raw.servers ?? {};
    } catch {
      return {};
    }
  }

  function rebuildToolIndex(): void {
    toolToServer.clear();
    const cache = readCache();
    const configured = Object.keys(readConfiguredServers());
    for (const [serverName, serverData] of Object.entries(cache)) {
      const tools = serverData?.tools ?? [];
      for (const tool of tools) {
        const toolName = typeof tool === "string" ? tool : tool?.name;
        if (toolName) {
          // Store both raw name and prefixed variants
          toolToServer.set(toolName, serverName);
          // MCP gateway prefixes tools with servername_
          const normalized = serverName.replace(/-/g, "_");
          toolToServer.set(`${normalized}_${toolName}`, serverName);
          toolToServer.set(`${serverName}_${toolName}`, serverName);
        }
      }
    }
  }

  function getMcpServers(): McpServerInfo[] {
    const mcpServers = readConfiguredServers();
    const cache = readCache();

    return Object.entries(mcpServers).map(([name, serverConfig]: [string, any]) => {
      const cachedCount = cache[name]?.tools?.length ?? 0;
      const type: "stdio" | "http" =
        serverConfig.type === "http" || serverConfig.url ? "http" : "stdio";

      return {
        name,
        toolCount: cachedCount,
        connected: connectedServers.has(name),
        type,
      };
    });
  }

  // Build tool index on startup
  pi.on("session_start", async (_event, _ctx) => {
    rebuildToolIndex();
  });

  // Detect connections: when any tool is called successfully,
  // check if it belongs to a cached MCP server
  pi.on("tool_result", async (event, _ctx) => {
    if (event.isError) return;

    // Direct tool match from cache (e.g. ctx_execute_file → context-mode)
    const server = toolToServer.get(event.toolName);
    if (server) {
      connectedServers.add(server);
      return;
    }

    // MCP gateway tool: check the inner tool name from input args
    if (event.toolName === "mcp" && (event as any).input) {
      const input = (event as any).input;
      const innerTool = input.tool || input.name;
      if (innerTool) {
        const innerServer = toolToServer.get(innerTool);
        if (innerServer) {
          connectedServers.add(innerServer);
          return;
        }
        // Retry with rebuilt index
        rebuildToolIndex();
        const retry = toolToServer.get(innerTool);
        if (retry) {
          connectedServers.add(retry);
          return;
        }
      }
      // Also check the server/connect arg directly
      const connectTarget = input.connect || input.server;
      if (connectTarget && readConfiguredServers()[connectTarget]) {
        connectedServers.add(connectTarget);
        return;
      }
    }

    // Rebuild index and retry for unknown tools
    rebuildToolIndex();
    const retryServer = toolToServer.get(event.toolName);
    if (retryServer) {
      connectedServers.add(retryServer);
    }
  });

  pi.registerCommand("mcp-list", {
    description: "Show MCP server connection status",
    handler: async (_args, ctx) => {
      // Refresh index before showing (in case cache updated)
      rebuildToolIndex();
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
            lines.push(theme.fg("border", "─".repeat(width)));
            lines.push("");
            lines.push(theme.fg("accent", theme.bold("MCP Servers")));
            lines.push("");

            const nameWidth = Math.max(...servers.map(s => s.name.length));

            for (let i = 0; i < servers.length; i++) {
              const server = servers[i];
              const isSelected = i === selectedIndex;

              const cursor = isSelected ? "→ " : "  ";
              const paddedName = server.name.padEnd(nameWidth);
              const toolsBadge = `(${server.toolCount})`;

              const bulb = server.connected
                ? theme.fg("success", "●")
                : theme.fg("dim", "○");

              if (isSelected) {
                lines.push(theme.fg("accent", cursor) + bulb + theme.fg("accent", ` ${paddedName} ${toolsBadge}`));
              } else {
                lines.push(`${cursor}${bulb} ${paddedName} ${theme.fg("dim", toolsBadge)}`);
              }
            }

            lines.push("");
            lines.push(theme.fg("dim", "↑↓ navigate · esc close"));
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
