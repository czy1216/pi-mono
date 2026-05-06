# `@mariozechner/pi-ai` 包架构概览

本文档描述 `packages/ai`（`@mariozechner/pi-ai`）的分层结构与一次调用的主流程，便于阅读源码时建立心智模型。

---

## 1. 分层总览

（路径均相对于仓库根目录下的 `packages/ai/src/`。）

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 对外 API                                                                  │
│   index.ts（再导出）  stream.ts（stream / complete / streamSimple …）      │
│   models.ts（getModel / getModels / getProviders）  env-api-keys.ts     │
└─────────────────────────────────────────────────────────────────────────┘
         │ getModel                              │ stream / streamSimple
         ▼                                       ▼
┌─────────────────────────┐         ┌─────────────────────────────────────┐
│ 模型元数据               │         │ API 实现注册                         │
│ models.generated.ts     │         │ providers/register-builtins.ts     │
│        ↓                │         │   → api-registry.ts                │
│ models.ts（registry）   │         │      registerApiProvider / Map       │
└─────────────────────────┘         └──────────────────┬──────────────────┘
                                                       │
                                                       ▼
                              ┌────────────────────────────────────────────┐
                              │ 各 API 实现（register-builtins 内懒加载）    │
                              │ providers/openai-completions.ts 等（见 §4） │
                              └────────────────────┬───────────────────────┘
                                                   │
                                                   ▼
                              ┌────────────────────────────────────────────┐
                              │ 统一输出                                    │
                              │ utils/event-stream.ts（流与 result）        │
                              │ types.ts（AssistantMessage / 事件类型）     │
                              └────────────────────────────────────────────┘
```

要点：

- **模型表**：`MODELS` 由生成脚本产出，启动时在 `models.ts` 里灌入 `modelRegistry`，`getModel(provider, id)` 只读元数据（含 `model.api` 字段）。
- **实现表**：`register-builtins` 在模块加载时调用 `registerBuiltInApiProviders()`，把每个 `api` 字符串映射到一对 `stream` / `streamSimple` 函数（多为懒加载包装）。
- **调用链**：`stream*` 根据 `model.api` 查表 → 调用对应实现 → 返回 `AssistantMessageEventStream`；`complete*` 即在该流上 `await result()`。

---

## 2. 一次调用（以 `completeSimple` 为例）

```
调用方
  │
  │  completeSimple(model, context, options)
  ▼
stream.ts  （completeSimple → streamSimple）
  │
  │  getApiProvider(model.api)
  ▼
api-registry.ts  （getApiProvider / wrapStreamSimple）
  │
  ├─ 未注册 ──► throw（No API provider for api: …）
  │
  └─ 已注册 ──► 已注册的 streamSimple（多来自 register-builtins 的懒包装）
                    │
                    │  （首次）dynamic import → 某 providers/*.ts
                    ▼
              具体实现：创建 AssistantMessageEventStream（event-stream.ts），push 事件
                    │
                    ▼
stream.ts 把该流返回给调用方
  │
  │  completeSimple 再 await stream.result()
  ▼
AssistantMessage  （类型见 types.ts）
```

`stream` / `complete` 与 `streamSimple` / `completeSimple` 平行，区别在选项类型与是否走「简化」消息管线（由各 provider 的 `stream` vs `streamSimple` 实现决定）。

---

## 3. 注册与懒加载

**模块初始化（随 `stream.ts` 侧链 import 执行）**

```
stream.ts
  import "./providers/register-builtins.js"
         │
         ▼
providers/register-builtins.ts  registerBuiltInApiProviders()
         │
         ▼
api-registry.ts  registerApiProvider({ api, stream, streamSimple })
         │
         ▼
apiProviderRegistry（内存 Map）中填入各 api 对应的 stream / streamSimple
```

**首次请求时的懒加载（`register-builtins.ts` 内 createLazyStream / createLazySimpleStream）**

```
某次调用命中已注册的 stream / streamSimple
         │
         ├─ 首次：import() 拉取对应 providers/<厂商>.ts
         │         → forwardStream：inner 事件 → 外层 utils/event-stream.ts 中的流
         │
         └─ import 失败：createLazyLoadErrorMessage（同文件内，错误以消息流形式呈现）
```

内置 provider 在**导入 `stream` 所在模块**时即完成注册；真正拉取 OpenAI / Anthropic 等实现代码往往在**第一次对该 `api` 发起调用**时通过 `import()` 完成，以控制包体与启动成本。

---

## 4. 主要涉及的代码文件

以下路径均相对于 `packages/ai/src/`（省略前缀时默认在此目录下）。

### 4.1 包入口与类型

| 文件 | 作用 |
|------|------|
| `index.ts` | 对外再导出：`stream`、`models`、`api-registry`、`types`、部分 `providers` 类型与工具等 |
| `types.ts` | `Model`、`Context`、`Api`、`AssistantMessage`、`AssistantMessageEventStream` 等核心类型 |

### 4.2 请求主路径（调用链必读）

| 文件 | 作用 |
|------|------|
| `stream.ts` | `stream` / `complete` / `streamSimple` / `completeSimple`；`import` 触发内置注册 |
| `api-registry.ts` | `registerApiProvider`、`getApiProvider`；`wrapStream` 校验 `model.api` |
| `providers/register-builtins.ts` | `registerBuiltInApiProviders`、懒加载包装、`resetApiProviders` |
| `utils/event-stream.ts` | `AssistantMessageEventStream`（及基类）、异步迭代与 `result()` |

### 4.3 模型元数据

| 文件 | 作用 |
|------|------|
| `models.generated.ts` | 生成的 `MODELS` 常量（模型 id、`api` 字段等） |
| `models.ts` | 从 `MODELS` 构建 `modelRegistry`；`getModel`、`getModels`、`getProviders` |

### 4.4 凭证与环境

| 文件 | 作用 |
|------|------|
| `env-api-keys.ts` | `getEnvApiKey` 等，按 provider / 环境变量解析 API Key |
| `oauth.ts` | OAuth 相关入口（若走浏览器/设备流登录） |
| `utils/oauth/*.ts` | 各厂商 OAuth 辅助（如 `anthropic.ts`、`openai-codex.ts`、`google-gemini-cli.ts` 等） |

### 4.5 各厂商流式实现（由 `register-builtins` 按 `api` 注册）

| 文件 | 典型对应 `api`（概念上） |
|------|---------------------------|
| `providers/anthropic.ts` | anthropic-messages |
| `providers/openai-completions.ts` | openai-completions |
| `providers/mistral.ts` | mistral-conversations |
| `providers/openai-responses.ts` | openai-responses |
| `providers/azure-openai-responses.ts` | azure-openai-responses |
| `providers/openai-codex-responses.ts` | openai-codex-responses |
| `providers/google.ts` | google-generative-ai |
| `providers/google-gemini-cli.ts` | google-gemini-cli |
| `providers/google-vertex.ts` | google-vertex |
| `providers/amazon-bedrock.ts` | bedrock-converse-stream（与 `bedrock-provider.ts` 等配合） |
| `providers/faux.ts` | 测试/占位用假实现 |

### 4.6 Provider 共用与辅助

| 文件 | 作用 |
|------|------|
| `providers/transform-messages.ts` | 消息格式转换等共用逻辑 |
| `providers/simple-options.ts` | Simple 流相关选项辅助 |
| `providers/openai-responses-shared.ts`、`providers/google-shared.ts` | 同系列 API 共用片段 |
| `providers/github-copilot-headers.ts` | Copilot 相关请求头 |
| `utils/json-parse.ts`、`utils/validation.ts`、`utils/overflow.ts`、`utils/sanitize-unicode.ts` 等 | 解析、校验、溢出与 Unicode 处理 |

---


## 5. 扩展方式（概念）

1. **新模型**：在生成管线中更新模型定义，使 `MODELS` / `getModel` 出现新条目，且 `model.api` 与已注册实现一致。
2. **新 API 后端**：实现 `ApiProvider` 的 `stream` + `streamSimple`，在应用启动时 `registerApiProvider`（或 fork `register-builtins` 的注册逻辑）。

以上为 pi-ai 包的主干数据流与模块关系；细节以各 provider 文件为准。
