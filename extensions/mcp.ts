/**
 * MCP Status Bar Extension
 *
 * Shows actual MCP connection state in the status bar:
 *   - `mcp: 2/5 • houdini, unity-stdio` (connected servers)
 *   - `mcp: houdini connecting…` (during connection)
 *   - `mcp: 0/5` (none connected)
 *
 * Detection uses the same strategy as mcp-list.ts:
 *   - Reads mcp-cache.json for tool→server mapping
 *   - Tracks tool_result events to detect active connections
 *   - Also checks pi.getAllTools() at session start for stdio auto-connects
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "mcp";

// ─── Helpers ────────────────────────────────────────────────────────

function readConfiguredServerNames(): string[] {
	try {
		const configPath = path.join(getAgentDir(), "mcp.json");
		const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
		const servers = raw.mcpServers ?? raw["mcp-servers"] ?? {};
		return Object.keys(servers);
	} catch {
		return [];
	}
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

// ─── Formatting ─────────────────────────────────────────────────────

function ansi(code: number, text: string): string {
	return `\x1b[${code}m${text}\x1b[39m`;
}

function paintMuted(ctx: ExtensionContext, label: string): string {
	try { return ctx.ui.theme.fg("dim", label); } catch { return ansi(90, label); }
}

function paintCyan(label: string): string {
	return ansi(36, label);
}

function paintGreen(label: string): string {
	return ansi(32, label);
}

function formatStatusBar(
	ctx: ExtensionContext,
	connectedNames: string[],
	connectingName?: string,
	pulseFrame = 0,
): string {
	const total = readConfiguredServerNames().length;

	// No servers configured
	if (total === 0) return paintMuted(ctx, "mcp: —");

	// Currently connecting - show server name with animation
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

export default function piMcpExtension(pi: ExtensionAPI): void {
	const connectedServers = new Set<string>();
	let toolToServer = buildToolToServerMap();
	let connectingTarget: string | undefined;
	let pulseFrame = 0;
	let pulseTimer: ReturnType<typeof setInterval> | undefined;
	let activeCtx: ExtensionContext | null = null;
	let originalSetStatus: ((key: string, text?: string) => void) | null = null;

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

		// If we were connecting this server, stop animation
		if (connectingTarget === serverName) {
			connectingTarget = undefined;
			stopPulse();
		}
		updateStatus(ctx);
	}

	function resolveServerFromTool(toolName: string): string | undefined {
		let server = toolToServer.get(toolName);
		if (server) return server;

		// Rebuild index and retry
		toolToServer = buildToolToServerMap();
		return toolToServer.get(toolName);
	}

	// ─── Intercept core MCP status calls ────────────────────────────

	const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

	function stripAnsi(text: string): string {
		return text.replace(ANSI_RE, "");
	}

	function interceptSetStatus(ctx: ExtensionContext, key: string, text?: string): void {
		if (key !== STATUS_KEY || text === undefined) {
			originalSetStatus!(key, text);
			return;
		}

		const plain = stripAnsi(text);

		// Detect "MCP: connecting to X..." from core
		const connectMatch = plain.match(/\bMCP:\s*connecting to\s+(.+?)(?:\.\.\.)?$/i);
		if (connectMatch) {
			let target = connectMatch[1].trim();
			// "connecting to 1 servers" → resolve to actual name
			const countMatch = target.match(/^(\d+)\s+servers?$/i);
			if (countMatch) {
				const names = readConfiguredServerNames();
				if (Number.parseInt(countMatch[1], 10) === 1 && names.length === 1) {
					target = names[0];
				} else {
					// Multiple servers connecting - use first uncconnected
					target = names.find((n) => !connectedServers.has(n)) ?? target;
				}
			}
			connectingTarget = target;
			startPulse(ctx);
			updateStatus(ctx);
			return;
		}

		// Detect "MCP: N/T servers ..." from core (connection complete)
		const countMatch = plain.match(/\bMCP:\s*(\d+)\/(\d+)\s+servers\b/i);
		if (countMatch) {
			connectingTarget = undefined;
			stopPulse();
			// Core is reporting count; refresh our detection
			const freshConnected = detectAlreadyConnected(pi);
			for (const name of freshConnected) connectedServers.add(name);
			updateStatus(ctx);
			return;
		}

		// Unknown MCP status - just format it
		updateStatus(ctx);
	}

	// ─── Events ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (!pi.getAllTools().some((t) => t.name === "mcp")) return;

		activeCtx = ctx;
		originalSetStatus = ctx.ui.setStatus.bind(ctx.ui);
		toolToServer = buildToolToServerMap();

		// Detect already-connected servers (stdio auto-connect before session_start)
		const alreadyConnected = detectAlreadyConnected(pi);
		for (const name of alreadyConnected) connectedServers.add(name);

		// Patch setStatus to intercept core MCP updates
		ctx.ui.setStatus = ((key: string, text?: string) => {
			interceptSetStatus(ctx, key, text);
		}) as typeof ctx.ui.setStatus;

		// Initial render
		updateStatus(ctx);
	});

	// Track connections via tool_result events (same as mcp-list.ts)
	pi.on("tool_result", async (event, ctx) => {
		if (!ctx.hasUI || !originalSetStatus) return;
		if ((event as any).isError) return;

		const toolName = (event as any).toolName ?? "";

		// Direct tool match from cache
		const server = resolveServerFromTool(toolName);
		if (server) {
			markConnected(server, ctx);
			return;
		}

		// MCP gateway tool - check inner tool or connect target
		if (toolName === "mcp" && (event as any).input) {
			const input = (event as any).input;

			// If connecting to a server
			const connectTarget = input.connect || input.server;
			if (connectTarget && readConfiguredServerNames().includes(connectTarget)) {
				markConnected(connectTarget, ctx);
				return;
			}

			// Inner tool call
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

	// Also detect via tool_call for early "connecting" state
	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI || !originalSetStatus) return;

		const toolName = (event as any).toolName ?? "";
		if (toolName !== "mcp") return;

		const input = (event as any).input ?? {};
		const connectTarget = input.connect;
		if (connectTarget && !connectedServers.has(connectTarget)) {
			connectingTarget = connectTarget;
			startPulse(ctx);
			updateStatus(ctx);
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
