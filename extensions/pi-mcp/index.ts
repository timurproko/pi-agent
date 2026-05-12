import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";

const STATUS_KEY = "mcp";
const PATCH_KEY = "__piMcpStatusPatch";
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const knownConnectedNames = new Set<string>();

interface StatusPatch {
	originalSetStatus: (key: string, text?: string) => void;
	formatter: (key: string, text?: string) => string | undefined;
}

interface FormatterState {
	connectedNames: string[];
	lastConnected: number;
	pendingTarget?: string;
}

interface McpConfig {
	mcpServers?: Record<string, unknown>;
	"mcp-servers"?: Record<string, unknown>;
}

interface McpCache {
	servers?: Record<string, unknown>;
}

type ServerStatus = "connected" | "cached" | "not connected";

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

function readCachedServerNames(): string[] {
	try {
		const cachePath = path.join(getAgentDir(), "mcp-cache.json");
		const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as McpCache;
		return Object.keys(raw.servers ?? {});
	} catch {
		return [];
	}
}

function getServerStatus(name: string): ServerStatus {
	if (knownConnectedNames.has(name)) return "connected";
	return readCachedServerNames().includes(name) ? "cached" : "not connected";
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

function paintGray(ctx: ExtensionContext, label: string): string {
	try {
		return ctx.ui.theme.fg("dim", label);
	} catch {
		return ansi(90, label);
	}
}

function paintAccent(ctx: ExtensionContext, label: string): string {
	try {
		return ctx.ui.theme.fg("accent", label);
	} catch {
		return ansi(36, label);
	}
}

function paintStatus(ctx: ExtensionContext, connected: number, total: number, names: string[] = []): string {
	const label = `mcp: ${connected}/${total}`;
	const connectedNames = names.slice(0, connected);
	if (connectedNames.length === 0) return paintGray(ctx, label);
	return `${paintGray(ctx, label + " ")}${paintAccent(ctx, connectedNames.join(", "))}`;
}

function paintDim(ctx: ExtensionContext, label: string): string {
	try {
		return ctx.ui.theme.fg("dim", label);
	} catch {
		return label;
	}
}

function rememberConnectedNames(names: string[], replace = false): void {
	if (replace) knownConnectedNames.clear();
	for (const name of names) {
		knownConnectedNames.add(name);
	}
}

function publishKnownStatus(ctx: ExtensionContext): void {
	const total = readConfiguredServerCount();
	if (total === 0 || knownConnectedNames.size === 0) return;
	const names = [...knownConnectedNames];
	ctx.ui.setStatus(STATUS_KEY, `MCP: ${names.length}/${total} servers ${names.join(", ")}`);
}

function getDetailsRecord(details: unknown): Record<string, unknown> | null {
	return details && typeof details === "object" ? (details as Record<string, unknown>) : null;
}

function extractConnectedNamesFromDetails(details: unknown): string[] {
	const record = getDetailsRecord(details);
	if (!record) return [];

	if (record.mode === "status" && Array.isArray(record.servers)) {
		return record.servers
			.filter(server => getDetailsRecord(server)?.status === "connected")
			.map(server => getDetailsRecord(server)?.name)
			.filter((name): name is string => typeof name === "string" && name.length > 0);
	}

	if ((record.mode === "list" || record.mode === "connect") && typeof record.server === "string") {
		return [record.server];
	}

	return [];
}

function hasMeaningfulValue(value: unknown): boolean {
	if (value === undefined || value === null || value === false) return false;
	if (typeof value === "string") return value.trim().length > 0;
	return true;
}

function isGenericMcpStatusInput(input: unknown): boolean {
	const record = getDetailsRecord(input);
	if (!record) return true;

	const actionKeys = new Set(["tool", "args", "connect", "describe", "search", "server", "action"]);
	for (const key of actionKeys) {
		if (hasMeaningfulValue(record[key])) return false;
	}
	if (record.regex === true || record.includeSchemas === true) return false;

	for (const [key, value] of Object.entries(record)) {
		if (actionKeys.has(key) || key === "regex" || key === "includeSchemas") continue;
		if (hasMeaningfulValue(value)) return false;
	}

	return true;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => getDetailsRecord(part)?.text)
		.filter((text): text is string => typeof text === "string")
		.join("\n");
}

function latestUserText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "message") continue;
		if (entry.message.role !== "user") continue;
		return contentText(entry.message.content);
	}
	return "";
}

function latestUserAskedToConnectMcp(ctx: ExtensionContext): boolean {
	const text = latestUserText(ctx).toLowerCase();
	return /\bconnect\b[\s\S]*\bmcp\b/.test(text) || /\bmcp\b[\s\S]*\bconnect\b/.test(text);
}

async function showMcpConnectSelector(ctx: ExtensionContext): Promise<string | null> {
	const serverNames = readConfiguredServerNames();
	if (serverNames.length === 0) {
		ctx.ui.notify("No MCP servers configured.", "info");
		return null;
	}
	if (serverNames.length === 1) return serverNames[0] ?? null;

	const items: SelectItem[] = serverNames.map((name) => ({
		value: name,
		label: name,
		description: getServerStatus(name),
	}));

	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold("Connect MCP")), 0, 0));
		container.addChild(new Spacer(1));

		const list = new SelectList(
			items,
			Math.min(items.length, 12),
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
			{ maxPrimaryColumnWidth: 32 },
		);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);

		container.addChild(list);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "enter connect · esc cancel"), 0, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

function updateConnectedNames(state: FormatterState, counts: { connected: number; names: string[] }): string[] {
	if (counts.names.length > 0) {
		state.connectedNames = counts.names.slice(0, counts.connected);
		rememberConnectedNames(state.connectedNames, true);
	} else if (
		counts.connected > state.lastConnected &&
		state.pendingTarget &&
		isResolvedServerName(state.pendingTarget) &&
		!state.connectedNames.includes(state.pendingTarget)
	) {
		state.connectedNames.push(state.pendingTarget);
		rememberConnectedNames([state.pendingTarget]);
	}

	if (counts.connected === 0) {
		state.connectedNames = [];
		knownConnectedNames.clear();
	} else if (state.connectedNames.length > counts.connected) {
		state.connectedNames = state.connectedNames.slice(0, counts.connected);
	}

	state.lastConnected = counts.connected;
	state.pendingTarget = undefined;
	return state.connectedNames;
}

function makeFormatter(ctx: ExtensionContext) {
	const state: FormatterState = { connectedNames: [], lastConnected: 0 };

	return (key: string, text?: string): string | undefined => {
		if (key !== STATUS_KEY || text === undefined) return text;

		const counts = parseServerCount(text);
		if (counts) {
			return paintStatus(ctx, counts.connected, counts.total, updateConnectedNames(state, counts));
		}

		const connectingTarget = parseConnectingTarget(text);
		if (connectingTarget) {
			state.pendingTarget = resolveConnectingTarget(connectingTarget);
			return paintDim(ctx, `mcp: connecting ${state.pendingTarget}…`);
		}

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

// Monkey-patch the (private) ExtensionRunner so pi-mcp-adapter's `/mcp` command
// shows up as `/mcp-status` without touching the adapter package itself. The
// patch is idempotent and only renames the entry; description and handler are
// preserved verbatim, so upgrading pi-mcp-adapter continues to work.
let runnerPatchPromise: Promise<void> | null = null;

async function findRunnerJsPath(): Promise<string | null> {
	const candidates: string[] = [];

	// 1. import.meta.resolve (Node ≥20 stable; may be missing under some loaders).
	try {
		const resolveFn = (import.meta as { resolve?: (spec: string) => string }).resolve;
		if (typeof resolveFn === "function") {
			const indexUrl = resolveFn("@earendil-works/pi-coding-agent");
			const distDir = path.dirname(fileURLToPath(indexUrl));
			candidates.push(path.join(distDir, "core/extensions/runner.js"));
		}
	} catch {
		/* fall through */
	}

	// 2. process.argv[1] points at pi-coding-agent's dist/cli.js when launched via
	// the installed `pi` shim.
	const argvEntry = process.argv[1];
	if (argvEntry) {
		const distDir = path.dirname(argvEntry);
		candidates.push(path.join(distDir, "core/extensions/runner.js"));
	}

	// 3. Walk up from this extension file searching for the installed package.
	try {
		let dir = path.dirname(fileURLToPath(import.meta.url));
		for (let i = 0; i < 8; i++) {
			const guess = path.join(
				dir,
				"node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js",
			);
			candidates.push(guess);
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		/* ignore */
	}

	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) {
				return fs.realpathSync.native(candidate);
			}
		} catch {
			/* ignore */
		}
	}
	return null;
}

async function ensureAdapterCommandRenamed(): Promise<void> {
	if (runnerPatchPromise) return runnerPatchPromise;
	runnerPatchPromise = (async () => {
		try {
			const runnerPath = await findRunnerJsPath();
			if (!runnerPath) {
				console.error("pi-mcp: unable to locate pi-coding-agent runner.js; /mcp rename disabled");
				return;
			}
			const mod = (await import(pathToFileURL(runnerPath).href)) as {
				ExtensionRunner?: { prototype: Record<string, unknown> } & Record<string, unknown>;
			};
			const Runner = mod.ExtensionRunner;
			if (!Runner) return;
			if ((Runner as { __piMcpRenamePatch?: boolean }).__piMcpRenamePatch) return;
			(Runner as { __piMcpRenamePatch?: boolean }).__piMcpRenamePatch = true;

			const proto = Runner.prototype as {
				resolveRegisteredCommands?: (this: { extensions: Array<{
					resolvedPath?: string;
					path?: string;
					commands: Map<string, { name: string } & Record<string, unknown>>;
				}> }) => unknown;
			};
			const original = proto.resolveRegisteredCommands;
			if (typeof original !== "function") return;

			proto.resolveRegisteredCommands = function patched() {
				for (const ext of this.extensions) {
					const location = ext.resolvedPath ?? ext.path ?? "";
					if (!/pi-mcp-adapter/i.test(location)) continue;
					if (!ext.commands.has("mcp") || ext.commands.has("mcp-status")) continue;
					const originalCmd = ext.commands.get("mcp");
					if (!originalCmd) continue;
					ext.commands.delete("mcp");
					ext.commands.set("mcp-status", { ...originalCmd, name: "mcp-status" });
				}
				return (original as (...args: unknown[]) => unknown).call(this);
			};
		} catch (err) {
			console.error("pi-mcp: failed to patch ExtensionRunner for /mcp rename", err);
		}
	})();
	return runnerPatchPromise;
}

async function runMcpConnectFlow(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const selectedName = await showMcpConnectSelector(ctx);
	if (!selectedName) return;

	if (knownConnectedNames.has(selectedName)) {
		ctx.ui.notify(`MCP server "${selectedName}" is already connected.`, "info");
		return;
	}

	// Ask the LLM to invoke the mcp tool with `connect`. The existing tool_call
	// interceptor leaves non-generic invocations alone, so this routes straight to
	// pi-mcp-adapter.
	pi.sendUserMessage(`Connect to MCP server "${selectedName}".`);
}

export default function piMcpExtension(pi: ExtensionAPI): void {
	// Patch ExtensionRunner as early as possible so the adapter's `/mcp` is
	// already renamed by the time the user types anything.
	void ensureAdapterCommandRenamed();

	pi.registerCommand("mcp-connect", {
		description: "Connect to an MCP server",
		handler: async (_args, ctx) => {
			await runMcpConnectFlow(pi, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await ensureAdapterCommandRenamed();
		if (!ctx.hasUI) return;

		installStatusPatch(ctx);

		// Ensure a stable status is visible even when all MCP servers are lazy and
		// pi-mcp-adapter has not emitted its final status yet.
		const total = readConfiguredServerCount();
		if (total > 0) {
			ctx.ui.setStatus(STATUS_KEY, `MCP: 0/${total} servers`);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI || event.toolName !== "mcp") return;
		if (!isGenericMcpStatusInput(event.input)) return;
		if (!latestUserAskedToConnectMcp(ctx)) return;

		const selectedName = await showMcpConnectSelector(ctx);
		if (!selectedName) {
			return { block: true, reason: "MCP connect cancelled by user." };
		}

		(event.input as Record<string, unknown>).connect = selectedName;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!ctx.hasUI || event.toolName !== "mcp") return;

		const details = getDetailsRecord(event.details);
		const names = extractConnectedNamesFromDetails(details);
		if (details?.mode === "status" && names.length === 0) {
			knownConnectedNames.clear();
			const total = readConfiguredServerCount();
			if (total > 0) ctx.ui.setStatus(STATUS_KEY, `MCP: 0/${total} servers`);
			return;
		}
		if (names.length === 0) return;

		rememberConnectedNames(names, details?.mode === "status");
		publishKnownStatus(ctx);
	});
}
