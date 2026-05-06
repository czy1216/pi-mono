/**
 * TUI 版助手：通过本地 proxy_llm 调用 Gemini（OpenAI 兼容 `/v1/chat/completions`）。
 *
 * 先启动代理（默认监听 8765），再运行：
 *   npx tsx learn/assiatant_with_ui_with_gemini.ts
 *
 * 环境变量：
 *   GEMINI_PROXY_BASE_URL  默认与 simple_coding_agent_with_gemini 相同（见下方常量）；本机起代理可改为 http://127.0.0.1:8765/v1
 *   GEMINI_PROXY_MODEL_ID  默认 gemini-3-flash-preview
 *   PROXY_API_KEY          代理若启用 PROXY_API_KEY，与此一致（Bearer）
 *   OPENAI_API_KEY         未设置时会设为占位符，满足 pi 侧检查
 *
 * @see /root/chenzeyu/source/proxy_llm/app.py
 */
import {
	createAgentSession,
	SessionManager,
	estimateTokens,
} from "@mariozechner/pi-coding-agent";
import { streamSimple, Type, type Model } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
	TUI,
	ProcessTerminal,
	Editor,
	Markdown,
	Text,
	Loader,
	CombinedAutocompleteProvider,
} from "@mariozechner/pi-tui";
import type { EditorTheme, MarkdownTheme } from "@mariozechner/pi-tui";
import chalk from "chalk";
import * as path from "path";
import * as fs from "fs";

// 与 learn/simple_coding_agent_with_gemini.ts 保持一致，避免 TUI 版误连本机 127.0.0.1 而代理实际在局域网其他机器
const GEMINI_PROXY_BASE_URL =
	process.env.GEMINI_PROXY_BASE_URL ?? "http://10.10.112.153:8765/v1";
const GEMINI_PROXY_MODEL_ID =
	process.env.GEMINI_PROXY_MODEL_ID ?? "gemini-3-flash-preview";

if (!process.env.OPENAI_API_KEY?.trim()) {
	process.env.OPENAI_API_KEY = "local-placeholder";
}

function createLocalGeminiProxyModel(): Model<"openai-completions"> {
	const headers: Record<string, string> = {};
	const proxyKey = process.env.PROXY_API_KEY?.trim();
	if (proxyKey) {
		headers.Authorization = `Bearer ${proxyKey}`;
	}
	return {
		id: GEMINI_PROXY_MODEL_ID,
		name: `Gemini via proxy (${GEMINI_PROXY_MODEL_ID})`,
		api: "openai-completions",
		provider: "openai",
		baseUrl: GEMINI_PROXY_BASE_URL.replace(/\/$/, ""),
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65536,
		headers: Object.keys(headers).length ? headers : undefined,
		compat: {
			supportsDeveloperRole: false,
			supportsStore: false,
			maxTokensField: "max_tokens",
			supportsReasoningEffort: false,
			supportsUsageInStreaming: false,
			supportsStrictMode: false,
		},
	};
}

// --- Themes ---
const markdownTheme: MarkdownTheme = {
	heading: (s) => chalk.bold.cyan(s),
	link: (s) => chalk.blue(s),
	linkUrl: (s) => chalk.dim(s),
	code: (s) => chalk.yellow(s),
	codeBlock: (s) => chalk.green(s),
	codeBlockBorder: (s) => chalk.dim(s),
	quote: (s) => chalk.italic(s),
	quoteBorder: (s) => chalk.dim(s),
	hr: (s) => chalk.dim(s),
	listBullet: (s) => chalk.cyan(s),
	bold: (s) => chalk.bold(s),
	italic: (s) => chalk.italic(s),
	strikethrough: (s) => chalk.strikethrough(s),
	underline: (s) => chalk.underline(s),
};

const editorTheme: EditorTheme = {
	borderColor: (s) => chalk.dim(s),
	selectList: {
		selectedPrefix: (s) => chalk.blue(s),
		selectedText: (s) => chalk.bold(s),
		description: (s) => chalk.dim(s),
		scrollInfo: (s) => chalk.dim(s),
		noMatch: (s) => chalk.dim(s),
	},
};

// --- Custom tool ---
const webSearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
});

const webSearchTool: AgentTool<typeof webSearchParams> = {
	name: "web_search",
	label: "Web Search",
	description: "Search the web for documentation, error messages, or general information",
	parameters: webSearchParams,
	execute: async (_id, params) => ({
		content: [{ type: "text", text: `[Search results for: "${params.query}" would appear here]` }],
		details: { query: params.query },
	}),
};

// --- Session persistence ---
const sessionDir = path.join(process.cwd(), ".sessions");
fs.mkdirSync(sessionDir, { recursive: true });
const sessionFile = path.join(sessionDir, "assistant-gemini-proxy-ui.jsonl");

// --- TUI setup ---
const tui = new TUI(new ProcessTerminal());

tui.addChild(
	new Text(
		chalk.bold("PI Assistant") +
			chalk.dim(" (Ctrl+C to exit)\n"),
	),
);

const editor = new Editor(tui, editorTheme);
editor.setAutocompleteProvider(
	new CombinedAutocompleteProvider(
		[
			{ name: "new", description: "Reset the session" },
			{ name: "exit", description: "Quit the assistant" },
		],
		process.cwd(),
	),
);
tui.addChild(editor);
tui.setFocus(editor);

// --- Main ---
async function main() {
	const model = createLocalGeminiProxyModel();
	const sessionManager = SessionManager.open(sessionFile);

	const { session } = await createAgentSession({
		model,
		thinkingLevel: "off",
		sessionManager,
		customTools: [webSearchTool],
	});

	session.agent.streamFn = streamSimple;

	// Show session info
	const tokenCount = session.messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
	const children = tui.children;
	children.splice(
		children.length - 1,
		0,
		new Text(
			chalk.dim(`  Base URL: ${GEMINI_PROXY_BASE_URL}\n`) +
				chalk.dim(`  Model: ${model.id}\n`) +
				chalk.dim(`  Session: ${sessionFile}\n`) +
				chalk.dim(`  History: ${session.messages.length} messages, ~${tokenCount} tokens\n`) +
				chalk.dim(`  Tools: ${session.getActiveToolNames().join(", ")}\n`),
		),
	);
	tui.requestRender();

	// Streaming state
	let streamingMarkdown: Markdown | null = null;
	let streamingText = "";
	let loader: Loader | null = null;
	let isRunning = false;

	// Subscribe to agent events
	session.subscribe((event) => {
		switch (event.type) {
			case "agent_start":
				isRunning = true;
				editor.disableSubmit = true;
				loader = new Loader(tui, (s) => chalk.cyan(s), (s) => chalk.dim(s), "Thinking...");
				children.splice(children.length - 1, 0, loader);
				tui.requestRender();
				break;

			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta") {
					if (loader) {
						tui.removeChild(loader);
						loader = null;
					}
					streamingText += event.assistantMessageEvent.delta;
					if (!streamingMarkdown) {
						streamingMarkdown = new Markdown(streamingText, 1, 0, markdownTheme);
						children.splice(children.length - 1, 0, streamingMarkdown);
					} else {
						streamingMarkdown.setText(streamingText);
					}
					tui.requestRender();
				}
				break;

			case "tool_execution_start": {
				if (loader) {
					tui.removeChild(loader);
					loader = null;
				}
				const args =
					event.args?.path ||
					event.args?.command?.slice(0, 60) ||
					event.args?.query ||
					"";
				const toolMsg = new Text(chalk.dim(`  [${event.toolName}] ${args}`));
				children.splice(children.length - 1, 0, toolMsg);
				tui.requestRender();
				break;
			}

			case "agent_end":
				if (loader) {
					tui.removeChild(loader);
					loader = null;
				}
				streamingMarkdown = null;
				streamingText = "";
				isRunning = false;
				editor.disableSubmit = false;
				tui.requestRender();
				break;
		}
	});

	// Handle input submission
	editor.onSubmit = async (value: string) => {
		if (isRunning) return;
		const trimmed = value.trim();
		if (!trimmed) return;

		if (trimmed === "/exit") {
			session.dispose();
			tui.stop();
			process.exit(0);
		}

		if (trimmed === "/new") {
			session.sessionManager.newSession();
			session.agent.reset();
			children.splice(2, children.length - 3); // Keep header, info, and editor
			children.splice(children.length - 1, 0, new Text(chalk.dim("  Session reset.\n")));
			tui.requestRender();
			return;
		}

		const userMsg = new Markdown(value, 1, 0, markdownTheme, { color: (s: string) => chalk.bold(s) });
		children.splice(children.length - 1, 0, userMsg);
		tui.requestRender();

		try {
			await session.prompt(trimmed);
		} catch (err: any) {
			children.splice(children.length - 1, 0, new Text(chalk.red(`Error: ${err.message}`)));
			editor.disableSubmit = false;
			tui.requestRender();
		}
	};

	tui.start();
}

main();
