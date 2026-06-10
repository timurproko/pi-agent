/**
 * Q&A extraction hook - extracts questions from assistant responses
 *
 * Custom interactive TUI for answering questions.
 *
 * Demonstrates the "prompt generator" pattern with custom TUI:
 * 1. /answer command gets the last assistant message
 * 2. Shows a spinner while extracting questions as structured JSON
 * 3. Presents an interactive TUI to navigate and answer questions
 * 4. Submits the compiled answers when done
 */

import { complete, completeSimple, type Model, type Api, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	type TUI,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { EditorDialogTemplate } from "./_editor-ui";

// Structured output format for question extraction
interface ExtractedQuestion {
	question: string;
	context?: string;
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

type AnswerHandlerResult = "submitted" | "cancelled" | "unavailable" | "error" | "no_questions";

interface AnswerHandlerOptions {
	cancelMessage?: string | false;
	cancelControlLabel?: string;
	statusLabel?: string;
	questions?: ExtractedQuestion[];
	onQuestions?: (questions: ExtractedQuestion[]) => void;
}

interface RefineAnswerFlowOptions {
	key: string;
	prompt: string;
	cancelMessage?: string | false;
	cancelControlLabel?: string;
	statusLabel?: string;
	onCancelled?: (ctx: ExtensionContext) => void | Promise<void>;
}

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What is your preferred database?",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented."
    },
    {
      "question": "Should we use TypeScript or JavaScript?"
    }
  ]
}`;

const CODEX_MODEL_ID = "gpt-5.3";
const HAIKU_MODEL_ID = "claude-haiku-4-5";

/**
 * Prefer GPT-5.3 for extraction when available, otherwise fallback to haiku or the current model.
 */
async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: ModelRegistry,
): Promise<Model<Api>> {
	const codexModel = modelRegistry.find("openai-codex", CODEX_MODEL_ID);
	if (codexModel) {
		const auth = await modelRegistry.getApiKeyAndHeaders(codexModel);
		if (auth.ok) {
			return codexModel;
		}
	}

	const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
	if (!haikuModel) {
		return currentModel;
	}

	const auth = await modelRegistry.getApiKeyAndHeaders(haikuModel);
	if (auth.ok === false) {
		return currentModel;
	}

	return haikuModel;
}

/**
 * Parse the JSON response from the LLM
 */
function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		// Try to find JSON in the response (it might be wrapped in markdown code blocks)
		let jsonStr = text;

		// Remove markdown code block if present
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) {
			jsonStr = jsonMatch[1].trim();
		}

		const parsed = JSON.parse(jsonStr);
		if (parsed && Array.isArray(parsed.questions)) {
			return parsed as ExtractionResult;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Interactive Q&A component for answering extracted questions
 */
class QnAComponent implements Component {
	private questions: ExtractedQuestion[];
	private answers: string[];
	private currentIndex: number = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: string | null) => void;
	private showingConfirmation: boolean = false;

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	private dim(s: string): string { return this.theme.fg("dim", s); }
	private bold(s: string): string { return this.theme.bold(s); }
	private cyan(s: string): string { return this.theme.fg("accent", s); }
	private green(s: string): string { return this.theme.fg("success", s); }
	private yellow(s: string): string { return this.theme.fg("warning", s); }
	private gray(s: string): string { return this.theme.fg("muted", s); }

	constructor(
		questions: ExtractedQuestion[],
		tui: TUI,
		private readonly theme: Theme,
		onDone: (result: string | null) => void,
		private readonly cancelControlLabel: string = "cancel",
	) {
		this.questions = questions;
		this.answers = questions.map(() => "");
		this.tui = tui;
		this.onDone = onDone;

		// Create a minimal theme for the editor
		const editorTheme: EditorTheme = {
			borderColor: (s: string) => this.dim(s),
			selectList: {
				selectedPrefix: (s: string) => this.cyan(s),
				selectedText: (s: string) => `\x1b[44m${s}\x1b[0m`,
				description: (s: string) => this.gray(s),
				scrollInfo: (s: string) => this.dim(s),
				noMatch: (s: string) => this.yellow(s),
			},
		};

		this.editor = new Editor(tui, editorTheme);
		// Disable the editor's built-in submit (which clears the editor)
		// We'll handle Enter ourselves to preserve the text
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
	}

	private allQuestionsAnswered(): boolean {
		this.saveCurrentAnswer();
		return this.answers.every((a) => (a?.trim() || "").length > 0);
	}

	private saveCurrentAnswer(): void {
		this.answers[this.currentIndex] = this.editor.getText();
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.answers[index] || "");
		this.invalidate();
	}

	private submit(): void {
		this.saveCurrentAnswer();

		// Build the response text
		const parts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			const a = this.answers[i]?.trim() || "(no answer)";
			parts.push(`Q: ${q.question}`);
			if (q.context) {
				parts.push(`> ${q.context}`);
			}
			parts.push(`A: ${a}`);
			parts.push("");
		}

		this.onDone(parts.join("\n").trim());
	}

	private cancel(): void {
		this.onDone(null);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		// Handle confirmation dialog
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		// Global navigation and commands
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}

		// Left/Right arrow for navigation
		if (matchesKey(data, Key.left)) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.right)) {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}
			return;
		}

		// Handle Enter ourselves (editor's submit is disabled)
		// Ctrl+Enter adds a newline; plain Enter moves to the next question or confirms on the last question.
		if (matchesKey(data, Key.ctrl("enter")) || data === "\n") {
			this.editor.insertTextAtCursor("\n");
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		const isNonCtrlModifiedEnterNewline =
			data === "\x1b\r" ||
			data === "\x1b[13;2~" ||
			(data.charCodeAt(0) === 10 && data.length > 1) ||
			(data.length > 1 && data.includes("\x1b") && data.includes("\r"));
		if (matchesKey(data, Key.shift("enter")) || isNonCtrlModifiedEnterNewline) {
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.saveCurrentAnswer();
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
			} else {
				// On last question - show confirmation
				this.showingConfirmation = true;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Pass to editor
		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const dialog = new EditorDialogTemplate({ theme: this.theme, size: "compact" });
		const contentWidth = dialog.contentWidth(width);
		const bodyLines: string[] = [];

		// Progress indicator
		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const answered = (this.answers[i]?.trim() || "").length > 0;
			const current = i === this.currentIndex;
			if (current) {
				progressParts.push(this.cyan("●"));
			} else if (answered) {
				progressParts.push(this.green("●"));
			} else {
				progressParts.push(this.dim("○"));
			}
		}
		const metaLines = [progressParts.join(" ")];

		// Current question
		const q = this.questions[this.currentIndex];
		const questionText = `${this.bold("Q:")} ${q.question}`;
		bodyLines.push(...wrapTextWithAnsi(questionText, contentWidth));

		// Context if present. Wrap plain text first, then color each rendered line
		// independently so context color cannot carry across wrapped lines.
		if (q.context) {
			bodyLines.push("");
			const wrappedContext = wrapTextWithAnsi(`> ${q.context}`, contentWidth - 2);
			for (const line of wrappedContext) {
				bodyLines.push(this.gray(line));
			}
		}

		bodyLines.push("");

		// Render the editor component (multi-line input) with padding.
		// Skip the first and last lines (editor's own border lines).
		const answerPrefix = this.bold("A: ");
		const editorWidth = Math.max(1, contentWidth - 4 - 3); // Extra padding + space for "A: "
		const editorLines = this.editor.render(editorWidth);
		for (let i = 1; i < editorLines.length - 1; i++) {
			if (i === 1) {
				bodyLines.push(answerPrefix + editorLines[i]);
			} else {
				bodyLines.push("   " + editorLines[i]);
			}
		}

		bodyLines.push("");

		const footerLines = this.showingConfirmation
			? [`${this.yellow("Submit all answers?")} ${this.dim("(enter/y to confirm, esc/n to cancel)")}`]
			: [this.dim(`←→ navigate · enter next · esc ${this.cancelControlLabel}`)];

		const lines = dialog.render(width, {
			title: "Questions",
			titleSuffix: ` (${this.currentIndex + 1}/${this.questions.length})`,
			metaLines,
			bodyLines,
			footerLines,
		});

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	const answerHandler = async (ctx: ExtensionContext, options: AnswerHandlerOptions = {}): Promise<AnswerHandlerResult> => {
		let restoreStatus = () => {};
		try {
			if (!ctx.hasUI) {
				ctx.ui.notify("answer requires interactive mode", "error");
				return "unavailable";
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return "unavailable";
			}

			const showQuestions = async (questions: ExtractedQuestion[]): Promise<AnswerHandlerResult> => {
				options.onQuestions?.(questions);
				const answersResult = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					return new QnAComponent(questions, tui, theme, done, options.cancelControlLabel);
				});

				if (answersResult === null) {
					if (options.cancelMessage !== false) {
						ctx.ui.notify(options.cancelMessage ?? "Cancelled", "info");
					}
					return "cancelled";
				}

				pi.sendMessage(
					{
						customType: "answers",
						content: "I answered your questions in the following way:\n\n" + answersResult,
						display: true,
					},
					{ triggerTurn: true },
				);
				return "submitted";
			};

			if (options.questions?.length) {
				return await showQuestions(options.questions);
			}

			// Find the last assistant message on the current branch
			const branch = ctx.sessionManager.getBranch();
			let lastAssistantText: string | undefined;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message") {
					const msg = entry.message;
					if ("role" in msg && msg.role === "assistant") {
						const textParts = msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text);
						if (textParts.length > 0) {
							lastAssistantText = textParts.join("\n");
							break;
						}
					}
				}
			}

			if (!lastAssistantText) {
				ctx.ui.notify("No assistant messages found", "error");
				return "unavailable";
			}

			// Use the current model for extraction
			const extractionModel = ctx.model;

			// Animated status: "extracting questions" with pulsing dots
			let pulseFrame = 0;
			const updatePulse = () => {
				const dots = ".".repeat(pulseFrame % 4);
				const pad = " ".repeat(3 - Math.min(dots.length, 3));
				ctx.ui.setStatus("aaa-pi-plan-mode", ctx.ui.theme.fg("piPlanCmdMode", `extracting questions${dots}${pad}`));
				pulseFrame++;
			};
			updatePulse();
			const pulseTimer = setInterval(updatePulse, 300);
			// While the extraction/generation progress is visible, hide the MCP footer
			// item so the progress reads cleanly. Restore it when progress ends.
			ctx.ui.setStatus("mcp", undefined);
			restoreStatus = () => {
				clearInterval(pulseTimer);
				const label = options.statusLabel ?? "cmd";
				ctx.ui.setStatus("aaa-pi-plan-mode", ctx.ui.theme.fg(label === "plan" ? "accent" : "piPlanCmdMode", label));
				// Ask the MCP status extension to recompute and redraw its footer item.
				(globalThis as any).__piMcpRefreshStatus?.();
			};

			// Get auth
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
			if (auth.ok === false) {
				restoreStatus();
				ctx.ui.notify(`Auth failed for ${extractionModel.id}: ${auth.error}`, "error");
				return "error";
			}

			// Run extraction directly (no loader UI)
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: lastAssistantText }],
				timestamp: Date.now(),
			};

			let response;
			try {
				response = await completeSimple(
					extractionModel,
					{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
					{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 1024 },
				);
			} catch (err) {
				restoreStatus();
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`API call failed: ${msg}`, "error");
				return "error";
			}

			restoreStatus();

			// Debug: show what we got back
			const contentTypes = response.content.map((c: any) => `${c.type}${c.text ? '(has text)' : ''}`).join(', ');

			let responseText = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			// Fallback: try to get text from any content block that has a text field
			if (!responseText) {
				responseText = response.content
					.filter((c: any) => typeof c.text === "string")
					.map((c: any) => c.text)
					.join("\n");
			}

			const extractionResult = parseExtractionResult(responseText);

			if (!extractionResult) {
				const errMsg = (response as any).errorMessage || '';
				ctx.ui.notify(`Failed to parse: content=[${contentTypes}] stop=${response.stopReason} err=${errMsg} text=${responseText.slice(0, 100)}`, "error");
				return "error";
			}

			if (extractionResult.questions.length === 0) {
				ctx.ui.notify("No questions found in the last message", "info");
				return "no_questions";
			}

			// Show the Q&A component
			restoreStatus();
			return await showQuestions(extractionResult.questions);
		} catch (err) {
			restoreStatus();
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Answer extension error: ${msg}`, "error");
			return "error";
		}
	};

	const refineQuestionCache = new Map<string, ExtractedQuestion[]>();
	let pendingRefine: RefineAnswerFlowOptions | null = null;
	let autoAnswerScheduled = false;

	const runRefineAnswer = async (ctx: ExtensionContext, options: RefineAnswerFlowOptions): Promise<AnswerHandlerResult> => {
		const result = await answerHandler(ctx, {
			cancelMessage: options.cancelMessage ?? false,
			cancelControlLabel: options.cancelControlLabel,
			statusLabel: options.statusLabel,
			questions: refineQuestionCache.get(options.key),
			onQuestions: (questions) => refineQuestionCache.set(options.key, questions),
		});

		if (result === "submitted") {
			refineQuestionCache.delete(options.key);
		}
		if (result === "cancelled") {
			await options.onCancelled?.(ctx);
		}
		return result;
	};

	const scheduleRefineAnswer = (ctx: ExtensionContext, options: RefineAnswerFlowOptions): void => {
		if (autoAnswerScheduled) return;
		autoAnswerScheduled = true;

		const waitForFinished = () => {
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				setTimeout(waitForFinished, 100);
				return;
			}

			void (async () => {
				try {
					await runRefineAnswer(ctx, options);
				} finally {
					autoAnswerScheduled = false;
				}
			})();
		};

		setTimeout(waitForFinished, 0);
	};

	const refineAnswerFlow = {
		start: async (ctx: ExtensionContext, options: RefineAnswerFlowOptions): Promise<AnswerHandlerResult | "sent"> => {
			if (refineQuestionCache.has(options.key)) {
				return await runRefineAnswer(ctx, options);
			}

			pendingRefine = options;
			try {
				await pi.sendUserMessage(options.prompt);
				return "sent";
			} catch (error) {
				if (pendingRefine === options) {
					pendingRefine = null;
				}
				throw error;
			}
		},
		run: runRefineAnswer,
		hasCachedQuestions: (key: string): boolean => refineQuestionCache.has(key),
		clearCachedQuestions: (key: string): void => refineQuestionCache.delete(key),
	};

	(globalThis as any).__piAnswerHandler = answerHandler;
	(globalThis as any).__piAnswerRefineFlow = refineAnswerFlow;

	pi.on("agent_end", async (_event, ctx) => {
		const options = pendingRefine;
		if (!options) return;
		pendingRefine = null;
		scheduleRefineAnswer(ctx, options);
	});

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => answerHandler(ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: answerHandler,
	});
}
