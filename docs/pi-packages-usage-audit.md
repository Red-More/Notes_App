# Notes_App 中 pi-ai / pi-agent-core 使用审计报告

- 审计对象：`@earendil-works/pi-agent-core@1.4.0`、`@earendil-works/pi-ai@1.4.0`
- 审计范围：`src/` 前端代码、`src-tauri/src/agent/` 代理实现、两个包的 `dist/*.d.ts` 与官方 README
- 审计方法：全仓检索两个包的导入语句；逐文件阅读调用点；对照官方 README 的功能目录与声明文件导出清单
- 结论口径：只统计**直接 import**；由依赖链间接加载的内容单独标注

---

## 0. 结论摘要

| 项目 | 结论 |
|---|---|
| 使用边界 | 两个包只用于前端 Agent 层；未引入任何 Provider、模型目录或厂商 SDK |
| pi-agent-core 使用面 | 只使用 `Agent` 类、`StreamFn`、`AgentTool`、`AgentMessage`、`AgentEvent` 五个符号 |
| pi-ai 使用面 | 只使用 3 个运行时值（`Type`、`createAssistantMessageEventStream`、`parseStreamingJson`）+ 7 个类型 |
| 传输层 | 官方 `streamProxy` 完全未使用，由 Rust `agent_stream` + 自研 `StreamFn` 等价替换 |
| 功能覆盖 | 现状只覆盖「文本对话 + 工具调用 + 流式事件 + 会话落库」；规划扩展到多模型能力矩阵与图像/视频/语音媒体管线 |
| 主要缺口 | 思考流、图片输入、用量/成本、缓存/会话亲和、重试、遥测、OAuth、模型目录、图像生成、分类、跨 Provider 交接、约束采样、媒体作业与资产库 |
| 扩展边界 | 多 LLM 已具备（任意 model id + 三种协议）；本轮增量是能力矩阵分流与媒体产出，不引入 pi-ai 的 Provider/Auth 体系 |
| 打包合规 | 只从两个包的根入口导入，未触碰 `providers/all`、`api/*` 等子路径，符合项目既定打包边界 |

---

## 1. 依赖与入口事实

| 包 | 版本 | 项目入口 | 实际使用位置 | 备注 |
|---|---|---|---|---|
| `@earendil-works/pi-agent-core` | 1.4.0 | 根入口 `.` | `src/agent/runtime.ts`、`src/agent/stream.ts`、`src/agent/tools.ts`、`src/pages/chat/ChatPage.tsx` | 未使用 `./package.json` 以外的任何子路径 |
| `@earendil-works/pi-ai` | 1.4.0 | 根入口 `.` | `src/agent/protocol.ts`、`src/agent/stream.ts`、`src/agent/runtime.ts`、`src/agent/tools.ts` | 未使用 `./models`、`./compat`、`./providers/*`、`./api/*` |

依赖关系补充：

- `pi-agent-core` 的 `package.json` 将 `pi-ai@1.4.0` 声明为运行时依赖，因此即使只导入 `agent-core`，`pi-ai` 也会被加载。
- `pi-ai` 根入口会立即加载 TypeBox 与 schema 校验逻辑，并依赖 `@earendil-works/pi-telemetry`；但根入口不加载任何 Provider 目录或厂商 SDK。
- 项目未直接 `import` `typebox`，所有 schema 均通过 `pi-ai` 根入口再导出的 `Type` 构造。

---

## 2. 引入内容清单

### 2.1 `@earendil-works/pi-agent-core`

| 引入项 | 类别 | 引入位置 | 具体用途 | 官方定义 |
|---|---|---|---|---|
| `Agent` | 运行时值 | `src/agent/runtime.ts:6` | `new Agent({...})` 创建会话运行时 | `class Agent` |
| `AgentMessage` | 类型 | `src/agent/runtime.ts:7` | 把数据库消息还原为 pi transcript | `type AgentMessage = Message \| CustomAgentMessages[...]` |
| `StreamFn` | 类型 | `src/agent/stream.ts:15` | 约束自研 `nativeStreamFn` 的签名 | `(model, context, options?) => AssistantMessageEventStream \| Promise<...>` |
| `AgentTool` | 类型 | `src/agent/tools.ts:7` | 定义 6 个模型可见工具 | `interface AgentTool<TParameters, TDetails>` |
| `AgentEvent` | 类型 | `src/pages/chat/ChatPage.tsx:11` | `handleEvent` 的事件分发联合类型 | 10 种生命周期事件的联合类型 |

未使用的同包导出（官方能力，但本项目未 import）：

- `agentLoop`、`agentLoopContinue`、`runAgentLoop`、`runAgentLoopContinue`、`runToolCall`
- `streamProxy`、`ProxyAssistantMessageEvent`、`ProxyStreamOptions`
- `setDefaultStreamFn`、`DEFAULT_AGENT_IDENTITY`
- `AgentOptions`、`AgentState`、`AgentContext`、`AgentLoopConfig`、`AgentToolResult`、`BeforeToolCallContext`、`AfterToolCallContext` 等其余类型

### 2.2 `@earendil-works/pi-ai`

| 引入项 | 类别 | 引入位置 | 具体用途 | 官方定义 |
|---|---|---|---|---|
| `Type` | 运行时值 | `src/agent/tools.ts:8` | 构造 6 个工具的 TypeBox 参数 schema | TypeBox 的再导出 |
| `createAssistantMessageEventStream` | 运行时值 | `src/agent/stream.ts:10` | 创建自研流对象，供 pi-agent 消费 | `() => AssistantMessageEventStream` |
| `parseStreamingJson` | 运行时值 | `src/agent/protocol.ts:5` | 把流式工具参数片段解析为可用对象 | `(partialJson?: string) => Record<string, unknown>` |
| `AssistantMessage` | 类型 | `src/agent/runtime.ts:8`、`src/agent/protocol.ts:7` | 还原/重建助手消息 | `interface AssistantMessage` |
| `Model` | 类型 | `src/agent/runtime.ts:8` | 描述性模型对象 | `interface Model<TApi>` |
| `ToolCall` | 类型 | `src/agent/runtime.ts:8`、`src/agent/protocol.ts:9` | 工具调用内容块 | `interface ToolCall` |
| `Usage` | 类型 | `src/agent/runtime.ts:8`、`src/agent/protocol.ts:10` | token/成本占位结构 | `interface Usage` |
| `AssistantMessageEventStream` | 类型 | `src/agent/stream.ts:12` | 自研流的返回类型 | `class AssistantMessageEventStream` |
| `SimpleStreamOptions` | 类型 | `src/agent/stream.ts:13` | 自研流入参类型 | `interface SimpleStreamOptions` |
| `AssistantMessageEvent` | 类型 | `src/agent/protocol.ts:8` | 事件重建函数的返回类型 | 流事件联合类型 |

关键说明：

- `Type` 是 `pi-ai` 对 TypeBox 的再导出；项目没有使用同包导出的 `Static`、`TSchema`、`StringEnum`。
- 项目没有直接调用 `validateToolCall` / `validateToolArguments`；这两个函数由 `pi-agent-core` 在工具预检阶段内部调用。
- 项目没有使用 `createModels()`、`Provider`、`builtinModels()`、`getModel()`、`getAuth()`、`complete()`、`stream()` 等模型运行时能力。

### 2.3 间接加载但未直接使用的依赖

| 依赖 | 加载原因 | 是否直接引用 |
|---|---|---|
| `typebox` | `pi-ai` 根入口再导出 `Type`，并用于运行时 schema 校验 | 否 |
| `@earendil-works/pi-telemetry` | `pi-ai` 的依赖 | 否 |
| `partial-json` | `pi-ai` 实现 `parseStreamingJson` 的底层依赖 | 否 |

---

## 3. 自定义改造与二次封装

### 3.1 `src/agent/runtime.ts`：Agent 运行时装配

| 改造点 | 官方默认/能力 | 本项目实现 | 实际效果 |
|---|---|---|---|
| 模型对象 | 由 `Models.getModel()` 返回目录模型 | `createAppModel()` 手工构造 `Model` | `baseUrl=''`、`cost` 全 0，只作为 pi 的身份描述 |
| API 映射 | 官方有 10 种内置 API | `apiForFormat()` 只映射 3 种 | `anthropic-messages` / `openai-responses` / 其余归为 `openai-completions` |
| 能力默认值 | 来自官方模型目录 | 代码写死默认值 | `contextWindow` 默认 128000，`maxTokens` 默认 4096 |
| 推理能力 | `model.reasoning` 可驱动思考 | 由设置写入 `reasoning`，但 `thinkingLevel` 固定 `'off'` | 仅声明能力，不会实际请求思考 |
| 图片能力 | `model.input` 可含 `image` | 由 `supportsImages` 决定 `['text']` 或 `['text','image']` | 前端没有图片入口，实际不会发送图片 |
| 历史还原 | 官方 `Context` 可直接序列化 | `toAgentMessages()` 从 `ChatMessageRecord[]` 手工还原 | 只还原 user/assistant/toolResult 三种消息 |
| 错误气泡 | 无对应概念 | `record.isError` 的 assistant 记录被跳过 | UI 失败气泡不进入模型上下文 |
| 用量还原 | 官方 `Usage` 由响应携带 | 历史 assistant 一律 `zeroUsage()`、`stopReason='stop'` | 重新打开会话后历史 token/成本为 0 |
| system prompt | `initialState.systemPrompt` | `buildSystemPrompt(skillsIndex)` 生成 | 十条铁律 + 目录约定 + 技能索引 |
| 工具装配 | `initialState.tools` | `createTools(skills)` 生成 6 个工具 | 5 个 `fs_*` + `load_skill` |
| 工具执行模式 | 默认 `parallel` | 显式 `toolExecution: 'parallel'` | 读并行；`fs_write`/`fs_edit` 自行声明 `sequential` |
| 工具配额 | 无内置上限 | `beforeToolCall` 扫描 `context.messages` | 单轮最多 500 步、最多 8 次写入 |
| 未使用的 Agent 钩子 | `convertToLlm`、`transformContext`、`afterToolCall`、`prepareRequest`、`prepareNextTurn`、`finishTurn`、`getApiKey` | 全部未配置 | 使用 Agent 的默认行为 |

配额细节（`runtime.ts:15-17`、`175-207`）：

- `DEFAULT_TOOL_ROUNDS = 500`，且通过 `Math.min(profile.toolRounds ?? 500, 500)` 再夹紧，用户配置无法超过 500。
- `MAX_WRITES_PER_RUN = 8` 为硬编码，不随模型配置变化。
- 统计窗口是「最近一条 user 消息之后」：`toolResult` 计步，assistant 中的 `fs_write`/`fs_edit` 计写入。
- 步数超限返回 `block + terminate`，直接结束本轮；写入超限只返回 `block`，允许模型继续用读工具收尾。

辅助函数改造：

| 函数 | 改造内容 |
|---|---|
| `profileFromSettings()` | 会话记录的模型条目优先；条目被删除时回退到当前激活模型；都没有则返回 `null` |
| `toAssistantMessage()` | 文本块 + `toolCalls` JSON 还原；JSON 损坏时降级为纯文本，避免会话打不开 |
| `extractAssistant()` | 多个文本块用 `\n` 拼接；工具调用序列化为 JSON 字符串；思考块被丢弃 |

### 3.2 `src/agent/stream.ts`：用 Tauri IPC 替换 `streamProxy`

| 改造点 | 官方 `streamProxy` | 本项目 `nativeStreamFn` | 差异影响 |
|---|---|---|---|
| 传输方式 | HTTP 请求后端代理 | `invoke('agent_stream')` + Tauri `Channel` | 无 fetch、无 token、无 URL |
| 取消方式 | `AbortSignal` 驱动 HTTP 取消 | 监听 `options.signal` 后调用 `agent_cancel` | Rust 侧按 `requestId` 置位取消标记 |
| 请求载荷 | `{ model, context, options }` | 只传 `model.id/provider/api`、`context.messages`、`temperature/maxTokens/toolChoice` | 其余 `SimpleStreamOptions` 字段全部丢弃 |
| 鉴权 | 支持 `authToken` | 不传 `apiKey`/`baseUrl`/`authToken` | Key 只在 Rust SecretStore 中读取 |
| 事件来源 | 解析代理返回的事件 | 把 Rust 的 `ProxyEvent` 重建为 pi 事件 | 事件集合被裁剪 |
| 异常处理 | 代理错误转流错误 | `catch` 中构造 `{type:'error'}` 并 `stream.end()` | 错误文案为中文 |
| 流结束 | 由代理事件驱动 | `finally` 中兜底：未终止则推 `error` | 防止流悬挂 |

`SimpleStreamOptions` 字段处理对照：

| 字段 | 是否透传 | 说明 |
|---|---|---|
| `temperature` | 是 | 进入 Rust `Options.temperature` |
| `maxTokens` | 是 | 进入 Rust `Options.maxTokens` |
| `toolChoice` | 是 | 只支持 `auto` / `none`（Rust 侧过滤） |
| `signal` | 否（本地使用） | 只用于触发 `agent_cancel`，不进入 Rust 请求 |
| `samplingParams` | 否 | 未接入 |
| `reasoning` / `thinkingBudgets` | 否 | 未接入 |
| `sessionId` / `cacheRetention` | 否 | 未接入 |
| `headers` / `metadata` / `env` | 否 | 未接入 |
| `transport` / `maxRetryDelayMs` | 否 | 未接入 |
| `onPayload` / `onResponse` / `onProviderStreamEvent` | 否 | 未接入 |
| `apiKey` / `baseUrl` | 否 | 安全红线明确禁止进入 Rust |

### 3.3 `src/agent/protocol.ts`：事件协议桥接

| 改造点 | 官方 `ProxyAssistantMessageEvent` | 本项目 `ProxyEvent` | 差异 |
|---|---|---|---|
| 事件类型 | `start`、`text_*`、`thinking_*`、`toolcall_*`、`done`、`error` | `start`、`text_*`、`toolcall_*`、`done`、`error` | 删除全部 `thinking_*` |
| `text_end` | 可带 `contentSignature` | 带可选 `contentSignature` | Rust 不产出该字段，实际恒为 `undefined` |
| `done` | 可带 `providerThinkingLevel` | 不带 | 思考档位丢失 |
| 工具参数 | `toolcall_delta` 累积 | 额外挂 `partialJson` 字段并每次调用 `parseStreamingJson` | `partialJson` 不属于官方 `ToolCall`，在 `toolcall_end` 时删除 |
| 消息重建 | 官方内部 `processProxyEvent` | 自研 `processEvent()` | 只保留文本与工具调用两条内容链 |
| 用量 | 官方事件携带 | `zeroUsage()` + Rust `done/error.usage` | 前端类型完整，但成本恒 0 |
| 错误格式化 | 无 | `formatError()` 把 Rust `ToolError` 映射为中文可行动文案 | 10 种错误码映射 |

`processEvent()` 的映射关系：

| 输入 ProxyEvent | 输出 `AssistantMessageEvent` | 对 `partial` 的修改 |
|---|---|---|
| `start` | `start` | 无 |
| `text_start` | `text_start` | 在 `contentIndex` 放置空文本块 |
| `text_delta` | `text_delta` | 追加 `delta` |
| `text_end` | `text_end` | 写入 `textSignature` |
| `toolcall_start` | `toolcall_start` | 放置带 `partialJson` 的工具块 |
| `toolcall_delta` | `toolcall_delta` | 累积字符串并重新解析 `arguments` |
| `toolcall_end` | `toolcall_end` | 用完整 `toolCall` 覆盖并删除 `partialJson` |
| `done` | `done` | 写入 `stopReason`、`usage` |
| `error` | `error` | 写入 `stopReason`、`errorMessage`、`usage` |
| 未知/缺失块 | `undefined` | 忽略，不崩溃 |

### 3.4 `src/agent/tools.ts`：6 个 `AgentTool` 的封装

| 工具 | 参数 schema | `executionMode` | Rust 命令 | 自定义行为 |
|---|---|---|---|---|
| `fs_read` | `path`、`rev`、`startLine`、`endLine`、`includeMeta` | 默认（并行） | `api.fsRead` | 读取前拦截 `/life/.agents` |
| `fs_write` | `path`、`content`、`createParents`、`autoFrontmatter` | `sequential` | `api.fsWrite` | 只允许新建，默认补父目录与 frontmatter |
| `fs_edit` | `path`、`oldString`、`newString`、`replaceAll`、`expectRev` | `sequential` | `api.fsEdit` | 字符串唯一命中 + 乐观锁 |
| `fs_glob` | `pattern`、`root`、`caseSensitive` | 默认（并行） | `api.fsGlob` | 相对 pattern 与 root 归一化后做只读校验 |
| `fs_grep` | `pattern`、`path`、`type`、`maxResults`、`contextLines` | 默认（并行） | `api.fsGrep` | 限定路径时拦截 `.agents` |
| `load_skill` | `name` | `parallel` | `skillApi.read` | 按已启用技能 id/名称读取正文 |

统一封装：

- `runTool()` 捕获 Tauri 调用异常，转换成 `{content:[{type:'text'}], details:{error}, isError:true}`，而不是向 pi-agent 抛出异常。
- `toolFailure()` 统一失败结果形状；模型能看到错误文本，UI 能拿到 `details`。
- `renderRead/Glob/Grep/Write` 把结构化结果压成模型可读的纯文本，避免模型直接看到原始 JSON。
- 工具结果只包含文本内容；未使用 `ImageContent`、`structuredContent`、`outputSchema`、`usage`、`terminate`、`onUpdate`。
- 未使用 `prepareArguments`、`replay` 等 `AgentTool` 高级字段。
- `load_skill` 通过闭包持有 `skills` 数组，不暴露任意路径读取能力。

### 3.5 `src/pages/chat/ChatPage.tsx`：事件消费与 UI 状态

| 改造点 | 实现 | 与官方事件的差异 |
|---|---|---|
| 订阅方式 | `agent.subscribe(event => handleEvent(event))` | 监听器同步执行，异步落库由独立串行队列完成 |
| `message_start` | 只处理 assistant，插入流式气泡 | user/toolResult 的 `message_start` 被忽略 |
| `message_update` | 只处理 `text_delta` | `thinking_*`、`toolcall_*` 全部忽略 |
| `message_end` | 提取文本/工具调用、处理失败/取消、落库 | 思考块、usage 不落库 |
| `tool_execution_start` | 插入工具卡片 | 不显示流式参数 |
| `tool_execution_end` | 更新卡片状态与结果、落库 | 不处理 `tool_execution_update` |
| `agent_end` | 关闭流式状态 | `agent_start`、`turn_start`、`turn_end` 未使用 |
| 发送 | 仅 `agent.prompt(text)` | 不支持图片、消息数组、`continue()`、`steer()`、`followUp()` |
| 停止 | `agent.abort()` + `agent.waitForIdle()` | 未使用 `agent.state` |
| 重建 | 页面激活时销毁旧 Agent 并重建 | 未使用 `agent.reset()` |
| 渲染 | 纯文本气泡 + 工具卡片 | 助手输出不走 Markdown 渲染 |
| 用量 | 不展示 | `Usage` 仅作为类型占位 |

持久化改造：

- `enqueuePersist()` 串行化写入，保证 assistant 消息先于其 toolResult 落库。
- 失败/取消气泡也会落库，但 `toolCalls` 被置空。
- 历史恢复时只查询 `ChatMessageRecord[]`，不保存 `Usage`、`ThinkingContent`、图片。

### 3.6 Rust 侧：`streamProxy` 的等价替代

| 改造点 | 官方 `streamProxy` | Rust 实现 | 差异 |
|---|---|---|---|
| 协议契约 | `ProxyAssistantMessageEvent` | `StreamEvent` 枚举 | 形状对齐，事件子集裁剪 |
| 支持 API | 10 种内置 API + 自定义 | 3 种：`openai-chat` / `openai-responses` / `anthropic-messages` | 无 Google、Mistral、Bedrock、Codex、Azure 等 |
| 思考事件 | `thinking_start/delta/end` | 不产出 | 思考内容完全不可见 |
| 图片 | 支持 `ImageContent` | `text_of()` 只提取 `text` 字段 | 图片内容被丢弃 |
| system 消息重放 | `normalizeContext()` | `replay_system()` 支持 `content`、`sections`、`toolsAdded`、`toolsRemoved` | 语义等价，但前端从不追加后续 system 消息 |
| 消息裁剪 | 官方 overflow 工具 | `trim_messages()` 保留全部 system + 最近非 system，总数 ≤ 200 | 超长会话丢弃最旧轮次 |
| 请求校验 | Provider 层 | `validate_request()`：模型条目 id、api、model id、64KB system、4MB 上下文、工具白名单 | 安全边界更硬 |
| 工具白名单 | 无 | `TOOL_ALLOWLIST` 6 项 | 5 个 `fs_*` + `load_skill` |
| 参数层 | `ApiStreamOptions` | `LlmParams` + 每协议 `apply_*` + `extra` 透传 | 参数集合不同 |
| Anthropic `max_tokens` | 由调用方提供 | 缺省回退 4096 | 协议必需兜底 |
| 取消 | `AbortSignal` | `AtomicBool` + `agent_cancel` | 每个请求一个取消标记 |
| 重试 | `utils/retry`、`maxRetryDelayMs` | 无 | 单次请求，失败即错误事件 |
| 遥测 | `pi.ai.*` spans/metrics | 无 | 无观测数据 |

`LlmParams` 支持的参数（`params.rs:50-69`）：

- 基础：`temperature`、`top_p`、`top_k`、`max_tokens`、`stop`、`stream`、`timeout_seconds`
- 高级：`frequency_penalty`、`presence_penalty`、`seed`、`logit_bias`
- 透传：`extra`（禁止覆盖 `model/messages/input/instructions/tools/tool_choice/stream/stream_options/max_output_tokens`）
- 能力提示：`context_window_input`、`context_window_output`、`tool_rounds`、`supports_images`、`thinking_mode`

按协议的应用差异：

| 参数 | OpenAI Chat | OpenAI Responses | Anthropic Messages |
|---|---|---|---|
| `temperature` | 写入 | 写入 | 写入 |
| `top_p` | 写入 | 写入 | 写入 |
| `top_k` | 忽略（非协议字段） | 忽略 | 写入 |
| 输出上限 | `max_tokens` | `max_output_tokens` | `max_tokens`（缺省 4096） |
| `stop` | `stop` | 忽略 | `stop_sequences` |
| `frequency/presence_penalty` | 写入 | 忽略 | 忽略 |
| `seed` / `logit_bias` | 写入 | 忽略 | 忽略 |
| `thinking_mode` | 未应用 | 未应用 | 未应用 |

> 注意：`thinking_mode` 目前只被 `ChatPage.withCapabilities()` 读成 `reasoning: true`，而 `createAgent()` 固定 `thinkingLevel: 'off'`，Rust 也不解析思考参数，因此该设置不会改变请求。

---

## 4. 官方功能对照与未接入清单

本表口径为**当前代码现状**；本轮规划的扩展项见 5.4 与第 6 节，不改变这里的现状判定。

状态定义：

- **已接入**：项目有明确调用点，且行为可用
- **部分接入**：只使用子集，或只在某一层实现
- **未接入**：包内存在能力，但项目没有任何调用点
- **明确不做**：与项目 PRD 边界一致，不属于缺陷

### 4.1 `@earendil-works/pi-ai`

| 功能域 | 官方入口/能力 | 状态 | 具体说明 |
|---|---|---|---|
| Provider/Models 集合 | `createModels()`、`builtinModels()`、`models.setProvider()` | 未接入 | 项目完全手工构造 `Model`，不注册 Provider |
| 自定义 Provider | `createProvider()`、`ProviderStreams` 包装 | 未接入 | 三种协议由 Rust 直接实现，不经过 pi-ai Provider 抽象 |
| 惰性 API 加载 | `lazyApi()`、`lazyStream()` | 未接入 | 没有 Provider 工厂，自然不使用 |
| 内置 Provider 目录 | 30+ Provider、10 种内置 API、`providers/all` | 未接入 | 只支持 3 种线上协议，且由 Rust 自研适配 |
| 模型查询与动态目录 | `getModel(s)`、`getModelsOfType`、`refresh()` | 未接入 | 模型来自本地 `life.db` 用户配置 |
| 模型类型判别 | `hasApi()`、`isModelType()`、`getModelType()` | 未接入 | 只有单一 chat 模型描述 |
| 模型目录持久化 | `ModelsStore` | 未接入 | 使用自研 `model_store.rs` |
| API Key 鉴权 | `getAuth()`、环境变量、`CredentialStore` | 未接入 | 使用 Rust `SecretStore` + Keystore/0600 文件 |
| Provider 级环境覆盖 | 请求选项 `env` | 未接入 | 无 |
| OAuth 登录/刷新 | `models.login()`、`logout()`、provider OAuth | 未接入 | 无 OAuth 流程 |
| CLI 登录 | `npx @earendil-works/pi-ai login` | 未接入/不适用 | 桌面/移动 GUI 应用，不提供 CLI |
| 客户端身份 | `identity`、`withClientIdentity()` | 未接入 | 不发送 attribution/User-Agent 定制头 |
| 请求头变换 | `transformHeaders` | 未接入 | 无 |
| 流式对话 | `models.stream()`、`streamSimple()` | 未接入 | 使用自研 `StreamFn` + Rust SSE |
| 非流式对话 | `complete()`、`completeSimple()` | 未接入 | Rust 侧虽支持 `stream=false`，但 UI 始终以事件流消费 |
| 上下文规范化 | `normalizeContext()` | 间接接入 | 由 `pi-agent-core` 内部调用，项目未直接调用 |
| Provider 专属选项 | `AnthropicOptions`、`OpenAIResponsesOptions`、`GoogleOptions` 等 | 未接入 | 只用通用 `SimpleStreamOptions` 的三个字段 |
| OpenAI 兼容性设置 | `compat`（`supportsDeveloperRole`、`supportsReasoningEffort`、`maxTokensField`、`thinkingFormat` 等） | 未接入 | 协议差异由 Rust 硬编码 |
| 延迟响应 | `streamDeferred()`、`fetchDeferred()`、`cancelDeferred()` | 未接入 | 有抽象；1.4.0 中仅 faux 测试 Provider 实现，内置真实适配器未实现 |
| Tool 定义 | `Tool`、`Type`、`Static`、`TSchema` | 部分接入 | 只使用 `Type`；未用 `Static`/`TSchema` |
| 枚举 schema 辅助 | `StringEnum()` | 未接入 | 工具没有枚举参数 |
| 工具参数校验 | `validateToolCall()`、`validateToolArguments()` | 部分接入 | 未直接调用，由 `pi-agent-core` 内部调用 |
| 约束采样 | `constrainedSampling`（JSON Schema / grammar） | 未接入 | 6 个工具均未声明 |
| 流式参数解析 | `parseStreamingJson()`、`parseToolCallArguments()` | 部分接入 | 只用 `parseStreamingJson`；完整参数由 Rust `ToolCallPayload` 解析 |
| 思考/推理 | `thinking_*` 事件、`reasoning`、`thinkingBudgets`、`providerThinkingLevel` | 未接入 | Rust 不解析、前端不消费、持久化不保存 |
| 思考档位探测 | `getSupportedThinkingLevels()` | 未接入 | `thinkingLevel` 固定 `off` |
| 图片输入 | `ImageContent`、多模态消息 | 未接入 | UI 无图片入口；Rust `text_of()` 丢弃图片 |
| 图像生成 | `generateImages()`、`ImageModel` | 未接入 | 无调用 |
| 结构化分类 | `classify()`、`ClassifierModel` | 未接入 | 无调用 |
| 用量与成本 | `Usage`、`model.cost`、`cost.total` | 部分接入 | 类型存在；Rust 只统计部分协议 token，成本恒 0，UI 不展示 |
| Stop Reason | `pending/stop/length/toolUse/error/aborted/deferred` | 部分接入 | 前 6 种可出现；`deferred` 未接入 |
| 错误处理 | 流内 `error` 事件、setup 错误 | 部分接入 | 自研错误事件可用；缺少官方错误分类/诊断 |
| 中止请求 | `signal`、`abort()` | 部分接入 | 通过 `agent_cancel` 可用 |
| Payload 调试 | `onPayload`、`onResponse` | 未接入 | 无调试回调 |
| Provider 原始事件观测 | `onProviderStreamEvent` | 未接入 | 无 |
| 重试工具 | `utils/retry`、`provider-retry`、`maxRetryDelayMs` | 未接入 | 无自动重试 |
| 遥测 | `pi.ai.request`、`pi.ai.block`、token/cost 指标 | 未接入 | 无 `pi-telemetry` 使用 |
| 跨 Provider 交接 | 自动丢弃异模型思考、保留工具调用 | 未接入 | 手工重放 transcript；思考始终被丢弃 |
| 会话中 system 消息 | `SystemMessage.sections/toolsAdded/toolsRemoved` | 部分接入 | Rust `replay_system()` 支持，前端从不追加 |
| 上下文序列化 | `Context` JSON 持久化 | 部分接入 | 自研 SQLite 表结构，不是 `Context` JSON |
| 上下文溢出 | `utils/overflow`、`estimate` | 未接入 | Rust 只做 200 条消息裁剪 |
| 诊断工具 | `utils/diagnostics` | 未接入 | 无 |
| 会话资源清理 | `cleanupSessionResources()` | 未接入 | 无 WebSocket/会话缓存 |
| 文本/transcript 工具 | `contentText`、`renderSystemMessageUpdate`、`getCurrentTools` 等 | 未接入 | Rust 自行重放 |
| UUID/版本常量 | `uuidv7()`、`PI_AI_VERSION` | 未接入 | 使用 `crypto.randomUUID()` 自研 |
| 测试 Faux Provider | `fauxProvider()`、`fauxAssistantMessage()` 等 | 未接入 | 单测直接构造 `partial` |
| 兼容层 | `@earendil-works/pi-ai/compat` | 未接入 | 只用根入口 |
| 浏览器使用 | 根入口 + 显式 `apiKey` | 符合 | 前端不直连厂商，符合浏览器安全建议 |
| 打包/摇树 | 根入口、禁 `providers/all` | 符合 | 未引入任何 Provider 目录或 SDK |

### 4.2 `@earendil-works/pi-agent-core`

| 功能域 | 官方入口/能力 | 状态 | 具体说明 |
|---|---|---|---|
| Agent 生命周期 | `new Agent()`、`prompt()`、`waitForIdle()`、`abort()` | 已接入 | 对话主链路 |
| 流函数注入 | `streamFn` | 已接入 | 自研 `nativeStreamFn` |
| 工具定义 | `AgentTool`、`execute()` | 已接入 | 6 个工具 |
| 工具执行模式 | `toolExecution`、`executionMode` | 部分接入 | 全局 `parallel`；写工具 `sequential` |
| 工具预检 | `beforeToolCall` | 部分接入 | 只做步数/写入配额，不使用 `toolCall`/`args` |
| 工具后处理 | `afterToolCall` | 未接入 | 无审计/覆盖结果 |
| 消息转换 | `convertToLlm` | 未接入 | 使用默认实现 |
| 上下文变换 | `transformContext` | 未接入 | 裁剪在 Rust 侧 |
| 动态 API Key | `getApiKey` | 未接入 | 不适用（Key 在 Rust） |
| 请求前重放 | `prepareRequest` | 未接入 | 无 |
| 下一轮准备 | `prepareNextTurn`、`prepareNextTurnWithContext` | 未接入 | 无 |
| 轮次收尾 | `finishTurn` | 未接入 | 由 `toolUse` 自然继续 |
| 会话 ID | `sessionId` | 未接入 | 无 prompt cache/会话亲和 |
| 请求身份 | `identity` | 未接入 | 无 |
| 请求调试回调 | `onPayload`、`onResponse`、`onProviderStreamEvent` | 未接入 | Agent 选项未配置 |
| 思考档位 | `thinkingLevel`、`thinkingBudgets` | 未接入 | 固定 `off` |
| 传输选择 | `transport` | 未接入 | 由 Rust 决定 HTTP/SSE |
| 重试延迟上限 | `maxRetryDelayMs` | 未接入 | 无重试 |
| Steering 队列 | `steer()`、`steeringMode`、`clearSteeringQueue()` | 未接入 | UI 只能停止后重发 |
| Follow-up 队列 | `followUp()`、`followUpMode`、`clearFollowUpQueue()` | 未接入 | 无排队输入 |
| 队列预览 | `peekQueuedMessages()`、`hasQueuedMessages()` | 未接入 | 无 |
| 继续执行 | `continue()` | 未接入 | 每次都是新 `prompt()` |
| 状态读取 | `agent.state.isStreaming/streamingMessage/pendingToolCalls/errorMessage` | 未接入 | UI 自己维护流式状态 |
| 运行信号 | `agent.signal` | 未接入 | 只依赖 `abort()` |
| 重置 | `reset()` | 未接入 | 通过销毁/重建 Agent 实现 |
| 事件订阅 | `subscribe()` | 部分接入 | 10 种事件只消费 6 种；忽略 `agent_start`、`turn_start`、`turn_end`、`tool_execution_update` |
| 思考事件 | `message_update.assistantMessageEvent.thinking_*` | 未接入 | 前端只处理 `text_delta` |
| 图片提示 | `prompt(text, images)` | 未接入 | 只支持纯文本 |
| 自定义消息类型 | `declare module` 扩展 `CustomAgentMessages` | 未接入 | 历史只有标准三角色 |
| 低层循环 | `agentLoop`、`agentLoopContinue`、`runAgentLoop`、`runAgentLoopContinue` | 未接入 | 只用高层 `Agent` |
| 嵌套工具调用 | `runToolCall()` | 未接入 | 无 codemode/工具嵌套 |
| 代理流 | `streamProxy` | 未接入 | Rust 等价替代 |
| 默认流函数 | `setDefaultStreamFn()` | 未接入 | 显式传入 `streamFn` |
| 工具高级字段 | `prepareArguments`、`outputSchema`、`structuredContent`、`replay`、`usage`、`terminate`、`onUpdate` | 未接入 | 只用 `name/label/description/parameters/execute/executionMode` |
| 工具进度流 | `onUpdate()` | 未接入 | 工具卡片只在 start/end 更新 |
| 工具错误约定 | 抛出异常由 Agent 转 `isError` | 已接入 | 项目主动返回 `isError: true` 结果；官方 `AgentToolResult` 同样支持该形状 |
| MCP 集成 | `@earendil-works/pi-mcp` | 未安装/未接入 | 不安装；需要时只做 Rust 远程 MCP（见 4.3） |
| Codemode 集成 | `@earendil-works/pi-codemode` | 未安装/未接入 | 保持排除，不执行模型生成的代码 |

### 4.3 项目边界（含扩展后的取舍）

以下能力与 `docs/refactoring-sqlite-vfs-pi-agent.md` 的边界一致；「本轮结论」列区分永久排除与扩展后新增范围。

| 能力 | 排除原因 | 本轮结论 |
|---|---|---|
| Shell/命令执行 | 安全边界：模型无 shell | 永久排除 |
| 真实文件系统访问 | 只走 SQLite 虚拟 FS | 永久排除 |
| Web 搜索/网页抓取 | 明确不做 | 永久排除 |
| 模型自主后台任务 / notebook | `Agent` 无 task 层能力 | 永久排除 |
| 媒体作业队列（图像/视频/TTS） | 与 Agent run 生命周期解耦 | 新增规划，见 6.4.2 |
| 多人协作/云同步 | 明确不做 | 永久排除 |
| 插件/扩展执行 | 技能只注入 prompt，不执行代码 | 永久排除 |
| stdio / 本地进程型 MCP | 需要 spawn 进程，破坏边界 | 永久排除 |
| 远程 HTTP/SSE MCP | 可由 Rust 持白名单直连 | 后置规划，非本轮必做 |
| Codemode 脚本执行 | 需要执行模型生成的代码 | 永久排除 |
| 厂商 SDK 直连 | 网络请求全部留在 Rust | 排除；仅允许 Rust 内 REST 实现 |

### 4.4 关于「异步 / 后台任务」的澄清

| 概念 | 官方是否有 | 具体形态 | 当前项目 |
|---|---|---|---|
| Agent 后台任务 / task 队列 | 无 | `Agent` 同一时间只允许一个 `activeRun`；工具在循环内 `await` 完成；无定时器、worker、任务持久化或恢复 | 未实现，PRD 明确不做 task |
| 运行中追加输入 | 有 | `steer()` / `followUp()` + `steeringMode` / `followUpMode`；属于同一 run 内的消息排队 | 未接入 |
| Provider 延迟响应（deferred） | 有抽象 | `SimpleStreamOptions.deferred` 请求 Provider 返回 `DeferredHandle`；`AssistantMessage.stopReason='deferred'`；之后用 `Models.streamDeferred()/fetchDeferred()/cancelDeferred()` 轮询 | 未接入；Rust 代理没有对应协议 |
| deferred 的实际可用性 | 受限 | 当前 1.4.0 只有 faux 测试 Provider 实现 `fetchDeferred`/`cancelDeferred`；内置真实 Provider 适配器未实现 | 对现有三种真实协议不可用 |
| Agent 是否传递 deferred | 否 | `AgentOptions` 没有 `deferred` 字段，`createLoopConfig()` 不传该选项 | 即使底层 `StreamFn` 支持，也无法经 `Agent` 开启 |
| App 级媒体作业队列 | 官方无 | 无现成抽象；需要任务表、轮询、取消与重启恢复 | **规划中**：视频生成必需，图像与长 TTS 复用同一套 |

结论：`pi-agent-core` 没有「模型后台执行 task」这一层能力；`pi-ai` 只有 Provider 级的 deferred-response 抽象，且当前版本对真实 Provider 基本不可用。扩展后的做法是：**不使用 pi-ai 的 deferred**，在 Rust 侧自建作业队列（表 + 提交/取消/查询 + 重启恢复），由厂商异步接口驱动；「模型自主排队后台任务」仍不做。

---

## 5. 未完成功能点汇总（按接入优先级）

### 5.1 P0：影响当前对话质量或正确性

| 功能点 | 当前落点 | 缺口 |
|---|---|---|
| 思考流全链路 | 类型与事件协议已预留 | Rust 不解析 `thinking_*`；前端不消费；持久化不保存；`thinkingLevel` 固定 `off` |
| 用量/成本展示 | `Usage` 类型、Rust 部分 token 统计 | 成本恒 0；UI 不展示；历史消息用量丢失 |
| 模型能力接线 | `withCapabilities()` 读取 `thinkingMode`、`contextWindow` | `thinkingMode` 未驱动请求；`contextWindow` 只写入描述性 `Model` |
| 超长会话策略 | Rust `trim_messages()` 200 条 | 未使用 pi-ai overflow/estimate；裁剪粒度是消息条数而非 token |
| 错误分类与重试 | 自研 `error` 事件 | 无 `utils/retry`、无 `maxRetryDelayMs`、无错误类型分层 |
| 工具参数展示 | 工具卡片只在 start/end 更新 | 未消费 `toolcall_delta`，看不到参数流式生成 |

### 5.2 P1：官方能力可直接增强体验

| 功能点 | 当前落点 | 缺口 | 本轮结论 |
|---|---|---|---|
| 图片输入 | `supportsImages` 写入 `model.input` | UI 无入口；Rust 丢弃图片；历史不保存图片 | 实现 |
| 缓存/会话亲和 | 无 | 未传 `sessionId`/`cacheRetention`；Rust 无缓存头 | 实现 |
| Payload/原始事件调试 | 无 | 未接 `onPayload`/`onResponse`/`onProviderStreamEvent` | 仅开发开关 |
| 工具后处理 | 无 | 未接 `afterToolCall`，无法统一审计/改写结果 | 实现（媒体工具审计依赖） |
| 轮次收尾控制 | 无 | 未接 `finishTurn`，无法按 stopReason 精细结束 | 实现 |
| 请求前上下文重放 | 无 | 未接 `prepareRequest`，长会话只能靠 Rust 裁剪 | 与 `transformContext` 合并实现 |
| 遥测 | 无 | 未接 `pi-telemetry`，无耗时/token/成本指标 | 不实现 |
| 队列式交互 | 无 | 未接 `steer()`/`followUp()`，运行中不能补充指令 | 实现 |

### 5.3 P2：体系级能力

| 功能点 | 当前落点 | 缺口 | 本轮结论 |
|---|---|---|---|
| Provider/Models 体系 | 手工 `Model` | 未接 `createModels()`、Provider 工厂、模型目录 | 不实现；改自建能力矩阵 |
| OAuth/凭证存储 | Rust SecretStore | 未接 pi-ai `CredentialStore`/`login()`/`logout()` | 不实现 |
| 多协议覆盖 | 3 种协议 | 未接 Google、Mistral、Bedrock、Azure、Codex、OpenRouter 等 | 只按能力补齐媒体协议 |
| 约束采样 | 无 | 未声明 `constrainedSampling` | 不接字段；用协议原生结构化输出 |
| 图像生成/分类 | 无 | 未接 `generateImages()`/`classify()` | 实现，走 Rust 媒体管线 |
| 延迟响应 | 无 | 未接 deferred 流 | 不使用 pi-ai deferred；自建作业队列 |
| 跨 Provider 交接 | 手工重放 | 未接官方交接逻辑，思考无法保留 | 不实现 |
| Faux Provider | 无 | 单测未使用官方测试 Provider | 不实现 |
| 兼容层 | 无 | 未接 `pi-ai/compat` | 不实现 |

### 5.4 扩展范围新增功能点

| 功能点 | 内容 | 优先级 |
|---|---|---|
| 模型能力矩阵 | `kind`（chat/image/video/tts/classify）、模态、上下文、价格、结构化输出与工具支持 | P0 |
| 媒体作业子系统 | `jobs` 表 + 提交/查询/取消 + Channel 进度 + 重启恢复 | P0（视频必需） |
| 资产库 | 磁盘 `media/{sha256}` + SQLite 元数据引用 + 哈希去重 | P0 |
| 成本账本扩展 | token / 张 / 秒 / 千字符统一记账 | P0 |
| TTS | Rust 音频协议 + 资产入库 + 播放 | P1 |
| 分类 | 非流式 + JSON Schema 结构化输出 | P1 |
| 图像生成 | Rust 图像协议 + 资产入库 | P1 |
| 视频生成 | 复用作业队列，轮询/取消/恢复 | P2 |
| 远程 MCP | 仅 HTTP/SSE + 白名单 | P2（可选） |

---

## 6. 引入建议与扩展范围

本章结论已按扩展目标更新：产品不再只有单一 chat 模型，需要支持多 LLM 能力矩阵、文生图、视频生成与文字转语音。**6.1、6.2 全部采纳**；6.3 只保留真正越界或无效的项。

`pi-ai` 的 Provider/Models/Auth 体系仍然不引入：它会把 URL、密钥与网络请求搬回 WebView，与现有 Rust 代理的安全边界冲突。媒体能力改由 Rust 侧的「协议适配 + 作业队列 + 资产库」实现，`pi-ai` 继续只承担 Agent 状态机、事件协议与类型系统。

### 6.1 强烈建议（已采纳）

| 优先级 | 建议引入 | 理由 | 落点 |
|---|---|---|---|
| 强烈建议 | `toolcall_delta` 工具参数流式展示 | Rust 和 [protocol.ts](../src/agent/protocol.ts) 已经在发这个事件，前端只是没消费；纯前端改动，能提前显示 `path` 等参数 | [ChatPage.tsx](../src/pages/chat/ChatPage.tsx) 的 `message_update` |
| 强烈建议 | `Usage` 全链路持久化与展示 | 现在 Rust 已统计 token，但 [runtime.ts](../src/agent/runtime.ts) 历史还原时归零，UI 也不展示；至少展示 input/output/total | 消息表加字段 + 气泡/工具卡展示；成本由 6.4.1 的 `pricing` 驱动，随能力矩阵一起落地 |
| 强烈建议 | `estimateContextTokens` + `Agent.transformContext` | 当前 Rust 只按 200 条消息裁剪，长消息仍可能爆上下文；用 token 预算裁剪到 `contextWindow` 的 70–80%，Rust 的 200 条保留为兜底 | `createAgent()` 增加 `transformContext` |

以上三项全部纳入本轮实现。

### 6.2 按需引入（已全部采纳，按序落地）

| 能力 | 什么时候值得引入 | 代价 |
|---|---|---|
| `thinking_*` 全链路 | 目标模型以 reasoning 为主，且用户愿意等 | Rust 三种协议都要解析 thinking，前端与持久化也要改 |
| `sessionId` + `cacheRetention` | 主要直连 Anthropic/OpenAI 或明确支持缓存的网关 | Rust 要补 prompt cache 字段/头，第三方网关不一定支持 |
| 图片输入 | 要做「拍照记笔记 / 图片 OCR」 | Rust 要多模态消息转换，UI 要附件与存储 |
| `steer()` / `followUp()` | 要做「运行中追加指令」 | UI 目前流式时禁用输入，需要改交互与状态 |
| `continue()` | 想修「重试会重复插入 user 消息」 | 需要处理已取消的 assistant 消息作为上下文 |
| `StringEnum` / `prepareArguments` | 弱模型经常给错枚举值或参数形状 | 只改工具 schema/兼容层，收益有限 |

以上六项全部纳入实现：`thinking_*` 全链路落地（默认折叠展示），图片输入与 `sessionId`/`cacheRetention` 在媒体管线打通后落地。

### 6.3 明确不建议（扩展后仍不采纳）

| 项 | 不采纳原因 | 替代方案 |
|---|---|---|
| `createModels()` / `Provider` / `getAuth()` / OAuth / 内置模型目录 | 会把 URL、密钥、网络请求搬回 WebView，违背「Key 不进 JS、请求只走 Rust」红线，并破坏打包边界 | 自建 Rust 能力矩阵（6.4.1），密钥继续留在 `SecretStore` |
| `pi-telemetry` | 项目定位隐私优先 | 不做；成本统计走本地账本 |
| Codemode（`@earendil-works/pi-codemode`） | 需执行模型生成的代码，等于新增一个沙箱运行时（JS runtime、资源限制、逃逸面），与 SQLite 虚拟 FS 的边界相反 | 用「批量复合工具」（一次读多个路径）替代，不执行代码 |
| stdio / 本地进程型 MCP | 需 spawn 进程，破坏「无 shell、无插件执行」边界 | 需要时只做远程 HTTP/SSE + Rust 白名单，后置 |
| `pi-ai` 的 `deferred` API | 1.4.0 仅 faux Provider 实现，`AgentOptions` 也不透传 `deferred` | 自建 Rust 作业子系统（6.4.2） |
| `constrainedSampling` 字段本体 | 现有 `SimpleStreamOptions` 子集不透传该字段，接入等于死字段；6 个 `fs_*` 工具收益低 | 分类/抽取改用协议原生 `response_format` / JSON Schema（等价能力） |
| 图像生成/分类「走 pi-ai Provider API」 | 同为 Provider/Auth 体系问题，会把请求搬回 WebView | 在 Rust 内实现 REST 协议，产物进资产库 |
| 生产环境默认开启 `onPayload` / `onProviderStreamEvent` | 只适合开发调试，含敏感载荷 | 保留为显式开发开关 |

### 6.4 扩展能力架构（规划）

#### 6.4.1 模型能力矩阵

`model_store.rs` 的条目目前只有 chat 语义，扩展为按能力分流的最小描述：

| 字段 | 用途 |
|---|---|
| `kind` | `chat` / `image` / `video` / `tts` / `classify` |
| `modalities` | 输入/输出支持（text、image、audio） |
| `context_window` / `max_output` | 复用现有能力提示 |
| `pricing` | token / 张 / 秒 / 千字符单价，供成本账本 |
| `supports` | 工具、结构化输出、思考、缓存 |

不引入 pi-ai `createModels()`；能力矩阵只是 `life.db` 的结构扩展与 UI 分组依据。

#### 6.4.2 媒体作业子系统（Rust）

| 组成 | 职责 |
|---|---|
| `jobs` 表 | `id/kind/model_entry_id/params/status/progress/asset_id/error/created_at/updated_at` |
| Tauri 命令 | `job_submit`、`job_get`、`job_list`、`job_cancel` |
| Channel 事件 | 状态变更、进度、完成/失败，复用现有 Tauri Channel |
| 执行器 | tokio 任务；异步厂商按固定间隔轮询；429/超时退避重试 |
| 恢复 | 启动时扫描 `pending`/`running` 作业，重新接管或标记失败 |
| 取消 | `AtomicBool` + 远端 cancel 接口（厂商支持时） |

约束：作业与 `Agent` run 生命周期完全解耦；一次 run 结束不终止作业，作业失败也不回写对话气泡。

#### 6.4.3 资产库

| 项 | 设计 |
|---|---|
| 存储位置 | 磁盘 `appdata/media/{sha256}.{ext}`；SQLite 只存元数据与引用 |
| 元数据 | `assets(id, sha256, mime, size, width/height, duration, source_job_id, created_at)` |
| 去重 | 内容哈希去重，同图多次生成只留一份 |
| 生命周期 | 笔记删除不立即删资产，由定期 GC 或引用计数回收 |
| 传输 | 返回本地路径/asset URL，不用 base64 走 IPC |
| 临时 URL | 厂商签名 URL 立即下载落地，并校验 mime 与大小 |

不把视频/音频塞进笔记库 SQLite：会显著放大 WAL 与备份体积。

#### 6.4.4 成本账本

| 单位 | 来源 |
|---|---|
| token（in/out） | chat 响应的 `Usage` |
| 张 | 图像生成成功数 |
| 秒 | 视频时长 |
| 千字符 | TTS 输入长度 |

同一张账覆盖全部 `kind`，UI 按会话/按天聚合；历史消息还原时保留 usage，不再统一归零。

#### 6.4.5 Agent 暴露策略

| 阶段 | 做法 |
|---|---|
| 一期 | 媒体生成只由 UI 显式触发，不进模型工具集 |
| 二期 | 若确需模型自主触发，再包成 `AgentTool`，并加「单轮最多 N 次媒体生成」配额，与 `MAX_WRITES_PER_RUN` 同思路 |
| 始终 | 媒体工具结果只返回资产引用与摘要，不返回二进制 |

#### 6.4.6 按能力补齐的协议

| 能力 | Rust 需实现的协议（纯 REST，密钥留在 `SecretStore`） | 响应形态 |
|---|---|---|
| 图像 | OpenAI Images、DashScope 万相、火山 Seedream | 部分同步、部分异步轮询 |
| 视频 | 火山 Seedance、DashScope、可灵类异步接口 | 全部异步作业 |
| TTS | OpenAI Audio、DashScope CosyVoice、ElevenLabs | 同步或流式字节 |
| 分类 | 复用 chat 协议 + `response_format` | 同步非流式 |

现有三种 chat 协议不动；媒体协议按需增量，不铺开 pi-ai 的 30+ Provider。

### 6.5 落地顺序

1. 能力矩阵（`kind`/`capabilities`/价格）→ 验证：UI 能按能力分组选模型
2. 资产库 + 作业骨架 → 验证：提交假作业，能落库、能取消、重启能恢复
3. 分类 + TTS → 验证：一次非流式分类与一段音频入库，成本账正确
4. 图像生成 + 图片输入 → 验证：三协议图片透传与产物展示
5. 视频生成 → 验证：长任务进度、取消、重启恢复
6. 远程 MCP / 结构化输出按需 → 验证：白名单拒绝非清单地址

先做第 3 步的理由：分类与 TTS 用最小代价验证「非 chat 能力 + 资产 + 成本」三件基础设施；图像与视频只是复用它们，反过来先上视频会同时踩作业恢复、大文件存储、高成本三个坑。

---

## 7. 关键文件索引

| 文件 | 作用 |
|---|---|
| `src/agent/runtime.ts` | Agent 装配、模型描述、历史还原、配额钩子、消息提取 |
| `src/agent/stream.ts` | 自研 `StreamFn`、Tauri Channel、取消桥接 |
| `src/agent/protocol.ts` | Rust 事件 → pi 事件重建、错误文案 |
| `src/agent/tools.ts` | 6 个 `AgentTool`、参数 schema、结果渲染 |
| `src/agent/prompt.ts` | system prompt |
| `src/agent/skills.ts` | 技能索引 |
| `src/pages/chat/ChatPage.tsx` | 事件消费、流式渲染、工具卡片、会话持久化 |
| `src-tauri/src/agent/llm.rs` | `streamProxy` 的 Rust 等价实现、三种协议适配 |
| `src-tauri/src/agent/params.rs` | 每模型参数与按协议应用 |
| `src-tauri/src/agent/model_store.rs` | 模型条目与协议映射 |
| `src-tauri/src/agent/mod.rs` | 工具白名单、HTTP 客户端、Agent 状态 |

规划新增（尚未创建，命名暂定）：

| 模块 | 作用 |
|---|---|
| `src-tauri/src/media/mod.rs` | 媒体协议适配与模块入口 |
| `src-tauri/src/media/jobs.rs` | 作业表、提交/取消/查询、启动恢复 |
| `src-tauri/src/media/assets.rs` | 资产哈希、落盘、引用与 GC |
| `src-tauri/src/media/providers/` | 图像/视频/TTS 各厂商 REST 适配 |

---

## 8. 一句话总结

当前实现把两个包当作「Agent 状态机 + 事件协议 + 类型系统」使用：`pi-agent-core` 提供对话/工具循环，`pi-ai` 提供 `Type`、事件流工厂与流式 JSON 解析。扩展后这一定位不变：多 LLM 由 Rust 能力矩阵分流，图像/视频/TTS 由 Rust「媒体协议 + 作业队列 + 资产库」产出，`pi-ai` 的 Provider/Auth/deferred/constrainedSampling 均不引入。

本轮落地顺序：6.1 三项 → 能力矩阵与作业/资产骨架 → 分类与 TTS → 图像生成与图片输入 → 视频 → 远程 MCP。Codemode、stdio MCP、Provider 体系、遥测保持排除。
