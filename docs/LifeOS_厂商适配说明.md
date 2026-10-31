# LifeOS 模型接入说明（v3）

| 项目 | 内容 |
|---|---|
| 代码基线 | `src-tauri/src/agent/{model_store,params,discovery,llm}.rs`、`commands/agent.rs`、`src/pages/settings/AgentSettingsSection.tsx` |
| 设计参考 | [Model Management.md](./Model%20Management.md)（模型管理模块） |
| 协议范围 | OpenAI Chat Completions（`<baseUrl>/chat/completions`）、OpenAI Responses（`<baseUrl>/responses`）、Anthropic Messages（`<baseUrl>/v1/messages`） |
| 目标平台 | Tauri 2（Android ARM64 + 桌面） |
| 安全模块 | `url`（MIT/Apache-2.0）、`keyring-core` + `android-native-keyring-store`（MIT）、`rusqlite`（MIT） |

> 本版按用户确认的最终规范落地：**系统不提供任何预置模型**，模型全部由用户添加；
> 下拉列表里只保留 Base URL 预设，协议固定为上述三种，不再提供 Gemini 与 Model Series。

---

## 1. 配置流程

```
添加模型 → API Format → Base URL（下拉预设或手填，可开 Full URL）
        → Model ID（手填或拉取列表）→ Display Name（可选）
        → API Key（新增必填）→ 高级设置（可留空）→ 测试连接 / 保存
```

- **模型列表（Model List）**：只展示用户添加的模型；列表为空时提示先添加模型。
- **激活**：第一个添加的模型自动成为当前模型；列表内「使用」可切换，删除当前模型会自动回退到剩余模型。
- **动态模型列表**：OpenAI 协议调用 `GET <BaseURL>/models`，Anthropic 调用 `GET <BaseURL>/v1/models`；Full URL 模式下无法推导列表路径，只能手填 Model ID。
- **密钥隔离**：每个模型条目一个 API Key；列表接口只返回 `configured` 布尔值，不回传内容。
- **持久化**：模型列表 `agent.models.v2`、当前模型 `agent.active_model.v2`、参数 `agent.params.v2`；
  旧版 `agent.provider*` 配置与对应密钥在首次读取时清理一次（迁移标记为空的 `agent.models.v2`）。
- **运行时**：`agent_stream` 只接受模型条目 id；URL、Model ID 与 Key 均由 Rust 侧读取，前端不可指定。

### 1.1 高级设置（默认折叠，全部可留空）

| 参数 | 作用 | 行为 |
|---|---|---|
| `temperature` / `top_p` / `top_k` | 采样随机性 | 仅当用户填写时写入请求体 |
| `max_tokens` | 输出上限 | 用户填写的输出上下文上限优先；留空不写 |
| `stop` | 停止序列 | 留空不写；OpenAI → `stop`，Anthropic → `stop_sequences` |
| `frequency_penalty` / `presence_penalty` / `seed` / `logit_bias` | 厂商扩展采样参数 | 留空不写；不支持的协议自动忽略 |
| `extra` | 请求体透传（JSON 对象） | 原样并入顶层，≤16KB，禁止覆盖 `model/messages/tools/stream` 等保留键 |
| 输入 / 输出上下文 | 客户端能力提示 | 不发送给厂商；供 pi 模型描述与输出上限使用 |
| 工具调用轮次 | Agent 单轮工具往返上限 | **本地限制，绝不发送给厂商**；默认 500，可在 1–500 调整 |
| 图片输入支持 | 模型能力声明 | 不发送给厂商，只影响 pi 模型描述 |
| 思考模式 | 推理开关 | 存储为 `default` / `on` / `off`，不注入厂商默认值 |

约束：任何未编辑的字段都以 `Option::None` 落库，序列化时直接省略；`cargo test` 中的
`unset_params_are_never_written_into_the_body` 专门守护「不得携带默认值」。
Anthropic 的 `max_tokens` 是协议必填字段：用户留空时由协议兜底 4096，这是协议要求，
不是模型默认值，也不影响其他协议「留空不写入请求体」的规则。

### 1.2 协议字段映射

| 参数 | OpenAI Chat | OpenAI Responses | Anthropic Messages |
|---|---|---|---|
| temperature / top_p | ✅ | ✅ | ✅ |
| top_k | — | — | ✅ |
| max_tokens | ✅ `max_tokens` | ✅ `max_output_tokens` | ✅ `max_tokens`（必填，默认兜底 4096） |
| stop | ✅ | — | ✅ `stop_sequences` |
| frequency/presence penalty / seed / logit_bias | ✅ | — | — |
| 工具调用 | `tool_calls` | `function_call` items | `tool_use` blocks |
| 流式事件 | `chat.completion.chunk` | `response.*` 事件 | `message_start` / `content_block_delta` |

---

## 2. 安全约束

| 约束 | 实现 |
|---|---|
| WebView 不能指定 URL | `agent_stream` 请求体不含 baseUrl；`model.baseUrl` 一律忽略 |
| HTTPS only | Base URL 必须是 `https://` |
| 无凭据/查询串/片段 | 拒绝 `user:pass@`、`?`、`#` |
| 防 SSRF | 拒绝 localhost、单标签域名、私网/回环/链路本地/保留 IP |
| 模型一致性 | `model.provider` 必须是已存条目 id，`model.id` 必须与条目 Model ID 一致，`model.api` 必须与协议一致 |
| 透传保护 | 保留键拒绝覆盖；JSON ≤16KB |
| 禁重定向 | `reqwest::redirect::Policy::none()`，连接 10s / 读 120s（可按模型 `timeoutSeconds` 收紧） |
| 密钥不外泄 | Key 只存 Keystore（Android）或 0600 文件（桌面），不进 DB / JS / 日志；设置接口只返回布尔 |

残留风险：未做 DNS 重绑定固定；用户仍可把 Base URL 指向任意**公网** HTTPS 服务（自定义端点的产品代价）。

---

## 3. Base URL 预设

预设只是「添加模型」下拉里的地址建议，不会创建模型条目，也不会写入任何模型参数。

| 预设 | Base URL | 协议 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | OpenAI Chat |
| 火山引擎（豆包） | `https://ark.cn-beijing.volces.com/api/v3` | OpenAI Chat |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI Chat |
| 小米 MiMo | `https://api.xiaomimimo.com/v1` | OpenAI Chat |
| OpenRouter | `https://openrouter.ai/api/v1` | OpenAI Chat |
| 硅基流动 | `https://api.siliconflow.cn/v1` | OpenAI Chat |
| OpenAI（Chat Completions） | `https://api.openai.com/v1` | OpenAI Chat |
| OpenAI（Responses） | `https://api.openai.com/v1` | OpenAI Responses |
| Anthropic | `https://api.anthropic.com` | Anthropic Messages |

模型 ID 因账号、区域、接入点而异，必须动态拉取或手动填写。

---

## 4. 模型条目字段

| 字段 | 说明 |
|---|---|
| Display Name | 选填，≤64 字符；留空时列表显示 Model ID |
| API Format | OpenAI Chat / OpenAI Responses / Anthropic Messages |
| Base URL | 公网 `https://`；关闭 Full URL 时按协议自动拼接路径（Anthropic 填域名，系统拼接 `/v1/messages`；旧数据带 `/v1` 会自动归一化） |
| Full URL | 开启后直接使用填写的完整地址（需包含 `/v1/chat/completions`、`/v1/responses` 或 `/v1/messages`），不再拼接路径；此时不能自动拉取模型 |
| Model ID | 必填，≤100 字符，必须与服务端注册的标识一致 |
| API Key | 新增必填；编辑时留空表示保留原 Key |
| id | 自动生成 `custom_n`，仅小写字母/数字/下划线/短横线 |

列表展示名称、Model ID、协议、地址与 Key 状态，支持「使用 / 测试 / 编辑 / 删除」。

---

## 5. 验证用例

### 5.1 自动化

`src-tauri/src/tests.rs` 当前包含 25 个 `#[test]`，模型管理相关用例：

| 用例 | 覆盖点 |
|---|---|
| `model_registry_starts_empty_and_persists_crud` | 无预置模型、首条自动激活、编辑/切换/删除回退 |
| `model_registry_validates_base_url_and_labels` | 8 类非法 URL、空 Model ID、显示名称回退与长度 |
| `model_endpoints_cover_three_formats` | 三种协议路径拼接与 Full URL 不拼接 |
| `anthropic_base_url_normalizes_legacy_v1_suffix` | 旧 Anthropic Base URL 带 `/v1` 时归一化，Full URL 保持原样 |
| `legacy_provider_settings_are_cleaned_once` | 旧配置与旧密钥清理、v2 密钥不被误删 |
| `proxy_request_rejects_untrusted_inputs` | 条目冒名、Model ID 不一致、协议不一致、>5 工具、白名单外工具、超长 prompt |
| `llm_params_roundtrip_and_validation` | 三层参数持久化、范围校验、清除、保留键拒绝 |
| `llm_params_map_to_each_protocol` | 三种协议字段映射与 extra 合并 |
| `unset_params_are_never_written_into_the_body` | 未编辑的高级参数不得写入请求体 |
| `model_list_parsers_handle_known_shapes` | `/models` 响应解析、去重排序、空响应报错 |
| `params_output_capability_maps_to_max_tokens` | 输出上下文上限映射为输出预算 |
| `secret_store_roundtrip_survives_reload_and_delete` | 密钥跨进程重载、删除 |

前端门禁（本轮已复跑）：`pnpm lint` 0 警告 0 错误；`pnpm test` 11 文件 / 122 用例；`pnpm build`（含 `tsc -b`）成功。
Rust 门禁（`cargo fmt/clippy/check/test`）需在具备 Tauri 桌面依赖（webkit2gtk/GTK）或 Windows 的机器上复跑。

### 5.2 手工验证

1. 「添加模型」→ 选预设 Base URL 或手填 → 手填/拉取 Model ID → 填 Key → 保存；
2. 列表出现条目并可「使用 / 测试 / 编辑 / 删除」；空列表时显示添加提示；
3. 错误 Key / Model ID 时「测试连接」返回厂商 HTTP 报错；
4. 高级设置全部留空保存，抓包确认请求体不含 temperature/top_p/top_k/max_tokens/stop；
5. 只填 temperature 保存，确认仅该字段进入请求体；
6. 工具调用轮次改为 50，确认只影响本地工具循环，请求体无变化；
7. Full URL 开启后确认不再拼接路径，且「获取模型列表」提示改用手填；
8. 删除当前模型后确认自动切换到剩余模型，聊天页仍可发送；
9. 关闭流式（`stream=false`）确认非流式回复仍完整显示。

---

## 6. 已知限制

1. Base URL 只允许 HTTPS；本地 Ollama / 局域网地址与 SSRF 硬约束冲突，暂不支持。
2. 未做 DNS 重绑定防护；可在保存时解析并固定 IP。
3. Full URL 模式无法自动发现模型，必须手填 Model ID。
4. Anthropic 未设置输出上限时使用协议兜底 `max_tokens=4096`。
5. 模型列表分页差异可能导致拉取不完整，失败时可用手填 Model ID 兜底。
