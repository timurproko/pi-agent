/**
 * MCP Extension — Status Bar + /mcp-list Command
 *
 * Status bar:
 *   - `mcp: 2/5` (connected count)
 *   - `mcp: houdini connecting...` (during connection, animated)
 *   - `mcp: 0/5` (none connected)
 *
 * Command:
 *   /mcp-list — shows all configured MCP servers with connection state (● connected, ○ not)
 *
 * Detection:
 *   - Reads mcp-cache.json for tool→server mapping
 *   - Tracks tool_result events to detect active connections
 *   - Checks pi.getAllTools() at session start for stdio auto-connects
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "mcp";
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// ─── Shared Helpers ─────────────────────────────────────────────────

function readConfiguredServers(): Record<string, any> {
	try {
		const configPath = path.join(getAgentDir(), "mcp.json");
		const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
		return raw.mcpServers ?? raw["mcp-servers"] ?? {};
	} catch {
		return {};
	}
}

function readConfiguredServerNames(): string[] {
	return Object.keys(readConfiguredServers());
}

function readCache(): Record<string, { tools?: any[] }> {
	try {
		const cachePath = path.join(getAgentDir(), "mcp-cache.json");
		const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
		return raw.servers ?? {};
	} catch {
		return {};
	}
}

function buildToolToServerMap(): Map<string, string> {
	const map = new Map<string, string>();
	const cache = readCache();
	for (const [serverName, serverData] of Object.entries(cache)) {
		const tools = serverData?.tools ?? [];
		for (const tool of tools) {
			const toolName = typeof tool === "string" ? tool : tool?.name;
			if (!toolName) continue;
			map.set(toolName, serverName);
			const normalized = serverName.replace(/-/g, "_");
			map.set(`${normalized}_${toolName}`, serverName);
			map.set(`${serverName}_${toolName}`, serverName);
		}
	}
	return map;
}

function detectAlreadyConnected(pi: ExtensionAPI): Set<string> {
	const configured = readConfiguredServerNames();
	const toolNames = new Set(pi.getAllTools().map((t) => t.name));
	const connected = new Set<string>();

	for (const name of configured) {
		const normalized = name.replace(/-/g, "_");
		const prefix = `${normalized}_`;
		for (const tn of toolNames) {
			if (tn === name || tn === normalized || tn.startsWith(prefix)) {
				connected.add(name);
				break;
			}
		}
	}
	return connected;
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

// ─── Formatting ─────────────────────────────────────────────────────

function ansi(code: number, text: string): string {
	return `\x1b[${code}m${text}\x1b[39m`;
}

function paintMuted(ctx: ExtensionContext, label: string): string {
	try { return ctx.ui.theme.fg("dim", label); } catch { return ansi(90, label); }
}

function formatStatusBar(
	ctx: ExtensionContext,
	connectedNames: string[],
	connectingName?: string,
	pulseFrame = 0,
): string {
	const total = readConfiguredServerNames().length;

	if (total === 0) return paintMuted(ctx, "mcp: —");

	if (connectingName) {
		const dots = ".".repeat((pulseFrame % 3) + 1);
		const pad = " ".repeat(3 - dots.length);
		return `${paintMuted(ctx, "mcp: ")}${paintMuted(ctx, `${connectingName} connecting${dots}${pad}`)}`;
	}

	const count = connectedNames.length;
	const counter = `${count}/${total}`;
	return `${paintMuted(ctx, "mcp: ")}${paintMuted(ctx, counter)}`;
}

// ─── Extension ──────────────────────────────────────────────────────

export default function mcpExtension(pi: ExtensionAPI): void {
	const connectedServers = new Set<string>();
	let toolToServer = buildToolToServerMap();
	let connectingTarget: string | undefined;
	let pulseFrame = 0;
	let pulseTimer: ReturnType<typeof setInterval> | undefined;
	let activeCtx: ExtensionContext | null = null;
	let originalSetStatus: ((key: string, text?: string) => void) | null = null;

	// ─── Status Bar Logic ───────────────────────────────────────────

	function stopPulse(): void {
		if (!pulseTimer) return;
		clearInterval(pulseTimer);
		pulseTimer = undefined;
		pulseFrame = 0;
	}

	function startPulse(ctx: ExtensionContext): void {
		if (pulseTimer) return;
		pulseTimer = setInterval(() => {
			if (!connectingTarget) { stopPulse(); return; }
			pulseFrame += 1;
			updateStatus(ctx);
		}, 400);
	}

	function updateStatus(ctx: ExtensionContext): void {
		const text = formatStatusBar(
			ctx,
			Array.from(connectedServers),
			connectingTarget,
			pulseFrame,
		);
		if (originalSetStatus) {
			originalSetStatus(STATUS_KEY, text);
		}
	}

	function markConnected(serverName: string, ctx: ExtensionContext): void {
		if (connectedServers.has(serverName)) return;
		connectedServers.add(serverName);

		if (connectingTarget === serverName) {
			connectingTarget = undefined;
			stopPulse();
		}
		updateStatus(ctx);
	}

	function resolveServerFromTool(toolName: string): string | undefined {
		let server = toolToServer.get(toolName);
		if (server) return server;

		toolToServer = buildToolToServerMap();
		return toolToServer.get(toolName);
	}

	function interceptSetStatus(ctx: ExtensionContext, key: string, text?: string): void {
		if (key !== STATUS_KEY || text === undefined) {
			originalSetStatus!(key, text);
			return;
		}

		const plain = stripAnsi(text);

		const connectMatch = plain.match(/\bMCP:\s*connecting to\s+(.+?)(?:\.\.\.)?$/i);
		if (connectMatch) {
			let target = connectMatch[1].trim();
			const countMatch = target.match(/^(\d+)\s+servers?$/i);
			if (countMatch) {
				const names = readConfiguredServerNames();
				if (Number.parseInt(countMatch[1], 10) === 1 && names.length === 1) {
					target = names[0];
				} else {
					target = names.find((n) => !connectedServers.has(n)) ?? target;
				}
			}
			connectingTarget = target;
			startPulse(ctx);
			updateStatus(ctx);
			return;
		}

		const countMatch = plain.match(/\bMCP:\s*(\d+)\/(\d+)\s+servers\b/i);
		if (countMatch) {
			connectingTarget = undefined;
			stopPulse();
			const freshConnected = detectAlreadyConnected(pi);
			for (const name of freshConnected) connectedServers.add(name);
			updateStatus(ctx);
			return;
		}

		updateStatus(ctx);
	}

	// ─── /mcp-list Command ──────────────────────────────────────────

	function getMcpServers(): { name: string; toolCount: number; connected: boolean; type: "stdio" | "http" }[] {
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

	pi.registerCommand("mcp-list", {
		description: "Show MCP server connection status",
		handler: async (_args, ctx) => {
			toolToServer = buildToolToServerMap();
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

	// ─── Events ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (!pi.getAllTools().some((t) => t.name === "mcp")) return;

		activeCtx = ctx;
		originalSetStatus = ctx.ui.setStatus.bind(ctx.ui);
		toolToServer = buildToolToServerMap();

		const alreadyConnected = detectAlreadyConnected(pi);
		for (const name of alreadyConnected) connectedServers.add(name);

		ctx.ui.setStatus = ((key: string, text?: string) => {
			interceptSetStatus(ctx, key, text);
		}) as typeof ctx.ui.setStatus;

		updateStatus(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!ctx.hasUI || !originalSetStatus) return;
		if ((event as any).isError) return;

		const toolName = (event as any).toolName ?? "";

		const server = resolveServerFromTool(toolName);
		if (server) {
			markConnected(server, ctx);
			return;
		}

		if (toolName === "mcp" && (event as any).input) {
			const input = (event as any).input;

			const connectTarget = input.connect || input.server;
			if (connectTarget && readConfiguredServerNames().includes(connectTarget)) {
				markConnected(connectTarget, ctx);
				return;
			}

			const innerTool = input.tool || input.name;
			if (innerTool) {
				const innerServer = resolveServerFromTool(innerTool);
				if (innerServer) {
					markConnected(innerServer, ctx);
					return;
				}
			}
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI || !originalSetStatus) return;

		const toolName = (event as any).toolName ?? "";
		const input = (event as any).input ?? {};

		if (toolName === "mcp" && input.connect && !connectedServers.has(input.connect)) {
			connectingTarget = input.connect;
			startPulse(ctx);
			updateStatus(ctx);
			return;
		}

		if (toolName === "mcp" && input.tool) {
			const server = resolveServerFromTool(input.tool);
			if (server && !connectedServers.has(server)) {
				connectingTarget = server;
				startPulse(ctx);
				updateStatus(ctx);
				return;
			}
		}

		if (toolName !== "mcp") {
			const server = resolveServerFromTool(toolName);
			if (server && !connectedServers.has(server)) {
				connectingTarget = server;
				startPulse(ctx);
				updateStatus(ctx);
			}
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI || !originalSetStatus) return;
		stopPulse();
		ctx.ui.setStatus = originalSetStatus as typeof ctx.ui.setStatus;
		originalSetStatus = null;
		activeCtx = null;
		connectedServers.clear();
	});
}
