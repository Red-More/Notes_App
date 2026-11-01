# 模型管理模块（Model Management）

## 一、模块定位

用于管理当前平台可调用的全部模型。

- **系统不提供任何预置模型**：所有模型都由用户自行添加，随平台版本更新不会新增可调用模型。
- **预设仅作为地址建议**：添加模型时可选 DeepSeek、OpenRouter 等 Base URL，但它只帮你填地址，不会创建条目，也不会写入任何模型参数。
- **协议固定为三种**：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages。
- **配置本机保存**：模型条目与参数存本地数据库，API Key 只进系统密钥库；对话运行时由 Rust 侧读取，前端不接触 Key。

> 早期方案中的「内置模型 / 按厂商添加 / Model Series / Gemini 适配」已取消，模块统一为用户自建模型 + Base URL 预设。

---

## 二、模型列表

列表只展示用户添加的模型，不区分内置/自定义。

| 行为 | 规则 |
|---|---|
| **首个模型** | 添加成功后自动设为当前模型，对话页立即可用 |
| **切换** | 列表内点「使用」切换当前模型 |
| **删除当前模型** | 自动回退到剩余模型中的第一条；全部删完则回到空状态 |
| **空列表** | 显示添加提示；对话输入框禁用并提示「请先添加模型」 |
| **删除** | 条目、API Key、该模型的参数一并清除 |

每条记录展示：显示名称、Model ID、协议、请求地址（Base URL / 完整地址）、API Key 状态。
操作：使用 / 测试 / 编辑 / 删除。

---

## 三、添加模型流程

```
添加模型 → API Format
        → Custom Request URL（下拉预设或手填，可开 Full URL）
        → Model ID（手填或拉取列表）
        → Display Name（选填）
        → API Key（新增必填）
        → 高级设置（可留空）
        → 测试连接（可选）→ 保存
```

### 3.1 基础配置

| 字段 | 说明 | 约束 |
|---|---|---|
| **API Format** | 接口协议 | 见 3.3，默认 OpenAI Chat Completions |
| **Custom Request URL** | 请求地址 | 必填；仅 `https://`；长度 ≤200；末尾斜杠会被去掉。Anthropic 填到域名即可（`https://api.anthropic.com`），版本前缀由系统拼接 |
| **Full URL** | 是否使用完整地址 | 关闭（默认）：按协议自动拼接路径；开启：原样使用填写的完整地址（需自带 `/v1/...`），不再拼接 |
| **Model ID** | 服务端识别的模型标识 | 必填；≤100 字符；必须与服务端注册的一致 |
| **Display Name** | 列表中显示的名称 | 选填；≤64 字符；留空则显示 Model ID |
| **API Key** | 鉴权密钥 | 新增必填；编辑时留空表示保留原 Key |

保存时后端还会校验 URL：拒绝 `user:pass@`、查询串、片段、`..` 路径，以及 localhost、单标签域名、私网 / 回环 / 链路本地 / 保留 IP（防 SSRF）。聊天请求也强制 HTTPS。

### 3.2 Base URL 预设

预设只是「添加模型」表单里的地址建议，可随时手动覆盖。

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

模型 ID 因账号、区域、接入点而异，预设不提供模型 ID，必须拉取或手填。

### 3.3 三种协议与端点拼接

| API Format | Full URL 关闭时拼接 | 模型列表路径 | 鉴权头 | 流式事件 |
|---|---|---|---|---|
| OpenAI Chat Completions | `<baseUrl>/chat/completions` | `<baseUrl>/models` | `Authorization: Bearer <key>` | `chat.completion.chunk` |
| OpenAI Responses | `<baseUrl>/responses` | `<baseUrl>/models` | `Authorization: Bearer <key>` | `response.*` 事件 |
| Anthropic Messages | `<baseUrl>/v1/messages` | `<baseUrl>/v1/models` | `x-api-key` + `anthropic-version: 2023-06-01` | `message_start` / `content_block_delta` |

Full URL 开启时直接 POST 用户填写的完整地址，路径必须由用户自己写全：

| API Format | Full URL 应填写的完整地址示例 |
|---|---|
| OpenAI Chat Completions | `https://api.openai.com/v1/chat/completions` |
| OpenAI Responses | `https://api.openai.com/v1/responses` |
| Anthropic Messages | `https://api.anthropic.com/v1/messages` |

旧版本保存的 Anthropic Base URL 若带 `/v1`（如 `https://api.anthropic.com/v1`），读取时会自动去掉该后缀，最终地址不变。

### 3.4 Model ID：手填或拉取

- **手动填写**：适合服务端只注册了少量模型、或知道确切标识的场景。
- **获取模型列表**：OpenAI 两种协议调用 `GET <baseUrl>/models`，Anthropic 调用 `GET <baseUrl>/v1/models`；解析 `data[].id`，去重排序后展示，最多 500 条；自动带入第一个模型 ID。
- **拉取前提**：需要 API Key；编辑已有模型时可复用已保存的 Key。
- **Full URL 模式**：无法推导 `/models` 路径，只能手填 Model ID。
- **拉取失败**：不影响保存，可退回手填 Model ID。

### 3.5 连接测试

- 发送一次真实、最小的对话请求，校验地址 + Model ID + Key 是否可用。
- 极低 token 消耗：OpenAI Chat 与 Anthropic 使用 `max_tokens=1`，Responses 使用 `max_output_tokens=16`（协议最小值）。
- 超时 20 秒；成功后返回 HTTP 状态与耗时（延迟）。
- 测试**不是保存的前置条件**，保存前可先测，保存后也可在列表中随时「测试」。
- 失败时按厂商 HTTP 报错定位：Key 无效、额度不足、Model ID 不存在或网络不可达。

---

## 四、高级设置

默认折叠，全部可留空；未填写的字段**不会写入请求体**，由服务端决定默认值。
唯一例外：Anthropic 协议的 `max_tokens` 是必填字段，输出留空时由协议兜底 4096，这不是模型默认值。

| 配置组 | 字段 | 范围 / 行为 |
|---|---|---|
| **上下文窗口** | 输入 | 256–1,000,000；仅作客户端能力提示，不发送给厂商 |
| | 输出 | 1–32,768；同时作为输出预算（映射为 `max_tokens` / `max_output_tokens`；Anthropic 留空时按协议兜底 4096） |
| **工具调用轮次** | 最大轮次 | 1–500，默认 500；**本地 Agent 循环限制，绝不发送给厂商** |
| **图片输入** | 支持 / 不支持 | 能力声明，不发送给厂商，只影响模型描述 |
| **思考模式** | 跟随模型默认 / 开启 / 关闭 | 仅存储偏好，不向厂商注入默认值 |
| **超参数** | Temperature | 0–2，留空不写 |
| | Top P | 0–1，留空不写 |
| | Top K | 1–1000，留空不写；仅 Anthropic 支持，OpenAI 协议自动忽略 |
| **请求透传** | `extra` JSON 对象 | 原样并入请求体顶层；≤16KB、≤64 键；禁止覆盖 `model / messages / input / instructions / tools / tool_choice / stream / stream_options / max_output_tokens` |

后端还支持 `stop`（≤4 项）、`frequency_penalty` / `presence_penalty`（−2–2）、`seed`、`logit_bias`（≤50 键）、`timeoutSeconds`（≤600）等参数，当前设置界面只暴露上述常用项。

协议字段映射：

| 参数 | OpenAI Chat | OpenAI Responses | Anthropic Messages |
|---|---|---|---|
| temperature / top_p | ✅ | ✅ | ✅ |
| top_k | — | — | ✅ |
| 输出上限 | `max_tokens` | `max_output_tokens` | `max_tokens`（协议必填；留空兜底 4096，非模型默认值） |
| stop | `stop` | — | `stop_sequences` |
| penalty / seed / logit_bias | ✅ | — | — |
| 工具调用 | `tool_calls` | `function_call` items | `tool_use` blocks |

---

## 五、安全与存储

| 约束 | 实现 |
|---|---|
| 前端不能指定 URL | `agent_stream` 只接收模型条目 id；URL、Model ID、Key 均由 Rust 侧读取 |
| HTTPS only | Base URL 必须是 `https://` |
| 防 SSRF | 拒绝内网 / 回环 / 链路本地 / 保留地址、localhost 与单标签域名 |
| 禁重定向 | `redirect::Policy::none()`；连接 10s / 读 120s，可按模型超时收紧 |
| 密钥隔离 | Key 存系统密钥库（Android Keystore）或桌面 0600 私有文件；不进数据库、不进 WebView、不写日志 |
| 列表接口 | 只返回 `configured` 布尔值，不回传 Key 内容 |
| 透传保护 | 保留键拒绝覆盖；JSON ≤16KB |
| 数据分级出境闸门 | `agent_stream` 发送前在 Rust 侧判定数据等级：S0 一律拒绝，S1 未脱敏拒绝，S2 放行；前端与模型均无法绕过 |
| 出境审计 | `egress_audit` 只记录目标、实体类型计数、字节数与决策，不记录任何原文 |

分级规则、实体库与出境判定见 [LifeOS_本地模型与数据分级方案_v1.0.0.md](./LifeOS_%E6%9C%AC%E5%9C%B0%E6%A8%A1%E5%9E%8B%E4%B8%8E%E6%95%B0%E6%8D%AE%E5%88%86%E7%BA%A7%E6%96%B9%E6%A1%88_v1.0.0.md)（LIF-2026-DES-002）。

> 当前只有 HTTPS 公网条目。本地 llama.cpp 档（阶段 B）与局域网私有档（阶段 E）尚未实现，模型条目字段暂不包含 `network_scope` / `prompt_profile`。

持久化键：

| 数据 | `settings` 键 |
|---|---|
| 模型列表 | `agent.models.v2` |
| 当前模型 | `agent.active_model.v2` |
| 模型参数 | `agent.params.v2` |

旧版 `agent.provider*` 配置及其密钥在首次读取时清理一次，以空的 `agent.models.v2` 作为迁移标记。

---

## 六、配置示例

**示例 A：DeepSeek（OpenAI Chat）**

| 字段 | 填写值 |
|---|---|
| API Format | OpenAI Chat Completions |
| Custom Request URL | `https://api.deepseek.com/v1`（选 DeepSeek 预设） |
| Full URL | 关闭 |
| Model ID | 点「获取模型列表」后选择，或按官方文档手填 |
| Display Name | 例如「DeepSeek 主力」 |
| API Key | 从 DeepSeek 控制台获取 |
| 高级设置 | 全部留空 |

**示例 B：私有网关（Full URL）**

| 字段 | 填写值 |
|---|---|
| API Format | OpenAI Chat Completions |
| Custom Request URL | `https://gateway.example.com/v1/chat/completions` |
| Full URL | 开启 |
| Model ID | 网关注册的模型名 |
| API Key | 按网关要求填写 |
| 高级设置 | 按需填写 |

**示例 C：Anthropic Messages**

| 字段 | 填写值 |
|---|---|
| API Format | Anthropic Messages |
| Custom Request URL | `https://api.anthropic.com`（选 Anthropic 预设，系统拼接 `/v1/messages`） |
| Model ID | 官方模型标识，或从「获取模型列表」选择 |
| API Key | Anthropic API Key |
| 输出上下文 | 建议填写；留空时协议兜底 `max_tokens=4096` |

---

## 七、操作要点

1. **先加模型再对话**：列表为空时无法发起对话。
2. **优先选预设地址**：省去手填 Base URL，模型 ID 仍需拉取或手填。
3. **拉取失败就手填**：Model ID 以服务端注册的标识为准，不要凭厂商宣传名猜测。
4. **高级设置尽量留空**：留空即由厂商取默认值，乱填容易报错或增加费用。
5. **保存前先测试**：一次最小请求即可确认 Key、地址、模型 ID 三者是否匹配。
6. **编辑无需重填 Key**：Key 输入框留空即保留原值。

---

## 八、已知限制

1. Base URL 只允许 HTTPS，本地 Ollama / 局域网地址与 SSRF 约束冲突，暂不支持；相关信任档见 LIF-2026-DES-002 §7，计划在阶段 E 实现。
2. 未做 DNS 重绑定防护，保存时可将域名解析并固定 IP 以进一步收紧。
3. Full URL 模式无法自动发现模型，必须手填 Model ID。
4. Anthropic 未设置输出上限时使用协议兜底 `max_tokens=4096`。
5. 厂商模型列表分页差异可能导致拉取不完整，失败时可用手填 Model ID 兜底。
6. 数据分级默认拦截：`/life/contacts`、`/life/diary` 为 S0，`/life/notes`、`/life/todos`、`/life/schedule` 为 S1，未标记路径按 S1。阶段 A 尚未提供脱敏外发，因此这些路径的云端对话会被拒绝，需在设置页把已确认非敏感的路径改为 S2。
