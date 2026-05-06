import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { getModel, streamSimple } from "@mariozechner/pi-ai";
import * as path from "path";

async function main() {
  const model = getModel("openrouter", "openrouter/free");

  const sessionFile = path.join(process.cwd(), ".sessions", "my-session.jsonl");
  const sessionManager = SessionManager.open(sessionFile);

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    // sessionManager: SessionManager.inMemory(), // 会话保存在内存
    sessionManager: sessionManager // 会话持久化到文件
  });

  session.agent.streamFn = streamSimple;

  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "tool_execution_start") {
      console.log(`\n[${event.toolName}]`);
    }
  });

  await session.prompt("Summarize the /root/chenzeyu/source/pi-mono/learn/basic.ts");
  console.log();

  session.dispose();
}

main();