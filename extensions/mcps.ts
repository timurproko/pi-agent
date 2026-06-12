/**
 * MCPS Extension — Status Bar + /mcps Command
 *
 * Status bar:
 *   - `mcp: 2/5 (houdini, context-mode)` (connected count + names)
 *   - `mcp: houdini connecting...` (during connection, animated)
 *   - `mcp: 0/5` (none connected)
 *
 * Command:
 *   /mcps — shows the custom MCP server dialog with connection and direct-tool toggles.
 *
 * Runtime:
 *   - The MCP runtime/proxy/direct tools are provided by the global npm package
 *     `pi-mcp-adapter`; this local extension is only the status/command wrapper.
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
import { createCommandTunnelAutocompleteProvider, createCommandTunnelEditorFactory, type CommandTunnel, type CommandTunnelItem } from "./core/command-tunnel";

export const piExtensionDependencies = ["pi-mcp-adapter"];

const STATUS_KEY = "mcp";
const MCPS_COMMAND = "mcps";
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

function getToolResultText(event: any): string {
	const content = event?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && typeof part.text === "string") return part.text;
			return "";
		}).filter(Boolean).join("\n");
	}
	return "";
}

function looksLikeConnectionFailure(event: any): boolean {
	const text = stripAnsi(getToolResultText(event)).toLowerCase();
	return /failed\s+to\s+connect|mcp\s+error|connection\s+closed/.test(text);
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

	const configuredNames = readConfiguredServerNames();
	const configuredOrder = new Map(configuredNames.map((name, index) => [name, index]));
	const sortedConnectedNames = [...connectedNames].sort((a, b) => {
		const aIndex = configuredOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
		const bIndex = configuredOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
		return aIndex - bIndex || a.localeCompare(b);
	});
	const count = sortedConnectedNames.length;
	const counter = `${count}/${total}`;
	const namesSuffix = sortedConnectedNames.length > 0 ? ` (${sortedConnectedNames.join(", ")})` : "";
	return `${paintMuted(ctx, "mcp: ")}${paintMuted(ctx, `${counter}${namesSuffix}`)}`;
}

// ─── Extension ──────────────────────────────────────────────────────

export default function mcpsExtension(pi: ExtensionAPI): void {
	const connectedServers = new Set<string>();
	const failedServers = new Set<string>();
	let toolToServer = buildToolToServerMap();
	let connectingTarget: string | undefined;
	let connectingStartedAt = 0;
	let minDisplayTimer: ReturnType<typeof setTimeout> | undefined;
	let pulseFrame = 0;
	let pulseTimer: ReturnType<typeof setInterval> | undefined;
	let activeCtx: ExtensionContext | null = null;
	let originalSetStatus: ((key: string, text?: string) => void) | null = null;

	const MIN_CONNECTING_DISPLAY_MS = 2500; // UI-only minimum time "mcp: server..." stays visible

	// ─── Status Bar Logic ───────────────────────────────────────────

	function stopPulse(): void {
		if (!pulseTimer) return;
		clearInterval(pulseTimer);
		pulseTimer = undefined;
		pulseFrame = 0;
	}

	function startPulse(ctx: ExtensionContext): void {
		if (!connectingTarget) return;
		if (pulseTimer) return;
		connectingStartedAt = Date.now();
		pulseTimer = setInterval(() => {
			if (!connectingTarget) { stopPulse(); return; }
			pulseFrame += 1;
			updateStatus(ctx);
		}, 250);
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

	const refreshStatus = () => {
		if (activeCtx) updateStatus(activeCtx);
	};
	(globalThis as any).__piMcpsRefreshStatus = refreshStatus;
	// Backward-compatible alias for extensions that still know the old MCP wrapper name.
	(globalThis as any).__piMcpRefreshStatus = refreshStatus;

	function clearConnecting(serverName: string): void {
		if (connectingTarget !== serverName) return;
		connectingTarget = undefined;
		stopPulse();
		if (minDisplayTimer) {
			clearTimeout(minDisplayTimer);
			minDisplayTimer = undefined;
		}
	}

	function markFailed(serverName: string, ctx: ExtensionContext): void {
		connectedServers.delete(serverName);
		failedServers.add(serverName);
		clearConnecting(serverName);
		updateStatus(ctx);
	}

	function finishConnectingAfterMinimum(serverName: string, ctx: ExtensionContext): boolean {
		if (connectingTarget !== serverName) return false;

		const elapsed = Date.now() - connectingStartedAt;
		const remaining = MIN_CONNECTING_DISPLAY_MS - elapsed;

		if (remaining > 0) {
			// Keep showing the animated UI state; the MCP connection has already completed.
			if (minDisplayTimer) clearTimeout(minDisplayTimer);
			minDisplayTimer = setTimeout(() => {
				minDisplayTimer = undefined;
				connectingTarget = undefined;
				stopPulse();
				updateStatus(ctx);
			}, remaining);
			return true;
		}

		connectingTarget = undefined;
		stopPulse();
		return false;
	}

	function markConnected(serverName: string, ctx: ExtensionContext): void {
		failedServers.delete(serverName);
		const wasConnected = connectedServers.has(serverName);
		const wasConnecting = connectingTarget === serverName;
		connectedServers.add(serverName);

		if (finishConnectingAfterMinimum(serverName, ctx)) return;
		if (wasConnected && !wasConnecting) return;
		updateStatus(ctx);
	}

	function resolveServerFromTool(toolName: string): string | undefined {
		let server = toolToServer.get(toolName);
		if (server) return server;

		toolToServer = buildToolToServerMap();
		return toolToServer.get(toolName);
	}

	function resolveMcpInputTarget(input: any): string | undefined {
		const target = input?.connect || input?.server;
		return target && readConfiguredServerNames().includes(String(target)) ? String(target) : undefined;
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
			if (minDisplayTimer) { clearTimeout(minDisplayTimer); minDisplayTimer = undefined; }
			if (connectingTarget !== target) stopPulse();
			connectingTarget = target;
			startPulse(ctx);
			updateStatus(ctx);
			return;
		}

		const countMatch = plain.match(/\bMCP:\s*(\d+)\/(\d+)\s+servers\b/i);
		if (countMatch) {
			const completedTarget = connectingTarget;
			const freshConnected = detectAlreadyConnected(pi);
			for (const name of freshConnected) {
				connectedServers.add(name);
				failedServers.delete(name);
			}

			// The adapter may publish the final count almost immediately. Preserve the
			// animated "mcp: server..." status for a short UI-only minimum so quick
			// connections still feel visible without delaying the actual connection.
			if (completedTarget) {
				connectedServers.add(completedTarget);
				failedServers.delete(completedTarget);
				if (finishConnectingAfterMinimum(completedTarget, ctx)) return;
				updateStatus(ctx);
				return;
			}

			connectingTarget = undefined;
			stopPulse();
			updateStatus(ctx);
			return;
		}

		updateStatus(ctx);
	}

	// ─── /mcps Command ──────────────────────────────────────────────

	function getMcpServers(): { name: string; toolCount: number; connected: boolean; failed: boolean; type: "stdio" | "http" }[] {
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
				failed: failedServers.has(name),
				type,
			};
		});
	}

	function getMcpServerTunnelItems(query: string): CommandTunnelItem[] {
		const normalizedQuery = query.trim().toLowerCase();
		return getMcpServers()
			.filter((server) => !normalizedQuery || server.name.toLowerCase().includes(normalizedQuery) || server.type.includes(normalizedQuery))
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((server) => {
				const state = server.connected ? "connected" : server.failed ? "failed" : "disconnected";
				return {
					value: server.name,
					label: `${MCPS_COMMAND}:${server.name}`,
					description: `${state} · ${server.type} · ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`,
				};
			});
	}

	async function requestMcpConnection(serverName: string, ctx: ExtensionContext): Promise<void> {
		if (!readConfiguredServerNames().includes(serverName)) {
			ctx.ui.notify(`No MCP server named ${serverName}.`, "warning");
			return;
		}
		if (connectedServers.has(serverName)) {
			ctx.ui.notify(`${serverName} is already connected.`, "info");
			return;
		}
		if (!(await askToEnableMcpServer(ctx, serverName))) {
			ctx.ui.notify(`MCP connection cancelled for ${serverName}.`, "info");
			return;
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

	const mcpsTunnel: CommandTunnel = {
		commandName: MCPS_COMMAND,
		getItems: (query) => getMcpServerTunnelItems(query),
	};

	const mcpStatusCommand = {
		description: "Show MCP server connection status",
		handler: async (args: string, ctx: any) => {

			toolToServer = buildToolToServerMap();
			const servers = getMcpServers();

			if (servers.length === 0) {
				ctx.ui.notify("No MCP servers configured in mcp.json", "warning");
				return;
			}

			const requestedServerName = args.trim().split(/\s+/)[0];
			if (requestedServerName && readConfiguredServerNames().includes(requestedServerName)) {
				await requestMcpConnection(requestedServerName, ctx);
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
				title: "MCP servers",
				shortcuts: "↑↓ navigate · enter toggle connection · space direct tools · ctrl+s save · esc close",
				noItemsText: "No MCP servers configured",
				descriptionGap: 1,
				highlightDescription: false,
				getStatusText: () => hasChanges() ? "(unsaved)" : undefined,
				getItems: () => servers.map((server) => {
					const directEnabled = getDesiredDirect(server.name);
					const failed = server.failed && !getDesiredConnection(server.name);
					return {
						value: server.name,
						label: server.name,
						description: `(${server.toolCount})`,
						descriptionSuffix: failed ? "[failed]" : undefined,
						descriptionSuffixColor: failed ? "error" : undefined,
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
						failedServers.delete(serverName);
					}
					const activeTools = pi.getActiveTools().filter((name) => !toolsToRemove.has(name));
					pi.setActiveTools(activeTools);
					if (activeCtx) updateStatus(activeCtx);
				}

				// Connect: ask before enabling/starting any MCP server.
				// Yes allows the MCP connection only; it does not toggle directTools in mcp.json.
				for (const serverName of toConnect) {
					await requestMcpConnection(serverName, ctx);
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

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		const match = event.text.match(/^\/mcps:([^\s]+)(?:\s[\s\S]*)?$/);
		const serverName = match?.[1];
		if (!serverName || !readConfiguredServerNames().includes(serverName)) return { action: "continue" as const };
		if (!ctx.hasUI) return { action: "handled" as const };
		await requestMcpConnection(serverName, ctx);
		return { action: "handled" as const };
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (!pi.getAllTools().some((t) => t.name === "mcp")) return;

		if (!commandRegistered) {
			commandRegistered = true;
			pi.registerCommand(MCPS_COMMAND, mcpStatusCommand);
		}

		ctx.ui.addAutocompleteProvider((provider) => createCommandTunnelAutocompleteProvider(provider, [mcpsTunnel]));
		ctx.ui.setEditorComponent(createCommandTunnelEditorFactory([mcpsTunnel], ctx.ui.getEditorComponent()));

		activeCtx = ctx;
		originalSetStatus = ctx.ui.setStatus.bind(ctx.ui);
		toolToServer = buildToolToServerMap();

		const alreadyConnected = detectAlreadyConnected(pi);
		for (const name of alreadyConnected) {
			connectedServers.add(name);
			failedServers.delete(name);
		}

		ctx.ui.setStatus = ((key: string, text?: string) => {
			interceptSetStatus(ctx, key, text);
		}) as typeof ctx.ui.setStatus;

		updateStatus(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!ctx.hasUI || !originalSetStatus) return;

		const toolName = (event as any).toolName ?? "";
		const input = (event as any).input ?? {};
		const isError = !!(event as any).isError;

		if (toolName === "mcp") {
			const explicitTarget = resolveMcpInputTarget(input);
			if (explicitTarget) {
				if (isError || looksLikeConnectionFailure(event)) {
					markFailed(explicitTarget, ctx);
				} else {
					markConnected(explicitTarget, ctx);
				}
				return;
			}
		}

		if (isError) {
			const failedDirectServer = resolveServerFromTool(toolName);
			if (failedDirectServer && connectingTarget === failedDirectServer && !connectedServers.has(failedDirectServer)) {
				markFailed(failedDirectServer, ctx);
			}
			return;
		}

		// Only detect gateway tool calls through the mcp gateway.
		if (toolName === "mcp") {

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
		failedServers.delete(targetServer);
		if (minDisplayTimer) { clearTimeout(minDisplayTimer); minDisplayTimer = undefined; }
		if (connectingTarget !== targetServer) stopPulse();
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
		failedServers.clear();
	});
}
