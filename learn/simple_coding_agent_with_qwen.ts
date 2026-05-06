/**
 * 本地 Qwen（vLLM）示例：与部署脚本保持一致
 * @see /root/chenzeyu/source/serve_qwen3_5/serve_qwen3_5_27B.sh
 *
 * 先启动 vLLM，再运行：
 *   npx tsx learn/simple_coding_agent_with_qwen.ts
 * （未设置 OPENAI_API_KEY 时，脚本会自动设为占位符：pi-coding-agent 要求「已配置凭证」，
 *   vLLM 通常不校验该 key；若你已配置真实 OpenAI key，不会覆盖。）
 *
 * 可选环境变量（覆盖默认值）：
 *   QWEN_LOCAL_PORT      默认 8010（与脚本 PORT 一致；也可用环境变量 PORT）
 *   QWEN_LOCAL_BASE_URL  默认 http://127.0.0.1:<port>/v1
 *   QWEN_LOCAL_MODEL_ID  默认 qwen3.5-27b-fp8（须与 --served-model-name 一致）
 *
 * pi-ai 与「Qwen 模板」相关说明（无独立 Jinja/chat 模板文件）：
 * - 见 packages/ai/src/types.ts → OpenAICompletionsCompat.thinkingFormat
 * - "qwen"：请求顶层 enable_thinking（与 zai 同款字段）
 * - "qwen-chat-template"：chat_template_kwargs.enable_thinking + preserve_thinking
 * - 内置 models.generated 里 Groq/HF 的 Qwen 多数只配 supportsDeveloperRole:false，thinking 仍走默认 openai（reasoning_effort）
 * - 本地 vLLM 若对 thinking 字段敏感，可在 qwen / qwen-chat-template 间切换：
 *   QWEN_THINKING_FORMAT=qwen-chat-template npx tsx learn/simple_coding_agent_with_qwen.ts
 */
import {
	createAgentSession,
	SessionManager,
	estimateTokens,
} from "@mariozechner/pi-coding-agent";
import { streamSimple, Type, type Model, type OpenAICompletionsCompat } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";

// 与 serve_qwen3_5_27B.sh 中 MODEL_NAME / PORT 对齐
const QWEN_LOCAL_MODEL_ID = process.env.QWEN_LOCAL_MODEL_ID ?? "qwen3.5-27b-fp8";
const QWEN_LOCAL_PORT = process.env.QWEN_LOCAL_PORT ?? process.env.PORT ?? "8010";
const QWEN_LOCAL_BASE_URL =
	process.env.QWEN_LOCAL_BASE_URL ?? `http://127.0.0.1:${QWEN_LOCAL_PORT}/v1`;

function resolveQwenThinkingFormat(): NonNullable<OpenAICompletionsCompat["thinkingFormat"]> {
	const raw = process.env.QWEN_THINKING_FORMAT?.trim().toLowerCase();
	if (raw === "openai" || raw === "openrouter" || raw === "zai") {
		return raw;
	}
	if (raw === "qwen-chat-template") {
		return "qwen-chat-template";
	}
	// 默认：与多数 Qwen OpenAI 兼容部署的 enable_thinking 顶层字段一致
	return "qwen";
}

// AgentSession 会检查 modelRegistry.hasConfiguredAuth(openai)；本地 vLLM 一般忽略 Authorization。
if (!process.env.OPENAI_API_KEY?.trim()) {
	process.env.OPENAI_API_KEY = "local-placeholder";
}

/**
 * 直接声明 openai-completions：pi-ai 按 model.api 选用 Chat Completions 实现；
 * 注册表里的 `openai` 厂商多为 openai-responses，本地 vLLM 需手写这一条。
 */
function createLocalQwenModel(): Model<"openai-completions"> {
	return {
		id: QWEN_LOCAL_MODEL_ID,
		name: `Local Qwen (${QWEN_LOCAL_MODEL_ID})`,
		api: "openai-completions",
		provider: "openai",
		baseUrl: QWEN_LOCAL_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 16384,
		// pi-ai 在 reasoning + supportsDeveloperRole 时会把 system 打成 OpenAI 的 role=developer；vLLM/Qwen 不认该角色 → 400 Unexpected message role
		compat: {
			supportsDeveloperRole: false,
			supportsStore: false,
			thinkingFormat: resolveQwenThinkingFormat(),
			maxTokensField: "max_tokens",
		},
	};
}

// --- Custom tool: search the web ---
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

// --- Session persistence ---
const sessionDir = path.join(process.cwd(), ".sessions");
fs.mkdirSync(sessionDir, { recursive: true });

const sessionFile = path.join(sessionDir, "assistant-qwen.jsonl");
const sessionManager = SessionManager.open(sessionFile);

// --- Create the agent session ---
async function createAssistant() {
	const model = createLocalQwenModel();

	const { session } = await createAgentSession({
		model,
		thinkingLevel: "off",
		sessionManager,
		customTools: [webSearchTool],
	});

	session.agent.streamFn = streamSimple;

	return session;
}

// --- Event handler ---
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

// --- REPL ---
async function main() {
	const session = await createAssistant();
	attachEventHandlers(session);

	const tokenCount = session.messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);

	console.log("PI Assistant (local Qwen / vLLM)");
	console.log(`  Base URL: ${QWEN_LOCAL_BASE_URL}`);
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
