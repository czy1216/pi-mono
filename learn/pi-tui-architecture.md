# Pi 终端 UI：`@mariozechner/pi-tui`（`packages/tui`）架构概览

说明：仓库中 **没有名为 `pi-ui` 的 npm 包**。终端交互界面由 **`@mariozechner/pi-tui`** 提供，源码目录为 **`packages/tui`**。下文「pi 终端 UI」均指本包。

本文描述其分层结构、渲染与输入主路径，以及与 **`pi-coding-agent`** 交互模式的关系。路径均相对于 `packages/tui/src/`。

---

## 1. 包职责与定位

- **包名**：`@mariozechner/pi-tui`。
- **定位**：面向 Node 的 **终端 UI（TUI）库**：基于 **`Component.render(width)`** 的组件树、**差分绘制**（减少闪烁与带宽）、**同步输出**（CSI 2026 等）、**Kitty 键盘协议**、**内联图片**（Kitty / iTerm2）、以及 **快捷键注册表**。
- **典型消费者**：**`@mariozechner/pi-coding-agent`** 的 **`modes/interactive`**（会话树、输入框、模型选择器等组件建立在 `pi-tui` 之上，而非在本包内实现业务 UI）。

---

## 2. 分层总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 对外 API                                                                  │
│ index.ts → TUI / Container / Component                                    │
│          → ProcessTerminal（Terminal 实现）                               │
│          → 各 components/*、keys、keybindings、terminal-image、utils       │
└─────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ tui.ts                                                                   │
│   TUI extends Container                                                  │
│   - 差分渲染、requestRender、overlay 栈、焦点与 CURSOR_MARKER               │
│   Container：纵向拼接子组件 render 结果                                     │
└─────────────────────────────────────────────────────────────────────────┘
         │ uses
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ terminal.ts           │  keys.ts + stdin-buffer.ts                       │
│ Terminal 接口         │  解析按键序列、Kitty 协议、stdin 批处理拆分          │
│ ProcessTerminal：     │                                                   │
│ raw mode、粘贴括号、    │  keybindings.ts：全局逻辑键名 + KeybindingsManager │
│ SIGWINCH、Kitty 探测   │                                                   │
└─────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ terminal-image.ts    │  components/*.ts（Box、Editor、Input、Markdown…） │
│ 能力探测、Kitty/iTerm  │  实现 Component + 可选 Focusable / Theme          │
│ 编码、hyperlink       │                                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

要点：

- **`Terminal`** 抽象读写与尺寸；**`ProcessTerminal`** 绑定 **`process.stdin` / `stdout`**，是 CLI 默认实现。
- **`TUI`** 既是根 **`Container`**，又负责 **把组件输出的行与上一轮比较**，只更新变化区域（并与终端同步刷新策略配合）。
- **输入**从 **`ProcessTerminal.start(onInput)`** 进入 **`TUI`**，再分发到 **焦点组件** 或 **全局 InputListener**。

---

## 3. 核心类型与渲染模型

### 3.1 `Component`（`tui.ts`）

| 成员 | 含义 |
|------|------|
| `render(width: number): string[]` | 在当前视口宽度下输出若干行（可含 ANSI）。 |
| `handleInput?(data: string)` | 获得焦点时接收原始 stdin 片段。 |
| `invalidate()` | 丢弃缓存，触发后续整段或差分重算。 |

**`Focusable`**：带 `focused` 标记；聚焦时应在光标处输出 **`CURSOR_MARKER`**（私有 APC 序列），**`TUI`** 会剥离该标记并把 **硬件光标** 移到 IME 合适位置。

### 3.2 `TUI`：差分渲染与叠加层

- 维护 **`previousLines`** 等与上一轮输出对比，实现 README 所述的 **differential rendering**（多种策略：局部擦除/重绘等，细节见 `tui.ts` 内实现）。
- **`requestRender()`**：节流（如最小间隔 ~16ms），合并高频无效请求。
- **`showOverlay(component, options?)`**：**叠加层栈**，支持锚点、百分比宽高、`visible()` 谓词；返回 **`OverlayHandle`**（hide / focus 等）。
- 环境变量：**`PI_HARDWARE_CURSOR`**、**`PI_CLEAR_ON_SHRINK`**、调试键 **`Shift+Ctrl+D`**（`onDebug`）。

### 3.3 `Container`

- 仅按顺序拼接子组件的 **`render`** 结果，不做布局算法；复杂排版由 **`Box`** 等组件在各自 `render` 内完成。

---

## 4. 终端与输入栈

| 文件 | 职责 |
|------|------|
| **`terminal.ts`** | **`Terminal`** 接口；**`ProcessTerminal`**：raw mode、bracketed paste、`SIGWINCH`、Windows VT 输入、Kitty protocol 查询与启用、`drainInput` 退出前排空等。 |
| **`keys.ts`** | 按键字节流解析为 **`Key`** / **`KeyId`**，`matchesKey`、`isKittyProtocolActive` 等。 |
| **`stdin-buffer.ts`** | 将批量到达的 stdin 拆成独立序列，便于按键与粘贴边界识别。 |
| **`keybindings.ts`** | **`TUI_KEYBINDINGS`** 默认定义；**`KeybindingsManager`** + **`getKeybindings` / `setKeybindings`**；供 Editor / Input / SelectList 等查询「逻辑动作 → 当前键位」。 |

---

## 5. 内置组件（`components/`）

| 组件 | 职责摘要 |
|------|-----------|
| **`Box`** | 边框与内边距容器。 |
| **`Text` / `TruncatedText`** | 纯文本与截断展示。 |
| **`Input`** | 单行输入，配合 keybindings。 |
| **`Editor`** | 多行编辑；undo/ykill 等与 **`undo-stack` / `kill-ring`** 协作（在同目录或相邻模块）。 |
| **`Markdown`** | 终端内 Markdown 渲染（依赖 `marked`、主题）。 |
| **`SelectList` / `SettingsList`** | 列表与设置项导航。 |
| **`Loader` / `CancellableLoader`** | 加载指示。 |
| **`Spacer`** | 占位行。 |
| **`Image`** | 终端图片；底层能力来自 **`terminal-image.ts`**。 |

自定义复杂编辑器可实现 **`EditorComponent`**（`editor-component.ts`）接口嵌入 **`Editor`**。

---

## 6. 终端图片与能力（`terminal-image.ts`）

- **`detectCapabilities` / `getCapabilities`**：是否支持 Kitty / iTerm2 等图形协议。
- **`renderImage`**、`encodeKitty` / `encodeITerm2`、尺寸探测（PNG/WebP/GIF 等）。
- 与 **`utils.ts`** 的 **`visibleWidth`**、ANSI 感知截断/wrap 一起，保证东亚字符宽度与图像行占位一致。

---

## 7. 辅助模块

| 文件 | 职责 |
|------|------|
| **`utils.ts`** | `visibleWidth`、`truncateToWidth`、`wrapTextWithAnsi`、字符串按列切片等。 |
| **`fuzzy.ts`** | `fuzzyMatch` / `fuzzyFilter`，供选择列表等使用。 |
| **`autocomplete.ts`** | 路径与 slash command 等 **`AutocompleteProvider`** 组合。 |

---

## 8. 与 `pi-coding-agent` 的关系

- **coding-agent** 依赖 **`@mariozechner/pi-tui`**，在 **`packages/coding-agent/src/modes/interactive/`** 里组装 **具体界面**（会话树、Assistant/User 消息组件、工具执行视图等），那些类 **使用** `TUI`、`ProcessTerminal`、`KeybindingsManager` 等，但 **业务状态**（会话、Agent 事件）仍在 **coding-agent / agent-core**。
- 若只读 **终端控件与绘制管线**，以 **`packages/tui`** 为准；若读 **pi 产品完整交互流程**，需结合 **`learn/pi-coding-agent-architecture.md`**。

---

## 9. 主要源码索引

| 路径 | 职责 |
|------|------|
| `src/index.ts` | 对外导出汇总。 |
| `src/tui.ts` | **`Component`**、**`Container`**、**`TUI`**、overlay、差分渲染核心。 |
| `src/terminal.ts` | **`Terminal`**、**`ProcessTerminal`**。 |
| `src/keys.ts` | 键盘协议与解析。 |
| `src/keybindings.ts` | 默认键位与 **`KeybindingsManager`**。 |
| `src/stdin-buffer.ts` | stdin 批处理拆分。 |
| `src/terminal-image.ts` | 终端图形能力与中继编码。 |
| `src/components/*.ts` | 内置 UI 组件。 |
| `README.md` | 功能列表、API 片段、环境变量与故障排查补充。 |

---

## 10. 与另两篇文档的边界

- **`pi-ai-architecture.md`**：模型流式调用，与 TUI 无直接耦合。
- **`pi-agent-architecture.md`**：Agent 循环与事件；TUI 可作为其 **前端展示层** 的一种实现（coding-agent interactive）。
- **`pi-coding-agent-architecture.md`**：**谁在什么时机 `new TUI(ProcessTerminal)`、如何订阅 Agent 事件**，见该文档 **`modes/interactive`** 一节。

以上为 **`@mariozechner/pi-tui`** 的主干结构；绘制与 CSI 细节以 `tui.ts`、`terminal.ts` 源码为准。
