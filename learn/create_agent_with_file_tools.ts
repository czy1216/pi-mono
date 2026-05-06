import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple } from "@mariozechner/pi-ai";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import * as fs from "fs";

const readFileParams = Type.Object({
  path: Type.String({ description: "Path to the file" }),
});

const readFileTool: AgentTool<typeof readFileParams> = {
  name: "read_file",
  label: "Read File",
  description: "Read the contents of a file",
  parameters: readFileParams,
  execute: async (_id, params) => {
    try {
      const content = fs.readFileSync(params.path, "utf-8");
      return {
        content: [{ type: "text", text: content }],
        details: {},
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        details: {},
      };
    }
  },
};

const listFilesParams = Type.Object({
  path: Type.String({ description: "Directory path", default: "." }),
});

const listFilesTool: AgentTool<typeof listFilesParams> = {
  name: "list_files",
  label: "List Files",
  description: "List files in a directory",
  parameters: listFilesParams,
  execute: async (_id, params) => {
    const files = fs.readdirSync(params.path);
    return {
      content: [{ type: "text", text: files.join("\n") }],
      details: { count: files.length },
    };
  },
};

async function main() {
  // const model = getModel("anthropic", "claude-opus-4-5");
  const model = getModel("openrouter", "openrouter/free");

  const agent = new Agent({
    initialState: {
      systemPrompt: "You can read files and list directories. Be concise.",
      model,
      tools: [readFileTool, listFilesTool],
      thinkingLevel: "off",
    },
    streamFn: streamSimple,
  });

  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "tool_execution_start") {
      console.log(`\n[${event.toolName}] ${JSON.stringify(event.args)}`);
    }
  });

  //   await agent.prompt("What files are in the current directory? Read the /root/chenzeyu/source/pi-mono/learn/basic.ts if it exists.");
//   await agent.prompt("What files are in the current directory? ");
  await agent.prompt("Read the /root/chenzeyu/source/pi-mono/learn/basic.ts if it exists. ");
  console.log();
}

main();