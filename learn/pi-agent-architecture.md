# `@mariozechner/pi-agent-core`（`packages/agent`）架构概览

本文档描述 `packages/agent` 的分层结构、一次对话运行的主流程，以及与 `@mariozechner/pi-ai` 的衔接方式。路径均相对于仓库内 `packages/agent/src/`（除非另有说明）。

---

## 1. 包职责与依赖

- **包名**：`@mariozechner/pi-agent-core`（目录 `packages/agent`）。
- **依赖**：仅直接依赖 **`@mariozechner/pi-ai`**（通过 `streamSimple`、类型与工具校验等完成「单次模型调用」）。
- **角色**：在 pi-ai 之上提供 **有状态 Agent**、**多轮工具循环**、**事件流（给 UI）**、**steering / followUp 队列**，以及可选 **HTTP 代理流**（`streamProxy`）。

---

## 2. 模块分层（文件级）

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 对外导出                                                                  │
│ index.ts → agent.ts | agent-loop.ts | proxy.ts | types.ts               │
└─────────────────────────────────────────────────────────────────────────┘
         │
         ├──────────────────────────────┬──────────────────────────────────┐
         ▼                              ▼                                  ▼
┌──────────────────┐          ┌─────────────────────┐          ┌──────────────────┐
│ agent.ts         │          │ agent-loop.ts        │          │ proxy.ts         │
│ class Agent      │          │ runAgentLoop         │          │ streamProxy      │
│ 状态 / 订阅 /    │  调用    │ runAgentLoopContinue │          │（替代 streamFn， │
│ prompt/continue  │ ────────│ agentLoop(*)         │          │  经服务端调 LLM）│
└────────┬─────────┘          └──────────┬──────────┘          └──────────────────┘
         │                               │
         │                               │ 每次模型调用
         │                               ▼
         │                    ┌─────────────────────┐
         │                    │ @mariozechner/pi-ai │
         │                    │ streamSimple（默认） │
         │                    │ 或注入的 StreamFn     │
         └────────────────────┴─────────────────────┘
```

\* `agentLoop` / `agentLoopContinue` 为 **函数式 API**，把事件推入 `EventStream<AgentEvent, AgentMessage[]>`；与 `runAgentLoop*` 共享核心 `runLoop`。

---

## 3. 核心类型（types.ts 摘要）

| 概念 | 说明 |
|------|------|
| `AgentMessage` | `pi-ai` 的 `Message` + 可扩展自定义消息（声明合并 `CustomAgentMessages`） |
| `StreamFn` | 与 `streamSimple` 同签名，可同步或异步返回流；**约定失败不抛**，在流里用 `error`/`done` 表达 |
| `AgentLoopConfig` | 继承 `SimpleStreamOptions`，并包含 `model`、`convertToLlm`、`transformContext`、`getApiKey`、`getSteeringMessages`、`getFollowUpMessages`、`toolExecution`、`beforeToolCall`、`afterToolCall` 等 |
| `AgentTool` | 扩展 pi-ai `Tool`：带 `label`、`execute`、`prepareArguments` |
| `AgentEvent` | UI/上层订阅用：`agent_start` / `turn_*` / `message_*` / `tool_execution_*` / `agent_end` |

---

## 4. 高层：`Agent` 类（agent.ts）在做什么

- **状态**：`systemPrompt`、`model`、`thinkingLevel`、`tools`、`messages`，以及 `isStreaming`、`streamingMessage`、`pendingToolCalls`、`errorMessage`。
- **注入能力**：`streamFn`（默认 `streamSimple`）、`convertToLlm`、`transformContext`、`getApiKey`、`onPayload`、`beforeToolCall` / `afterToolCall`、`steeringMode` / `followUpMode` 等。
- **入口**：
  - **`prompt(...)`**：新用户输入（或批量 `AgentMessage`），内部调用 **`runAgentLoop`**。
  - **`continue()`**：在「最后一条不是 assistant」时继续一轮；若最后是 assistant，则尝试先 drain **steering** / **followUp** 队列，否则报错。
- **队列**：`steer()` / `followUp()` 写入队列；在 `createLoopConfig` 里映射为 `getSteeringMessages` / `getFollowUpMessages`，供 **agent-loop** 在合适时机注入。
- **生命周期**：`runWithLifecycle` → `agent_start` … → `agent_end`；`subscribe` 的监听者会 **await**，且 `agent_end` 处理完后才在 `finishRun` 中视为空闲（`waitForIdle`）。

---

## 5. 主循环：`runLoop`（agent-loop.ts）文字流程

```
runAgentLoop / runAgentLoopContinue
         │
         ▼
emit agent_start, turn_start
         │
         ├─（仅 runAgentLoop）对新 prompt 逐条 message_start / message_end
         │
         ▼
┌────────────────────────────────────────────────────────────────┐
│ 外层 while：无更多 followUp 则结束                               │
│   内层 while：还有 tool 调用待处理，或有 steering 注入则继续      │
│     1) 注入 pending steering 消息（message_*）并写入 context       │
│     2) streamAssistantResponse → 调 streamFn（默认 streamSimple） │
│        - transformContext(AgentMessage[])                       │
│        - convertToLlm → 构造 pi-ai Context                        │
│        - 迭代 AssistantMessageEventStream，emit message_*       │
│     3) 若 stopReason 为 error/aborted → turn_end → agent_end     │
│     4) 若有 toolCall → executeToolCalls（顺序或并行）             │
│        - prepare / validate / beforeToolCall / execute /          │
│          afterToolCall → tool_result 写回 context                 │
│     5) emit turn_end；再拉一轮 getSteeringMessages                 │
│   followUp：若本可结束且 getFollowUpMessages 非空 → 当作下一轮 pending │
└────────────────────────────────────────────────────────────────┘
         │
         ▼
emit agent_end（messages 为本轮新增消息列表）
```

**与 pi-ai 的边界**：仅在 `streamAssistantResponse` 内把 **`AgentMessage[]` → `Message[]`**（`convertToLlm`），再调用 **`streamFn(model, llmContext, options)`**；工具在 **本进程** 执行（非 pi-ai 内置），结果以 **`ToolResultMessage`** 拼回 transcript。

---

## 6. 工具执行：`sequential` vs `parallel`

- **sequential**：按 assistant 中 toolCall 顺序，**完整执行完一个再下一个**。
- **parallel**（默认）：对每个 toolCall 先 **顺序** 完成 `prepareToolCall`（校验、`beforeToolCall`），再对需真正执行的调用 **并发** `execute`，最后按发起顺序 **finalize**（`afterToolCall`、emit）。  
  即时失败（未找到工具、校验失败、`beforeToolCall` block）走 **immediate** 分支，不进入并发池。

---

## 7. 代理流：proxy.ts

- **`streamProxy(model, context, options)`**：实现与 `StreamFn` 兼容的流，通过 **`fetch(proxyUrl + "/api/stream", ...)`** 拉 SSE/文本行，把服务端 **`ProxyAssistantMessageEvent`** 还原为 **`AssistantMessageEvent`**。
- **用途**：鉴权与真实 LLM 调用放在服务端；Agent 侧 **`new Agent({ streamFn: (m, c, o) => streamProxy(m, c, { ...o, authToken, proxyUrl }) })`**。

---

## 8. 主要代码文件索引

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 导出 `Agent`、`runAgentLoop*`、`agentLoop*`、`streamProxy`、类型 |
| `src/agent.ts` | `Agent` 类：状态、队列、`prompt`/`continue`、事件订阅、封装 `runAgentLoop*` |
| `src/agent-loop.ts` | `runLoop`、`streamAssistantResponse`、`executeToolCalls*`；函数式 `agentLoop` / `agentLoopContinue` |
| `src/proxy.ts` | `streamProxy`：经 HTTP 的流式代理 |
| `src/types.ts` | `AgentLoopConfig`、`AgentEvent`、`AgentTool`、`StreamFn` 等 |
| `test/*.ts` | Vitest：循环、工具、e2e |

---

## 9. 与 `pi-ai-architecture.md` 的关系

- **pi-ai**：**单次** `stream` / `streamSimple` → `AssistantMessageEventStream` → `AssistantMessage`。
- **pi-agent-core**：在之上维护 **对话 transcript + 工具循环 + 事件**，每一轮 assistant 生成仍依赖 **同一套 `StreamFn`（默认 `streamSimple`）**。

若你只关心「模型如何注册、懒加载」，见 **`learn/pi-ai-architecture.md`**；若关心「多轮 Agent、工具、UI 事件」，以本文为准。
