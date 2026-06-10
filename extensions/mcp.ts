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
import { EditorConfirmModal, EditorModal } from "./core/editor-ui";

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

function isDirectToolsEnabled(serverName: string): boolean {
	return !!readConfiguredServers()[serverName]?.directTools;
}

function setDirectToolsEnabled(serverName: string, enabled: boolean): boolean {
	try {
		const configPath = path.join(getAgentDir(), "mcp.json");
		const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
		const mcpServers = raw.mcpServers ?? raw["mcp-servers"] ?? {};
		if (!mcpServers[serverName]) return false;
		mcpServers[serverName].directTools = enabled;
		fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
		return true;
	} catch {
		return false;
	}
}

async function askToEnableMcpServer(ctx: ExtensionContext, serverName: string): Promise<boolean> {
	return await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => new EditorConfirmModal({
		tui,
		theme,
		keybindings,
		title: "Enable MCP server",
		subtitle: `Proceed to connect to ${serverName} server?`,
		onConfirm: () => done(true),
		onCancel: () => done(false),
	}));
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
	const configured = readConfiguredServers();
	const toolNames = new Set(pi.getAllTools().map((t) => t.name));
	const connected = new Set<string>();

	for (const [name, serverConfig] of Object.entries(configured)) {
		// Skip direct-tool servers — their tools are always available, not MCP-connected
		if (serverConfig?.directTools) continue;

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
		const dots = ".".repeat(pulseFrame % 4);
		const pad = " ".repeat(3 - Math.min(dots.length, 3));
		return `${paintMuted(ctx, "mcp: ")}${paintMuted(ctx, `${connectingName}${dots}${pad}`)}`;
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
	let connectingStartedAt = 0;
	let minDisplayTimer: ReturnType<typeof setTimeout> | undefined;
	let pulseFrame = 0;
	let pulseTimer: ReturnType<typeof setInterval> | undefined;
	let activeCtx: ExtensionContext | null = null;
	let originalSetStatus: ((key: string, text?: string) => void) | null = null;

	const MIN_CONNECTING_DISPLAY_MS = 600; // minimum time "connecting..." stays visible

	// ─── Status Bar Logic ───────────────────────────────────────────

	function stopPulse(): void {
		if (!pulseTimer) return;
		clearInterval(pulseTimer);
		pulseTimer = undefined;
		pulseFrame = 0;
	}

	function startPulse(ctx: ExtensionContext): void {
		if (pulseTimer) return;
		connectingStartedAt = Date.now();
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

	(globalThis as any).__piMcpRefreshStatus = () => {
		if (activeCtx) updateStatus(activeCtx);
	};

	function markConnected(serverName: string, ctx: ExtensionContext): void {
		if (connectedServers.has(serverName)) return;
		connectedServers.add(serverName);

		if (connectingTarget === serverName) {
			const elapsed = Date.now() - connectingStartedAt;
			const remaining = MIN_CONNECTING_DISPLAY_MS - elapsed;

			if (remaining > 0) {
				// Keep showing "connecting..." for the minimum duration
				if (minDisplayTimer) clearTimeout(minDisplayTimer);
				minDisplayTimer = setTimeout(() => {
					minDisplayTimer = undefined;
					connectingTarget = undefined;
					stopPulse();
					updateStatus(ctx);
				}, remaining);
				return;
			}

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

	const mcpStatusCommand = {
		description: "Show MCP server connection status",
		handler: async (_args: string, ctx: any) => {

			toolToServer = buildToolToServerMap();
			const servers = getMcpServers();

			if (servers.length === 0) {
				ctx.ui.notify("No MCP servers configured in mcp.json", "warning");
				return;
			}

			// Read current directTools state from config
			const mcpConfig = readConfiguredServers();
			const directState = new Map<string, boolean>();
			for (const name of Object.keys(mcpConfig)) {
				directState.set(name, isDirectToolsEnabled(name));
			}

			// Track desired connection changes: true=connect, false=disconnect, undefined=no change
			const connectionChanges = new Map<string, boolean>();
			// Track desired directTools changes
			const directChanges = new Map<string, boolean>();

			const getDesiredConnection = (name: string): boolean => {
				const server = servers.find((candidate) => candidate.name === name);
				return connectionChanges.has(name) ? connectionChanges.get(name)! : server?.connected ?? false;
			};
			const getDesiredDirect = (name: string): boolean => directChanges.has(name)
				? directChanges.get(name)!
				: directState.get(name) ?? false;
			const hasChanges = (): boolean => {
				for (const [name, want] of connectionChanges) {
					const original = servers.find((server) => server.name === name)?.connected ?? false;
					if (want !== original) return true;
				}
				for (const [name, want] of directChanges) {
					const original = directState.get(name) ?? false;
					if (want !== original) return true;
				}
				return false;
			};

			const result = await ctx.ui.custom((tui, theme, keybindings, done) => new EditorModal<string>({
				tui,
				theme,
				keybindings,
				title: "MCP Servers",
				shortcuts: "↑↓ navigate · enter toggle connection · space direct tools · ctrl+s save · esc close",
				noItemsText: "No MCP servers configured",
				descriptionGap: 1,
				highlightDescription: false,
				getStatusText: () => hasChanges() ? "(unsaved)" : undefined,
				getItems: () => servers.map((server) => {
					const directEnabled = getDesiredDirect(server.name);
					return {
						value: server.name,
						label: server.name,
						description: `(${server.toolCount})`,
						prefixIcon: directEnabled ? "●" : "○",
						prefixIconColor: directEnabled ? "success" : "dim",
						checked: getDesiredConnection(server.name),
					};
				}),
				onSelect: (item) => {
					const current = getDesiredConnection(item.value);
					connectionChanges.set(item.value, !current);
				},
				onCancel: () => done(undefined),
				onInput: (data, _filter, selectedItem) => {
					if (data === " ") {
						if (!selectedItem) return true;
						const current = getDesiredDirect(selectedItem.value);
						directChanges.set(selectedItem.value, !current);
						return true;
					}
					if (data === "\x13") {
						done({ action: "apply", connectionChanges: Object.fromEntries(connectionChanges), directChanges: Object.fromEntries(directChanges) });
						return true;
					}
					return false;
				},
			}));

			if (result && typeof result === "object" && (result as any).action === "apply") {
				const connChanges: Record<string, boolean> = (result as any).connectionChanges ?? {};
				const dirChanges: Record<string, boolean> = (result as any).directChanges ?? {};

				// Handle connection changes
				const toConnect: string[] = [];
				const toDisconnect: string[] = [];
				for (const [name, want] of Object.entries(connChanges)) {
					const server = servers.find(s => s.name === name);
					if (!server) continue;
					if (want && !server.connected) toConnect.push(name);
					if (!want && server.connected) toDisconnect.push(name);
				}

				// Disconnect: remove tools from active set
				if (toDisconnect.length > 0) {
					const toolsToRemove = new Set<string>();
					for (const serverName of toDisconnect) {
						const normalized = serverName.replace(/-/g, "_");
						const prefix = `${normalized}_`;
						for (const tool of pi.getAllTools()) {
							if (tool.name === serverName || tool.name === normalized || tool.name.startsWith(prefix)) {
								toolsToRemove.add(tool.name);
							}
						}
						connectedServers.delete(serverName);
					}
					const activeTools = pi.getActiveTools().map(t => t.name).filter(n => !toolsToRemove.has(n));
					pi.setActiveTools(activeTools);
					if (activeCtx) updateStatus(activeCtx);
				}

				// Connect: ask before enabling/starting any MCP server.
				// Yes allows the MCP connection only; it does not toggle directTools in mcp.json.
				const skippedAutoConnect: string[] = [];
				for (const serverName of toConnect) {
					if (!(await askToEnableMcpServer(ctx, serverName))) {
						skippedAutoConnect.push(serverName);
						continue;
					}

					pi.sendMessage(
						{
							customType: "mcp-connect",
							content: `Connect to the "${serverName}" MCP server. Use: mcp({ connect: "${serverName}" })`,
							display: false,
						},
						{ triggerTurn: true, deliverAs: "steer" },
					);
				}
				if (skippedAutoConnect.length > 0) {
					ctx.ui.notify(
						`MCP connection cancelled for ${skippedAutoConnect.join(", ")}.`,
						"info",
					);
				}

				// Handle directTools changes — write to mcp.json and reload
				let configChanged = false;
				for (const [name, want] of Object.entries(dirChanges)) {
					const current = directState.get(name) ?? false;
					if (want !== current) configChanged = true;
				}
				if (configChanged) {
					try {
						const configPath = path.join(getAgentDir(), "mcp.json");
						const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
						const mcpServers = raw.mcpServers ?? raw["mcp-servers"] ?? {};
						for (const [name, want] of Object.entries(dirChanges)) {
							if (mcpServers[name]) {
								mcpServers[name].directTools = want;
							}
						}
						fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
						await ctx.reload();
					} catch (e) {
						ctx.ui.notify(`Failed to update mcp.json: ${e}`, "error");
					}
				}
			}
		},
	};

	let commandRegistered = false;

	// ─── Events ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (!pi.getAllTools().some((t) => t.name === "mcp")) return;

		if (!commandRegistered) {
			commandRegistered = true;
			pi.registerCommand("mcp-status", mcpStatusCommand);
		}

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

		// Only detect connections through the mcp gateway, not direct tools
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
		const directToolServer = resolveServerFromTool(toolName);
		if (directToolServer) {
			markConnected(directToolServer, ctx);
		}

	});

	pi.on("tool_call", async (event, ctx) => {
		const toolName = (event as any).toolName ?? "";
		const input = (event as any).input ?? {};
		const configuredNames = readConfiguredServerNames();

		let targetServer: string | undefined;
		if (toolName === "mcp") {
			const explicitTarget = input.connect || input.server;
			targetServer = explicitTarget && configuredNames.includes(String(explicitTarget))
				? String(explicitTarget)
				: input.tool
					? resolveServerFromTool(input.tool)
					: undefined;
		} else {
			targetServer = resolveServerFromTool(toolName);
		}

		// Ask before starting any configured MCP server. This is universal: it
		// covers the mcp gateway and direct server tools such as ctx_execute.
		// Skip the prompt if directTools is enabled — auto-connect silently.
		if (targetServer && !connectedServers.has(targetServer) && !isDirectToolsEnabled(targetServer)) {
			if (!ctx.hasUI) {
				return { block: true, reason: `MCP connect blocked: enable the ${targetServer} server first.` };
			}

			const enableMcpServer = await askToEnableMcpServer(ctx, targetServer);
			if (!enableMcpServer) {
				return { block: true, reason: `MCP connect cancelled for ${targetServer}.` };
			}
		}

		if (!ctx.hasUI || !originalSetStatus || !targetServer || connectedServers.has(targetServer)) return;

		// Show connection progress after the user has allowed this MCP server.
		connectingTarget = targetServer;
		startPulse(ctx);
		updateStatus(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI || !originalSetStatus) return;
		stopPulse();
		if (minDisplayTimer) { clearTimeout(minDisplayTimer); minDisplayTimer = undefined; }
		ctx.ui.setStatus = originalSetStatus as typeof ctx.ui.setStatus;
		originalSetStatus = null;
		activeCtx = null;
		connectedServers.clear();
	});
}
