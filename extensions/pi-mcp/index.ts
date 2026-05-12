import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "mcp";
const PATCH_KEY = "__piMcpStatusPatch";
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

interface StatusPatch {
	originalSetStatus: (key: string, text?: string) => void;
	formatter: (key: string, text?: string) => string | undefined;
}

interface FormatterState {
	connectedNames: string[];
	lastConnected: number;
	pendingTarget?: string;
	pulseFrame: number;
	pulseTimer?: ReturnType<typeof setInterval>;
}

// Module-level mirror of the most recently observed connected-server set.
// Used by the tool_result listener to demote a server on connection loss
// without ever calling into pi-mcp-adapter.
let lastConnectedNames: string[] = [];

// Regexes that indicate an MCP server's transport/app connection is dead, not
// just that a tool call returned a logical error. Keep these tight to avoid
// demoting servers for unrelated failures (bad args, missing tool, etc.).
const CONNECTION_LOSS_PATTERNS: RegExp[] = [
	/could not connect to\b/i,
	/forcibly closed by the remote host/i,
	/connection (?:was )?(?:reset|closed|refused|aborted|lost)/i,
	/econnrefused|econnreset|epipe|enotconn|etimedout/i,
	/socket hang up/i,
	/is the (?:plugin|server) running/i,
	/no .+ instances? found/i,
	/please ensure .+ (?:is )?running/i,
	/mcp for .+ bridge/i,
	/not connected to mcp server/i,
	/transport (?:closed|disconnected|error)/i,
];

interface McpConfig {
	mcpServers?: Record<string, unknown>;
	"mcp-servers"?: Record<string, unknown>;
}

type PatchableUi = ExtensionContext["ui"] & {
	__piMcpStatusPatch?: StatusPatch;
};

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function readConfiguredServerNames(): string[] {
	try {
		const configPath = path.join(getAgentDir(), "mcp.json");
		const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as McpConfig;
		const servers = raw.mcpServers ?? raw["mcp-servers"] ?? {};
		return Object.keys(servers);
	} catch {
		return [];
	}
}

function readConfiguredServerCount(): number {
	return readConfiguredServerNames().length;
}

function rememberConnectedNames(names: string[]): void {
	lastConnectedNames = [...names];
}

function parseServerCount(text: string): { connected: number; total: number; names: string[] } | null {
	const plain = stripAnsi(text);
	const match = plain.match(/\bMCP:\s*(\d+)\/(\d+)\s+servers\b(?:\s+(.*))?$/i);
	if (!match) return null;
	const namesText = match[3]?.trim() ?? "";
	const names = namesText
		? namesText.split(/\s*,\s*/).map(name => name.trim()).filter(Boolean)
		: [];
	return {
		connected: Number.parseInt(match[1], 10),
		total: Number.parseInt(match[2], 10),
		names,
	};
}

function parseConnectingTarget(text: string): string | null {
	const plain = stripAnsi(text);
	const match = plain.match(/\bMCP:\s*connecting to\s+(.+?)(?:\.\.\.)?$/i);
	return match?.[1]?.trim() || null;
}

function resolveConnectingTarget(target: string): string {
	const countMatch = target.match(/^(\d+)\s+servers?$/i);
	if (!countMatch) return target;

	const count = Number.parseInt(countMatch[1], 10);
	const names = readConfiguredServerNames();
	if (count === 1 && names.length === 1) return names[0];
	return target;
}

function isResolvedServerName(target: string): boolean {
	return !/^\d+\s+servers?$/i.test(target);
}

function ansi(code: number, text: string): string {
	return `\x1b[${code}m${text}\x1b[39m`;
}

function paintMuted(ctx: ExtensionContext, label: string): string {
	try {
		return ctx.ui.theme.fg("dim", label);
	} catch {
		return ansi(90, label);
	}
}

function paintSuccess(ctx: ExtensionContext, label: string): string {
	try {
		return ctx.ui.theme.fg("success", label);
	} catch {
		return ansi(32, label);
	}
}

function paintCyan(label: string): string {
	return ansi(36, label);
}

function paintDim(ctx: ExtensionContext, label: string): string {
	try {
		return ctx.ui.theme.fg("dim", label);
	} catch {
		return label;
	}
}

function paintStatus(
	ctx: ExtensionContext,
	_connected: number,
	_total: number,
	names: string[] = [],
	connectingName?: string,
	pulseFrame = 0,
): string {
	const serverNames = readConfiguredServerNames();
	const displayNames = serverNames.length > 0 ? serverNames : names;
	const connectedNames = new Set(names);
	const finalDisplayNames =
		connectingName && !displayNames.includes(connectingName) ? [...displayNames, connectingName] : displayNames;

	if (finalDisplayNames.length === 0) return paintMuted(ctx, "mcp:");

	const pulseBulbs = ["◌", "○"];
	const parts = finalDisplayNames.map((name) => {
		const bulb = connectedNames.has(name)
			? paintSuccess(ctx, "●")
			: name === connectingName
				? paintCyan(pulseBulbs[pulseFrame % pulseBulbs.length] ?? "◌")
				: paintMuted(ctx, "○");
		return `${bulb} ${paintMuted(ctx, name)}`;
	});

	return `${paintMuted(ctx, "mcp: ")}${parts.join(paintMuted(ctx, " "))}`;
}

function stopConnectingPulse(state: FormatterState): void {
	if (!state.pulseTimer) return;
	clearInterval(state.pulseTimer);
	state.pulseTimer = undefined;
	state.pulseFrame = 0;
}

function startConnectingPulse(ctx: ExtensionContext, state: FormatterState): void {
	if (state.pulseTimer) return;
	state.pulseTimer = setInterval(() => {
		if (!state.pendingTarget) {
			stopConnectingPulse(state);
			return;
		}
		state.pulseFrame += 1;
		ctx.ui.setStatus(STATUS_KEY, `MCP: connecting to ${state.pendingTarget}...`);
	}, 350);
}

function updateConnectedNames(state: FormatterState, counts: { connected: number; names: string[] }): string[] {
	stopConnectingPulse(state);

	// pi-mcp-adapter reports the MCP transport process as connected before the
	// target app/bridge is proven reachable. If we trust that count directly the
	// footer flashes green, then gray when the first app call fails. Keep bulbs
	// green only for servers that have produced a successful app-level tool result.
	const adapterNames = counts.names.length > 0 ? counts.names.slice(0, counts.connected) : [];
	const adapterNameSet = new Set(adapterNames);
	const verifiedNames = lastConnectedNames.filter((name) => {
		// If the adapter included names, keep only verified names still present in
		// that list. If it only emitted counts, keep current verified state.
		return adapterNameSet.size === 0 || adapterNameSet.has(name);
	});

	state.connectedNames = verifiedNames;
	state.lastConnected = verifiedNames.length;
	state.pendingTarget = undefined;
	rememberConnectedNames(state.connectedNames);
	return state.connectedNames;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part && typeof part === "object" && "text" in part) {
				const text = (part as { text?: unknown }).text;
				return typeof text === "string" ? text : "";
			}
			return "";
		})
		.join("\n");
}

function looksLikeConnectionLoss(text: string): boolean {
	if (!text) return false;
	return CONNECTION_LOSS_PATTERNS.some((re) => re.test(text));
}

function identifyAffectedServer(input: unknown, text: string): string | null {
	const configured = readConfiguredServerNames();
	const record = input && typeof input === "object" ? (input as Record<string, unknown>) : null;

	for (const key of ["server", "connect"]) {
		const value = record?.[key];
		if (typeof value === "string" && configured.includes(value)) return value;
	}

	const tool = record?.tool;
	if (typeof tool === "string") {
		for (const name of configured) {
			if (tool === name || tool.startsWith(`${name}_`)) return name;
		}
	}

	// Fall back to scanning the error text for any configured server name.
	const plain = stripAnsi(text);
	for (const name of configured) {
		const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
		if (re.test(plain)) return name;
	}
	return null;
}

function emitConnectedStatus(ctx: ExtensionContext, connected: string[]): void {
	const total = readConfiguredServerCount();
	if (total === 0) return;
	const suffix = connected.length > 0 ? ` ${connected.join(", ")}` : "";
	ctx.ui.setStatus(STATUS_KEY, `MCP: ${connected.length}/${total} servers${suffix}`);
}

function handleConnectionLoss(ctx: ExtensionContext, serverName: string): void {
	const wasConnected = lastConnectedNames.includes(serverName);
	const next = lastConnectedNames.filter((n) => n !== serverName);
	rememberConnectedNames(next);
	emitConnectedStatus(ctx, next);
	if (!wasConnected) return;
	try {
		ctx.ui.notify(`MCP server "${serverName}" disconnected.`, "warning");
	} catch {
		/* notify is best-effort */
	}
}

function handleServerRecovered(ctx: ExtensionContext, serverName: string): void {
	if (lastConnectedNames.includes(serverName)) return;
	rememberConnectedNames([...lastConnectedNames, serverName]);
	emitConnectedStatus(ctx, lastConnectedNames);
}

function makeFormatter(ctx: ExtensionContext) {
	const state: FormatterState = { connectedNames: [], lastConnected: 0, pulseFrame: 0 };

	return (key: string, text?: string): string | undefined => {
		if (key !== STATUS_KEY || text === undefined) return text;

		const counts = parseServerCount(text);
		if (counts) {
			return paintStatus(ctx, counts.connected, counts.total, updateConnectedNames(state, counts));
		}

		const connectingTarget = parseConnectingTarget(text);
		if (connectingTarget) {
			state.pendingTarget = resolveConnectingTarget(connectingTarget);
			startConnectingPulse(ctx, state);
			return paintStatus(
				ctx,
				state.connectedNames.length,
				readConfiguredServerCount(),
				state.connectedNames,
				state.pendingTarget,
				state.pulseFrame,
			);
		}

		stopConnectingPulse(state);

		// Keep the transient startup/lazy-connect messages, but match the footer's
		// compact lowercase wording and dim color instead of the old uppercase MCP label.
		const plain = stripAnsi(text)
			.replace(/^MCP:\s*/i, "mcp: ")
			.replace(/\s+servers\.\.\.$/i, "...");
		return paintDim(ctx, plain);
	};
}

function installStatusPatch(ctx: ExtensionContext): void {
	const ui = ctx.ui as PatchableUi;
	const existing = ui[PATCH_KEY];
	if (existing) {
		existing.formatter = makeFormatter(ctx);
		return;
	}

	const patch: StatusPatch = {
		originalSetStatus: ui.setStatus.bind(ui),
		formatter: makeFormatter(ctx),
	};
	ui[PATCH_KEY] = patch;

	ui.setStatus = ((key: string, text?: string) => {
		patch.originalSetStatus(key, patch.formatter(key, text));
	}) as typeof ui.setStatus;
}

export default function piMcpExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		installStatusPatch(ctx);
		lastConnectedNames = [];

		// Ensure a stable status is visible even when all MCP servers are lazy and
		// pi-mcp-adapter has not emitted its final status yet. This just routes the
		// same text pi-mcp-adapter would emit through our formatter.
		const total = readConfiguredServerCount();
		if (total > 0) {
			ctx.ui.setStatus(STATUS_KEY, `MCP: 0/${total} servers`);
		}
	});

	// Demote an MCP server in the status bar when its transport dies. We never
	// touch pi-mcp-adapter state — we just re-emit a status string in the same
	// format the adapter itself uses, which our formatter then renders.
	pi.on("tool_result", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (event.toolName !== "mcp") return;

		const text = contentText(event.content);
		const isConnectionLoss = looksLikeConnectionLoss(text);
		const affected = identifyAffectedServer(event.input, isConnectionLoss ? text : "");
		if (!affected) return;

		if (isConnectionLoss) {
			handleConnectionLoss(ctx, affected);
			return;
		}

		// A later MCP result from the same server that is not a connection-loss
		// failure proves the server/app path is responding again.
		handleServerRecovered(ctx, affected);
	});
}
