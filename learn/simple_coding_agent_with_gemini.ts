/**
 * 通过本地 proxy_llm 调用 Vertex Gemini（OpenAI 兼容入口 `/v1/chat/completions`，代理内转为 generateContent）。
 *
 * @see /root/chenzeyu/source/proxy_llm/app.py
 *
 * 启动代理后：
 *   npx tsx learn/simple_coding_agent_with_gemini.ts
 *
 * 环境变量：
 *   GEMINI_PROXY_BASE_URL  默认 http://10.10.112.153:8765/v1
 *   GEMINI_PROXY_MODEL_ID  默认 gemini-3-flash-preview（须为代理识别的 gemini* 模型名）
 *   PROXY_API_KEY          若代理启用 PROXY_API_KEY，填相同值（通过 Authorization Bearer 发送）
 *
 * 代理侧需配置 GEMINI_API_KEY（访问 Google）。客户端 OPENAI_API_KEY 仅用于满足 pi 凭证检查。
 */
import {
	createAgentSession,
	SessionManager,
	estimateTokens,
} from "@mariozechner/pi-coding-agent";
import { streamSimple, Type, type Model } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";

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
			// 精简 OpenAI 兼容网关常对请求体做严格 schema 校验；默认会带上下面两类字段并触发 422：
			// - stream_options.include_usage
			// - tools[].function.strict
			supportsUsageInStreaming: false,
			supportsStrictMode: false,
		},
	};
}

const webSearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
});

const webSearchTool: AgentTool<typeof webSearchParams> = {
	name: "web_search",
	label: "Web Search",
	description: "Search the web for documentation, error messages, or general information",
	parameters: webSearchParams,
	execute: async (_id, params) => {
		return {
			content: [{ type: "text", text: `[Search results for: "${params.query}" would appear here]` }],
			details: { query: params.query },
		};
	},
};

const sessionDir = path.join(process.cwd(), ".sessions");
fs.mkdirSync(sessionDir, { recursive: true });

const sessionFile = path.join(sessionDir, "assistant-gemini-proxy.jsonl");
const sessionManager = SessionManager.open(sessionFile);

async function createAssistant() {
	const model = createLocalGeminiProxyModel();

	const { session } = await createAgentSession({
		model,
		thinkingLevel: "off",
		sessionManager,
		customTools: [webSearchTool],
	});

	session.agent.streamFn = streamSimple;

	return session;
}

function attachEventHandlers(session: Awaited<ReturnType<typeof createAssistant>>) {
	session.subscribe((event) => {
		switch (event.type) {
			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta") {
					process.stdout.write(event.assistantMessageEvent.delta);
				}
				break;

			case "tool_execution_start":
				console.log(`\n  [${event.toolName}] ${summarizeArgs(event.args)}`);
				break;

			case "tool_execution_end":
				if (event.isError) {
					console.log(`  ERROR`);
				}
				break;

			case "compaction_start":
				console.log("\n  [compacting context...]");
				break;

			case "agent_end":
				console.log();
				break;
		}
	});
}

function summarizeArgs(args: any): string {
	if (args?.path) return args.path;
	if (args?.command) return args.command.slice(0, 60);
	if (args?.query) return `"${args.query}"`;
	if (args?.pattern) return args.pattern;
	return JSON.stringify(args).slice(0, 60);
}

async function main() {
	const session = await createAssistant();
	attachEventHandlers(session);

	const tokenCount = session.messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);

	console.log("PI Assistant (Gemini via proxy_llm)");
	console.log(`  Base URL: ${GEMINI_PROXY_BASE_URL}`);
	console.log(`  Model: ${session.model?.id}`);
	console.log(`  Session: ${sessionFile}`);
	console.log(`  History: ${session.messages.length} messages, ~${tokenCount} tokens`);
	console.log(`  Tools: ${session.getActiveToolNames().join(", ")}`);
	console.log(`  Type "exit" to quit, "new" to reset session\n`);

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

	const ask = () => {
		rl.question("You: ", async (input) => {
			const trimmed = input.trim();

			if (trimmed === "exit") {
				session.dispose();
				rl.close();
				return;
			}

			if (trimmed === "new") {
				session.sessionManager.newSession();
				session.agent.reset();
				console.log("Session reset.\n");
				ask();
				return;
			}

			if (trimmed === "status") {
				const tc = session.messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
				console.log(`History: ${session.messages.length} messages, ~${tc} tokens`);
				ask();
				return;
			}

			if (!trimmed) {
				ask();
				return;
			}

			try {
				await session.prompt(trimmed);
			} catch (err: any) {
				console.error(`Error: ${err.message}`);
			}

			ask();
		});
	};

	ask();
}

main();
