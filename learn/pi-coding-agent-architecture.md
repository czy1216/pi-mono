# `@mariozechner/pi-coding-agent`（`packages/coding-agent`）架构概览

本文档描述 `packages/coding-agent` 的分层结构、CLI / SDK 入口与一次对话运行的主链路，以及在 **`@mariozechner/pi-agent-core`**、**`@mariozechner/pi-ai`** 之上的职责划分。路径均相对于仓库内 `packages/coding-agent/src/`（除非另有说明）。

---

## 1. 包职责与依赖

- **包名**：`@mariozechner/pi-coding-agent`（目录 `packages/coding-agent`）。
- **直接依赖**（概念分层）：
  - **`@mariozechner/pi-agent-core`**：有状态 `Agent`、多轮工具循环、`prompt` / `continue`、事件流（`AgentEvent`）。
  - **`@mariozechner/pi-ai`**：`Model`、`streamSimple` / `StreamFn`、`Message` / `Context`、模型注册与鉴权相关类型。
  - **`@mariozechner/pi-tui`**：交互式 TUI（终端 UI）、快捷键与渲染基础设施。
- **角色**：在 agent-core 之上实现 **编码场景**：内置 **read / bash / edit / write / grep / find / ls** 等工具、**会话 JSONL 持久化**、**Settings / ResourceLoader / 扩展系统**、**Compaction（上下文压缩）**，并提供 **交互式 / 打印 / RPC** 三种运行模式与 **`createAgentSession` SDK**。

---

## 2. 分层总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 对外入口                                                                  │
│ main.ts（CLI）→ parseArgs / 选会话 / migrations → run mode               │
│ index.ts（库导出）：AgentSession、SDK、SessionManager、工具、扩展类型等     │
└─────────────────────────────────────────────────────────────────────────┘
         │
         ├────────────────────────────┬────────────────────────────────────┐
         ▼                            ▼                                    ▼
┌──────────────────┐      ┌─────────────────────┐            ┌──────────────────┐
│ modes/            │      │ core/sdk.ts         │            │ core/agent-      │
│ interactive/     │      │ createAgentSession  │            │ session-runtime  │
│ print-mode       │      │ createAgentSession* │            │ .ts              │
│ rpc/             │      │                     │            │（CLI 用：cwd +   │
│（I/O 与 UI 层）   │      │ 装配 Agent +         │            │  services 绑定）  │
└────────┬─────────┘      │ AgentSession         │            └────────┬─────────┘
         │                └──────────┬──────────┘                     │
         │                           │                                │
         │                           ▼                                │
         │                ┌─────────────────────┐                       │
         └──────────────► │ core/agent-session │ ◄────────────────────┘
                          │ .ts                 │
                          │ 订阅 Agent 事件、    │
                          │ 持久化、压缩、       │
                          │ 分支、扩展 Runner    │
                          └──────────┬──────────┘
                                     │
                                     │ 持有 pi-agent-core 的 Agent
                                     ▼
                          ┌─────────────────────┐
                          │ @mariozechner/       │
                          │ pi-agent-core        │
                          │ Agent + runAgentLoop │
                          └──────────┬──────────┘
                                     │ streamFn → streamSimple（默认）
                                     ▼
                          ┌─────────────────────┐
                          │ @mariozechner/pi-ai │
                          └─────────────────────┘
```

要点：

- **业务编排中心**是 **`AgentSession`**（不是 `Agent` 本身）：它在 agent-core 循环外加一层「编码 Agent」所需的 I/O 适配、工具定义包装、扩展钩子与会话文件写入。
- **`createAgentSession`**（`core/sdk.ts`）负责 **默认装配**：`AuthStorage`、`ModelRegistry`、`SettingsManager`、`SessionManager`、`DefaultResourceLoader`、`new Agent({...})`、`new AgentSession({...})`。

---

## 3. SDK：`createAgentSession` 装配了什么

（源码：`core/sdk.ts`。）

| 步骤 | 说明 |
|------|------|
| 解析路径 | `cwd`、`agentDir`；默认会话目录随项目 cwd 变化。 |
| 基础设施 | `AuthStorage`、`ModelRegistry`、`SettingsManager`、`SessionManager`、`DefaultResourceLoader.reload()`。 |
| 模型 / 思维链 | 从会话恢复或 `findInitialModel`；`thinkingLevel` 与模型 reasoning 能力对齐（无 reasoning 则强制 `off`）。 |
| `Agent` | `new Agent({ initialState, convertToLlm, streamFn, onPayload, onResponse, transformContext, steering/followUp/transport/thinkingBudgets/retry… })`。 |
| `streamFn` | 默认：`modelRegistry.getApiKeyAndHeaders` + **`streamSimple`**；可叠加 OpenRouter 遥测头、`before_provider_request` 改 payload。 |
| `convertToLlm` | 默认 **`messages.ts` 的 `convertToLlm`**，并可在 settings 开启 **屏蔽图片** 时再包一层过滤。 |
| `AgentSession` | 注入 `sessionManager`、`resourceLoader`、`extensionRunnerRef`、`customTools`、工具 allowlist 等。 |

程序化用法（脚本 / 集成测试）通常只依赖 **`createAgentSession`** 或 **`AgentSessionRuntime`**（CLI 在 `main.ts` 里走 runtime factory，便于切换会话目录与诊断信息）。

---

## 4. `AgentSession`（`core/agent-session.ts`）在做什么

- **组合**：内部持有 **`Agent`**（pi-agent-core）、**`SessionManager`**、**`SettingsManager`**、**`ResourceLoader`**、**`ExtensionRunner`**、内置工具定义与可选 **自定义工具**。
- **持久化**：订阅 agent-core 事件，将会话增量写入 **JSONL**（条目类型见 `session-manager.ts`：`SessionEntry`、压缩条目、模型切换等）。
- **系统提示与上下文**：**`buildSystemPrompt`**（`core/system-prompt.ts`）聚合项目规则、skills、模板等；与 **`prompt-templates`**、**`skills`**、**`slash-commands`** 协同。
- **Compaction**：阈值 / 溢出 / 手动触发时调用 **`core/compaction/`**（`compact`、`shouldCompact`、`generateBranchSummary` 等），必要时插入摘要类消息（与 `messages.ts` 中 compaction 前缀常量一致）。
- **bash**：用户 `!` 命令路径走 **`bash-executor`**；与工具里的 bash 互补。
- **扩展**：通过 **`ExtensionRunner`** 派发 `before_agent_start`、`tool_call`、`session_*`、`context` 变换等事件（类型见 `core/extensions/types.ts`）。
- **对外 API**：`prompt`、`continue`、模型切换、会话分支 / 导入导出等与 CLI 模式共享。

---

## 5. 消息与 LLM 边界：`core/messages.ts`

- 在 **`AgentMessage`**（agent-core）上扩展 **`BashExecutionMessage`、`CustomMessage`、`BranchSummaryMessage`** 等 **编码专用角色**。
- **`convertToLlm`**：把这些自定义消息转成 **`pi-ai` 的 `Message[]`**（含 compaction / branch summary 的文本包装），供 `Agent` 的 `convertToLlm` 注入模型调用。

---

## 6. 内置工具（`core/tools/`）

- **`index.ts`**：`createAllToolDefinitions` / **`createCodingTools`** 等聚合；具体实现在 **`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`**。
- **`tool-definition-wrapper.ts`**：把 **`AgentTool`**（agent-core）包装成带 UI / 扩展事件的 **`ToolDefinition`**。
- 文件类工具常配合 **`withFileMutationQueue`** 做串行化，避免并发写冲突。

---

## 7. 配置、资源与扩展

| 模块 | 职责 |
|------|------|
| `settings-manager.ts` | 项目 / 全局设置、steering / followUp / transport、重试、thinking budgets 等。 |
| `resource-loader.ts` | 加载 `.pi` / AGENTS 类上下文文件、合并设置；向扩展暴露资源路径。 |
| `model-registry.ts` / `model-resolver.ts` | CLI / 会话与可用模型、鉴权状态解析。 |
| `auth-storage.ts` | API Key / OAuth 等凭证存储后端。 |
| `core/extensions/` | `runner.ts` 调度扩展；`examples/extensions/` 中有示例工厂。 |

---

## 8. 运行模式（`src/modes/`）

| 模式 | 入口 | 说明 |
|------|------|------|
| **Interactive** | `modes/interactive/interactive-mode.ts` | TUI：多组件（会话树、模型选择、工具执行展示等，`modes/interactive/components/`）。 |
| **Print** | `modes/print-mode.ts` | 非 TUI、适合管道 / CI 的输出形态。 |
| **RPC** | `modes/rpc/rpc-mode.ts`、`rpc-client.ts` | 进程间命令 / 事件协议，供编辑器或外部驱动。 |

CLI **`main.ts`** 在解析 **`cli/args.ts`** 后选择模式，并处理 **`/import`、列表模型、HTML 导出** 等子命令。

---

## 9. 主流程（与 pi-agent-core 对齐）

与 **`learn/pi-agent-architecture.md`** 中的 **`runAgentLoop`** 一致：**`AgentSession`** 最终仍依赖 **`Agent.prompt` / `Agent.continue`** → agent-core **`runLoop`** → **`streamFn`（默认 `streamSimple`）** → 工具执行结果写回 transcript。

**coding-agent 多出来的环节**集中在：

1. 装配 **`convertToLlm` + streamFn + transformContext（扩展）**；
2. **`SessionManager`** 落盘与恢复；
3. **内置工具 + 扩展工具** 注册进 `Agent`；
4. **Compaction / 分支摘要** 与 **系统提示** 维护。

---

## 10. 主要代码文件索引

| 文件 / 目录 | 职责 |
|-------------|------|
| `src/index.ts` | 包对外导出（Session、SDK、工具、扩展、部分 UI 组件）。 |
| `src/main.ts` | CLI 入口：参数、会话选择、`createAgentSessionRuntime`、模式分发。 |
| `src/core/sdk.ts` | **`createAgentSession`**：默认 Agent + AgentSession 工厂。 |
| `src/core/agent-session.ts` | **`AgentSession`**：生命周期、事件、压缩、分支、扩展。 |
| `src/core/agent-session-runtime.ts` | **`AgentSessionRuntime`**：CLI 场景下会话切换 / cwd 绑定。 |
| `src/core/agent-session-services.ts` | runtime 依赖的 cwd 绑定服务集合。 |
| `src/core/session-manager.ts` | JSONL 会话格式、`SessionManager` API。 |
| `src/core/messages.ts` | 自定义消息与 **`convertToLlm`**。 |
| `src/core/system-prompt.ts` | 系统提示拼装。 |
| `src/core/compaction/` | 上下文压缩与摘要生成。 |
| `src/core/tools/` | 内置工具实现与导出。 |
| `src/core/extensions/` | 扩展类型与 `ExtensionRunner`。 |
| `src/modes/*` | interactive / print / rpc。 |
| `src/cli/args.ts` | CLI 参数解析。 |
| `examples/sdk/*.ts` | 程序化使用示例。 |

---

## 11. 与另两篇架构文档的关系

- **`learn/pi-ai-architecture.md`**：单次 **`streamSimple`**、provider 注册、**`AssistantMessage`** 事件流；coding-agent 的 **`streamFn`** 默认落在此链路上。
- **`learn/pi-agent-architecture.md`**：**`Agent` / `runAgentLoop`**、**`AgentTool`**、**`AgentEvent`**；coding-agent 的 **`AgentSession`** 包裹该层并加上 **会话文件、编码工具、扩展与压缩**。

若你只关心「模型从哪来、如何注册 provider」，以 **pi-ai** 文档为准；若只关心「多轮工具循环与事件语义」，以 **pi-agent-core** 文档为准；若关心 **CLI / 会话 / 工具 / 扩展 / TUI**，以本文 **`packages/coding-agent`** 为准。
