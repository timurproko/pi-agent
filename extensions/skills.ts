import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";

function skillCommandName(skill: Skill): string {
	return `skill:${skill.name}`;
}

function truncateText(text: string, maxLength: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (maxLength <= 0) return "";
	return oneLine.slice(0, maxLength);
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

async function selectSkill(ctx: ExtensionCommandContext, skills: Skill[]): Promise<Skill | undefined> {
	return ctx.ui.custom<Skill | undefined>((tui, theme, _keybindings, done) => {
		let selectedIndex = 0;
		let query = "";

		const filteredSkills = () => skills.filter((skill) => matchesSkill(skill, query));

		const clampSelection = (filtered: Skill[]) => {
			if (filtered.length === 0) {
				selectedIndex = 0;
				return;
			}
			selectedIndex = Math.max(0, Math.min(selectedIndex, filtered.length - 1));
		};

		const component = {
			render(width: number): string[] {
				const filtered = filteredSkills();
				clampSelection(filtered);

				const lines: string[] = [];
				lines.push(theme.fg("border", "─".repeat(width)));
				lines.push("");
				lines.push(theme.fg("accent", theme.bold("Skills")));
				lines.push("");
				lines.push(`> ${query}█`);
				lines.push("");

				const maxVisible = 10;
				const startIndex = Math.max(
					0,
					Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible),
				);
				const endIndex = Math.min(startIndex + maxVisible, filtered.length);

				const nameColumnWidth = Math.min(36, Math.max(20, Math.floor(width * 0.24)));
				// Fill the row almost to the right edge while keeping one visible cell of
				// margin to prevent terminal wrapping. Visible width is:
				// cursor(2) + nameColumn + gap(2) + descWidth = width - 1.
				const descWidth = Math.max(8, width - nameColumnWidth - 5);

				if (filtered.length === 0) {
					lines.push(theme.fg("dim", "  no skills match your search"));
				} else {
					for (let i = startIndex; i < endIndex; i++) {
						const skill = filtered[i];
						const isSelected = i === selectedIndex;
						const cursor = isSelected ? "→ " : "  ";
						const name = truncateText(skillCommandName(skill), nameColumnWidth).padEnd(nameColumnWidth, " ");
						const description = truncateText(oneLineDescription(skill), descWidth);
						if (isSelected) {
							lines.push(
								theme.fg("accent", cursor)
								+ theme.fg("accent", name)
								+ "  "
								+ theme.fg("accent", description),
							);
						} else {
							lines.push(`${cursor}${name}  ${theme.fg("dim", description)}`);
						}
					}
				}

				if (filtered.length > maxVisible) {
					lines.push(theme.fg("dim", `  (${selectedIndex + 1}/${filtered.length})`));
				}

				lines.push("");
				lines.push(theme.fg("dim", "type to search • ↑↓ navigate • enter actions • esc back"));
				lines.push(theme.fg("border", "─".repeat(width)));

				return lines;
			},

			handleInput(data: string) {
				const filtered = filteredSkills();
				clampSelection(filtered);

				if (data === "\x1B[A" || data === "k") {
					if (filtered.length > 0) selectedIndex = selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1;
				} else if (data === "\x1B[B" || data === "j") {
					if (filtered.length > 0) selectedIndex = selectedIndex === filtered.length - 1 ? 0 : selectedIndex + 1;
				} else if (data === "\r" || data === "\n") {
					if (filtered.length > 0) done(filtered[selectedIndex]);
					return;
				} else if (data === "\x1B" || data === "\x03") {
					done(undefined);
					return;
				} else if (data === "\x7F" || data === "\b") {
					query = query.slice(0, -1);
					selectedIndex = 0;
				} else if (data === "\x15") {
					query = "";
					selectedIndex = 0;
				} else if (data.length === 1 && data >= " " && data !== "\x7F") {
					query += data;
					selectedIndex = 0;
				}

				tui.requestRender();
			},

			invalidate() {},
		};

		return component;
	});
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
			if (skills.length === 0) {
				ctx.ui.notify("No skills discovered.", "info");
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
				selectedSkill = await selectSkill(ctx, skills);
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
