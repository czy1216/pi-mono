import {
    createAgentSession,
    SessionManager,
    estimateTokens,
  } from "@mariozechner/pi-coding-agent";
  import { getModel, streamSimple } from "@mariozechner/pi-ai";
  import { Type } from "@mariozechner/pi-ai";
  import type { AgentTool } from "@mariozechner/pi-agent-core";
  import * as path from "path";
  import * as fs from "fs";
  import * as readline from "readline";
  
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
      // In production, call a search API (Brave, Serper, etc.)
      return {
        content: [{ type: "text", text: `[Search results for: "${params.query}" would appear here]` }],
        details: { query: params.query },
      };
    },
  };
  
  // --- Session persistence ---
  const sessionDir = path.join(process.cwd(), ".sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  
  const sessionFile = path.join(sessionDir, "assistant.jsonl");
  const sessionManager = SessionManager.open(sessionFile);
  
  // --- Create the agent session ---
  async function createAssistant() {
    const model = getModel("openrouter", "openrouter/free");
  
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
  
    console.log("PI Assistant");
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
            console.log(`History: ${session.messages.length} messages, ~${tokenCount} tokens`);
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