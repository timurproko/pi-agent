declare module "@earendil-works/pi-coding-agent" {
	export type Theme = {
		fg: (color: string, text: string) => string;
		bg: (color: string, text: string) => string;
		bold: (text: string) => string;
	};
	export type ExtensionCommandContext = {
		cwd: string;
		mode: string;
		hasUI: boolean;
		ui: {
			theme: Theme;
			notify: (message: string, severity?: "info" | "warning" | "error") => void;
			setStatus: (key: string, text?: string) => void;
			setWidget: (key: string, value?: any, options?: any) => void;
			custom: <T>(factory: (tui: any, theme: Theme, keybindings: any, done: (value: T) => void) => any, options?: any) => Promise<T>;
		};
	};
	export type ExtensionAPI = {
		registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }) => void;
		registerTool: (definition: any) => void;
	};
}

declare module "@earendil-works/pi-ai" {
	export function StringEnum<T extends readonly string[]>(values: T): any;
}
