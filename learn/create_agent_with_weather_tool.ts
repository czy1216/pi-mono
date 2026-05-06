import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple } from "@mariozechner/pi-ai";

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const weatherParams = Type.Object({
  city: Type.String({ description: "City name" }),
});

const weatherTool: AgentTool<typeof weatherParams> = {
  name: "get_weather",
  label: "Weather",
  description: "Get the current weather for a city",
  parameters: weatherParams,
  execute: async (toolCallId, params, signal, onUpdate) => {
    // params is typed: { city: string }
    const temp = Math.round(Math.random() * 30);
    return {
      content: [{ type: "text", text: `${params.city}: ${temp}C, partly cloudy` }],
      details: { temp, city: params.city },
    };
  },
};

const model = getModel("openrouter", "openrouter/free");


const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant with access to tools.",
    model,
    tools: [weatherTool],
    thinkingLevel: "off",
  },
  streamFn: streamSimple,
});

agent.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
      console.log("Agent started");
      break;

    case "message_update":
      // Streaming text from the LLM
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;

    case "tool_execution_start":
      console.log(`\nTool: ${event.toolName}(${JSON.stringify(event.args)})`);
      break;

    case "tool_execution_end":
      console.log(`Result: ${event.isError ? "ERROR" : "OK"}`);
      break;

    case "agent_end":
      console.log("\nAgent finished");
      break;
  }
});

await agent.prompt("What's the weather in Tokyo and London?");
