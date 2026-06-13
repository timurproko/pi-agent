import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type ModePromptOptions = {
	configDir?: string;
};

const MODE_PROMPT_START = /<!--\s*PI-MODE-PROMPT:([A-Z0-9_-]+)\s*-->/g;

function defaultConfigDir(): string {
	return path.join(os.homedir(), ".pi", "agent");
}

function agentsPath(configDir = defaultConfigDir()): string {
	return path.join(configDir, "AGENTS.md");
}

function listPlans(): string[] {
	const dir = path.join(os.homedir(), ".pi", "agent", "plans");
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort();
}

function planListText(): string {
	const plans = listPlans();
	return plans.length > 0
		? plans.map((p) => `  - ~/.pi/agent/plans/${p}`).join("\n")
		: "  (none yet)";
}

function extractModePromptTemplates(content: string): Map<string, string> {
	const templates = new Map<string, string>();
	let match: RegExpExecArray | null;
	MODE_PROMPT_START.lastIndex = 0;

	while ((match = MODE_PROMPT_START.exec(content)) !== null) {
		const modeId = match[1];
		if (!modeId) continue;
		const bodyStart = MODE_PROMPT_START.lastIndex;
		const endPattern = new RegExp(String.raw`<!--\s*/PI-MODE-PROMPT:${modeId}\s*-->`, "g");
		endPattern.lastIndex = bodyStart;
		const end = endPattern.exec(content);
		if (!end) continue;
		templates.set(modeId, content.slice(bodyStart, end.index).trim());
		MODE_PROMPT_START.lastIndex = end.index + end[0].length;
	}

	return templates;
}

function renderModePrompt(template: string): string {
	return template.replaceAll("{{PLAN_LIST}}", planListText());
}

export function getModePrompt(promptTemplateId: string | undefined, options: ModePromptOptions = {}): string | undefined {
	if (!promptTemplateId) return undefined;

	let content: string;
	try {
		content = fs.readFileSync(agentsPath(options.configDir), "utf8");
	} catch {
		return undefined;
	}

	const template = extractModePromptTemplates(content).get(promptTemplateId);
	return template ? renderModePrompt(template) : undefined;
}
