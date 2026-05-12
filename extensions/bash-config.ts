import { createLocalBashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-bash extension
 *
 * Loads ~/.pi/agent/.bashrc before user bash commands submitted with `!` / `!!`.
 * This keeps pi-specific aliases/functions/env separate from the user's normal
 * interactive ~/.bashrc.
 */
export default function piBashExtension(pi: ExtensionAPI): void {
	const local = createLocalBashOperations();

	pi.on("user_bash", () => {
		return {
			operations: {
				exec(command, cwd, options) {
					const wrappedCommand = [
						"export PI_BASH=1",
						'export PI_AGENT_DIR="$HOME/.pi/agent"',
						'export PI_AGENT_BASHRC="$PI_AGENT_DIR/.bashrc"',
						"shopt -s expand_aliases",
						'[ -f "$PI_AGENT_BASHRC" ] && source "$PI_AGENT_BASHRC"',
						command,
					].join("\n");

					return local.exec(wrappedCommand, cwd, options);
				},
			},
		};
	});
}
