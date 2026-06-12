import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { EditorSearchModal } from "./core/editor-ui";
import { createCommandTunnelAutocompleteProvider, createCommandTunnelEditorFactory, transformCommandTunnelInput, type CommandTunnel, type CommandTunnelItem } from "./core/command-tunnel";

const SKILLS_COMMAND = "skills";
const SKILL_COMMAND_PREFIX = "skill:";

function skillCommandName(skill: Skill): string {
	return `${SKILL_COMMAND_PREFIX}${skill.name}`;
}

function oneLineDescription(skill: Skill): string {
	return skill.description.replace(/\s+/g, " ").trim();
}

function matchesSkill(skill: Skill, query: string): boolean {
	if (!query) return true;
	const normalized = query.toLowerCase();
	const normalizedWithoutPrefix = normalized.startsWith(SKILL_COMMAND_PREFIX)
		? normalized.slice(SKILL_COMMAND_PREFIX.length)
		: normalized;

	return skillCommandName(skill).toLowerCase().includes(normalized)
		|| skill.name.toLowerCase().includes(normalizedWithoutPrefix)
		|| oneLineDescription(skill).toLowerCase().includes(normalized);
}

async function selectSkill(ctx: ExtensionCommandContext, skills: Skill[], initialQuery = ""): Promise<Skill | undefined> {
	return ctx.ui.custom<Skill | undefined>((tui, theme, keybindings, done) =>
		new EditorSearchModal<Skill>({
			tui,
			theme,
			keybindings,
			title: "Skills",
			initialQuery,
			getItems: (query) => skills
				.filter((skill) => matchesSkill(skill, query))
				.map((skill) => ({
					value: skill,
					label: skillCommandName(skill),
					selectedDescription: oneLineDescription(skill),
				})),
			noItemsText: (query) => query.trim() ? "No matching skills" : "No skills yet",
			highlightDescription: false,
			shortcuts: "type to search • ↑↓ navigate • enter actions • esc close",
			onSelect: (item) => done(item.value),
			onCancel: () => done(undefined),
		}),
	);
}

function buildSkillPrompt(skill: Skill, args: string): string {
	const content = fs.readFileSync(skill.filePath, "utf-8");
	const body = stripFrontmatter(content).trim();
	const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
	const trimmedArgs = args.trim();
	return trimmedArgs ? `${skillBlock}\n\nUser: ${trimmedArgs}` : skillBlock;
}

function getSkills(ctx: ExtensionCommandContext): Skill[] {
	return [...(ctx.getSystemPromptOptions().skills ?? [])].sort((a, b) => a.name.localeCompare(b.name));
}

function getSkillCommandItems(pi: ExtensionAPI, query: string): CommandTunnelItem[] {
	const normalizedQuery = query.trim().toLowerCase();
	const normalizedWithoutPrefix = normalizedQuery.startsWith(SKILL_COMMAND_PREFIX)
		? normalizedQuery.slice(SKILL_COMMAND_PREFIX.length)
		: normalizedQuery;

	return pi.getCommands()
		.filter((command) => command.source === "skill" && command.name.startsWith(SKILL_COMMAND_PREFIX))
		.filter((command) => {
			if (!normalizedQuery) return true;
			const skillName = command.name.slice(SKILL_COMMAND_PREFIX.length);
			return command.name.toLowerCase().includes(normalizedQuery)
				|| skillName.toLowerCase().includes(normalizedWithoutPrefix)
				|| (command.description ?? "").toLowerCase().includes(normalizedQuery);
		})
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((command) => {
			const skillName = command.name.slice(SKILL_COMMAND_PREFIX.length);
			return {
				value: skillName,
				label: `${SKILLS_COMMAND}:${skillName}`,
				description: command.description?.replace(/\s+/g, " ").trim(),
			};
		});
}

function createSkillsTunnel(pi: ExtensionAPI): CommandTunnel {
	return {
		commandName: SKILLS_COMMAND,
		hideGlobalValuePrefixes: [SKILL_COMMAND_PREFIX],
		getItems: (query) => getSkillCommandItems(pi, query),
		toInputText: (skillName, rest) => `/${SKILL_COMMAND_PREFIX}${skillName}${rest}`,
	};
}

export default function skillsExtension(pi: ExtensionAPI) {
	const skillsTunnel = createSkillsTunnel(pi);

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.addAutocompleteProvider((provider) => createCommandTunnelAutocompleteProvider(provider, [skillsTunnel]));
		ctx.ui.setEditorComponent(createCommandTunnelEditorFactory([skillsTunnel], ctx.ui.getEditorComponent()));
	});

	pi.on("input", (event) => {
		const text = transformCommandTunnelInput(event.text, [skillsTunnel]);
		if (text !== event.text) return { action: "transform" as const, text };
		return { action: "continue" as const };
	});

	pi.registerCommand(SKILLS_COMMAND, {
		description: "Browse, search, and apply a skill",
		getArgumentCompletions: (prefix) => {
			const normalizedPrefix = prefix.trim().toLowerCase();
			const skills = pi.getCommands()
				.filter((command) => command.source === "skill" && command.name.startsWith(SKILL_COMMAND_PREFIX))
				.map((command) => ({
					commandName: command.name,
					name: command.name.slice(SKILL_COMMAND_PREFIX.length),
					description: command.description ?? "",
				}))
				.filter((skill) => {
					const prefix = normalizedPrefix.startsWith(SKILL_COMMAND_PREFIX)
						? normalizedPrefix.slice(SKILL_COMMAND_PREFIX.length)
						: normalizedPrefix;
					return skill.commandName.toLowerCase().startsWith(normalizedPrefix)
						|| skill.name.toLowerCase().startsWith(prefix);
				});

			return skills.length > 0
				? skills.map((skill) => ({ value: skill.commandName, label: skill.commandName, description: skill.description }))
				: null;
		},
		handler: async (args, ctx) => {
			const skills = getSkills(ctx);
			if (skills.length === 0 && !ctx.hasUI) {
				ctx.ui.notify("No skills yet.", "info");
				return;
			}

			const trimmedArgs = args.trim();
			let selectedSkill: Skill | undefined;
			let userArgs = "";

			if (trimmedArgs.length > 0) {
				const [maybeSkillCommand, ...rest] = trimmedArgs.split(/\s+/);
				const maybeSkillName = maybeSkillCommand.startsWith(SKILL_COMMAND_PREFIX)
					? maybeSkillCommand.slice(SKILL_COMMAND_PREFIX.length)
					: maybeSkillCommand;
				selectedSkill = skills.find((skill) => skill.name === maybeSkillName);
				if (selectedSkill) {
					userArgs = rest.join(" ");
				} else {
					userArgs = trimmedArgs;
				}
			}

			if (!selectedSkill) {
				selectedSkill = await selectSkill(ctx, skills, userArgs);
				if (!selectedSkill) return;
			}

			try {
				pi.sendUserMessage(buildSkillPrompt(selectedSkill, userArgs));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to apply skill ${selectedSkill.name}: ${message}`, "error");
			}
		},
	});
}
