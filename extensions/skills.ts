import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { EditorSearchModal } from "./_editor-ui";

function skillCommandName(skill: Skill): string {
	return `skill:${skill.name}`;
}

function oneLineDescription(skill: Skill): string {
	return skill.description.replace(/\s+/g, " ").trim();
}

function matchesSkill(skill: Skill, query: string): boolean {
	if (!query) return true;
	const normalized = query.toLowerCase();
	const normalizedWithoutPrefix = normalized.startsWith("skill:")
		? normalized.slice("skill:".length)
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
					description: oneLineDescription(skill),
				})),
			noItemsText: (query) => query.trim() ? "No matching skills" : "No skills yet",
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

export default function skillsExtension(pi: ExtensionAPI) {
	pi.registerCommand("skills", {
		description: "Browse, search, and apply a skill",
		getArgumentCompletions: (prefix) => {
			const normalizedPrefix = prefix.trim().toLowerCase();
			const skills = pi.getCommands()
				.filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
				.map((command) => ({
					commandName: command.name,
					name: command.name.slice("skill:".length),
					description: command.description ?? "",
				}))
				.filter((skill) => {
					const prefix = normalizedPrefix.startsWith("skill:")
						? normalizedPrefix.slice("skill:".length)
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
				const maybeSkillName = maybeSkillCommand.startsWith("skill:")
					? maybeSkillCommand.slice("skill:".length)
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
