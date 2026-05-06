/**
 * 单独用 tsx 跑时只认环境变量里的 key（如 OPENROUTER_API_KEY），不会读 Pi 的 ~/.pi/agent/auth.json。
 * 调试：若 stopReason 为 error，看 response.errorMessage；或先执行: export OPENROUTER_API_KEY=sk-or-v1-...
 *
 * OpenAI SDK 需要全局 `fetch`。Node 18+ 自带；若报错 fetch is not defined，下面用 undici 补上（也可用 nvm 切到 Node 20+）。
 */
import { getModel, completeSimple } from "@mariozechner/pi-ai";

async function main() {
  const model = getModel("openrouter", "openrouter/free");

  const response = await completeSimple(model, {
    systemPrompt: "You are a helpful assistant.",
    messages: [
      { role: "user", content: "What is the capital of France?", timestamp: Date.now() }
    ],
    // 可选：不显式设置则使用 process.env.OPENROUTER_API_KEY
    // apiKey: process.env.OPENROUTER_API_KEY,
  });

  if (response.stopReason === "error") {
    console.error("Provider error:", response.errorMessage ?? "(no errorMessage)");
    console.error("Full message:", JSON.stringify(response, null, 2));
    process.exitCode = 1;
    return;
  }

  // response is an AssistantMessage
  for (const block of response.content) {
    if (block.type === "text") {
      console.log(block.text);
    }
  }

  console.log(`\nTokens: ${response.usage.totalTokens}`);
  console.log(`Stop reason: ${response.stopReason}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});