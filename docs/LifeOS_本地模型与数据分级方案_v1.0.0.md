# LifeOS 本地模型与数据分级方案（v1.2.0）

| 项目 | 内容 |
|---|---|
| 文档编号 | LIF-2026-DES-002 |
| 版本 | v1.2.0 |
| 编制日期 | 2026-11-01 |
| 依据文档 | [Model Management.md](./Model%20Management.md)、[LifeOS_厂商适配说明.md](./LifeOS_%E5%8E%82%E5%95%86%E9%80%82%E9%85%8D%E8%AF%B4%E6%98%8E.md) |
| 代码基线 | `2188771` feat(privacy): enforce data tiers at the cloud egress gate<br>`src-tauri/src/agent/{model_store,llm,discovery}.rs`、`src-tauri/src/vfs/`、`src-tauri/src/privacy/`、`src-tauri/src/agent/local/`、`src/agent/{runtime,prompt,context,tools}.ts` |
| 目标平台 | Android arm64-v8a 优先；桌面随后复用同一 Rust 接口 |
| 交付范围 | v1.0.0 为设计与实施计划；v1.1.0 完成阶段 A（安全核心）；v1.2.0 完成阶段 B（本地运行时），C–F 待实施 |

### 修订历史

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v1.2.0 | 2026-11-01 | 阶段 B 落地：`local-llm` feature、llama.cpp 引擎、生命周期状态机、`LocalLlama` 模型条目、本地命令与设置页、sysfs 热/电量门控；新增第 14 节实施记录 |
| v1.1.0 | 2026-11-01 | 阶段 A 落地：schema v11、L0/L1/L2 检测、有效级别、`egress::guard` 接入 `agent_stream`、隐私命令与设置页；新增第 13 节实施记录 |
| v1.0.0 | 2026-11-01 | 初版：内嵌 llama.cpp 常驻、三级数据分级、Presidio/EDM 式脱敏、ModelScope 模型分发、局域网信任档 |

---

## 0. 一页结论

**要解决的问题**：当前架构把"用户自建 Base URL + Rust 发请求"锁死在 HTTPS 公网，模型能力全部依赖云端；敏感笔记只能整篇外发，隐私承诺无法兑现。

**方案由三条独立链路组成，不使用"让模型自己判断"的软约束**：

| 链路 | 数据级别 | 执行者 | 云端可见性 | 工具集 |
|---|---|---|---|---|
| L0 本地链路 | S0 敏感 | 内嵌 llama.cpp 小模型 | **零出境** | `fs_*` + `load_skill` |
| L1 脱敏链路 | S1 一般敏感 | 本地模型编排 → Rust 脱敏 → 云端强模型 | 只见占位符 | 上述 + `cloud_consult` |
| L2 云端链路 | S2 非敏感 | 现有 `agent_stream` 直连厂商 | 原文 | 现有工具集 |

**四个不可让步的硬约束**：

1. **出境判定在 Rust 的 `agent_stream` 出口**，不依赖前端、不依赖模型自觉；检测未通过直接拒绝发送（fail-closed）。
2. **分级用"分层检测"而非 LLM 判级**：规则 + 校验位 + EDM 实体库 + 轻量 NER 编码模型；生成式小模型不参与判级，避免每条内容都推理。
3. **占位符由代码生成与回填**，小模型最多做语义泛化，且其改写结果必须通过"无新增原文片段"校验。
4. **模型文件只从受信仓库白名单下载**，`sha256` 与体积双重校验，中途失败不落地。

**关键实测数据（2026-11-01 通过 ModelScope 接口核验）**：

| 项 | 值 | 来源 |
|---|---|---|
| 文件列表 | `GET https://modelscope.cn/api/v1/models/{org}/{repo}/repo/files?Revision=master&Recursive=true`，返回 `Data.Files[]` 含 `Path/Size/Sha256` | 实测 |
| 直链下载 | `https://modelscope.cn/models/{org}/{repo}/resolve/master/{Path}`，公开模型无需鉴权 | 实测 |
| Qwen3-0.6B Q8_0 | 639,446,688 B（约 610 MiB） | `Qwen/Qwen3-0.6B-GGUF` |
| Qwen3-0.6B IQ4_XS | 367,804,096 B（约 351 MiB） | `unsloth/Qwen3-0.6B-GGUF` |
| Qwen3-0.6B IQ4_NL | 381,566,656 B（约 364 MiB） | 同上 |
| Qwen3-0.6B Q2_K | 296,238,784 B（约 283 MiB） | 同上 |
| 结构 | 28 层、16 Q / 8 KV、原生上下文 32,768、Apache-2.0 | 模型卡 |

**结论**：Android 首版可行，但必须接受三条平台事实——内嵌推理是 CPU 密集、真后台常驻必须前台服务、0.6B 不具备通用 Agent 能力。方案不回避这三点，而是把它们转成产品边界。

**阶段 A 已落地（v1.1.0）**：分级、识别器、实体库与出境闸门先于本地运行时上线，用“拒绝发送”优先兑现隐私承诺；在 B/C 完成前，S0 与未脱敏的 S1 请求一律被拒，只有 S2 允许出境。实现细节见第 13 节。

**阶段 B 已落地（v1.2.0）**：本地运行时以 `local-llm` feature 隔离，默认构建不引入 C/C++ 工具链；本地条目走 `ApiFormat::LocalLlama`，在 `llm::run` 内分流到 llama.cpp，不经过任何 HTTP 代码路径，因此天然零出境。生命周期、导入与设置页已接通，实现细节与构建前置见第 14 节。

---

## 1. 已确认的决策（本轮评审）

| 议题 | 决策 | 被否决的选项与理由 |
|---|---|---|
| 分级判定 | 规则默认 + 专业模型 + 用户可覆盖 | 纯 LLM 判级：每条内容都要推理，耗电与延迟不可接受；纯规则：语义型敏感无法覆盖 |
| 脱敏与回填 | 规则脱敏 + 小模型泛化 + 代码回填 | 纯小模型改写：不可审计，幻觉会漏改或编造 |
| 首版平台 | Android 优先 | 桌面优先：移动端隐私价值最高，先啃最难的平台避免后期返工 |
| 常驻策略 | 前台常驻 + 后台卸载，可选开启常驻 | 始终前台服务：常驻通知与待机耗电不可接受 |
| 云端调用确认 | 自动发起 + 首次会话确认 | 每次确认：多轮审查被打断；完全自动：用户失去出境控制权 |
| 局域网 | RFC1918 字面 IP + 强制 API Key + 首次配对 | 强制 HTTPS：家庭场景门槛过高；任意内网地址：等于把内网探测交给 WebView |

---

## 2. 数据分级模型

### 2.1 三级 + 有效级别

| 级别 | 定义 | 允许的去向 | 默认示例 |
|---|---|---|---|
| **S0 敏感** | 命中高置信度实体：证件号、银行卡、密钥、就医记录、家庭住址、私人联系人 | 仅本机内嵌模型 | `/life/contacts`、`/life/diary` 默认 S0 |
| **S1 一般敏感** | 含准标识符或可再识别组合：人名、公司、日程、行程、金额 | 脱敏后可出境 | `/life/notes` 默认 S1 |
| **S2 非敏感** | 公开知识、通用写作、无实体文本 | 可直接出境 | 用户显式标为公开的文件 |

**有效级别 = max(声明级别, 检测级别)**。声明级别可由用户覆盖（目录继承、文件覆盖），但**永远不能把检测出的 S0 降级**。这是"文件夹里混入敏感内容"与"用户漏标"两类问题的统一解。

### 2.2 为什么需要"实体库"而不是逐文件规则

用户提到"文件交叉引用很难维护"。逐文件正则无法保证同一手机号在日记、待办、联系人三处被一致处理。成熟 DLP 的做法是**精确数据匹配（EDM）**：维护一张参考实体表，对规范化后的值做哈希匹配，命中即视为同一实体。

本方案据此设计：

- 实体来源：`/life/contacts` 自动抽取 + 用户手工添加 + 历史检测结果聚类。
- 规范化：全角/半角、空白、`-`/`—`/`·`、大小写、手机号 `+86` 前缀统一后再匹配。
- 存储：**数据库中只存规范化值的加盐哈希与别名**，明文加密存放在密钥库（复用现有 `SecretStore` 模式），导出与备份默认排除。
- 别名稳定：同一实体在所有文档中固定映射为 `[[PERSON_01]]`，跨文件引用天然一致。

---

## 3. 分层检测引擎（运行在 Rust，读取与出境两条路径都调用）

设计参照 Microsoft Presidio 的 Analyzer 结构与 Purview 的 EDM，不引入 Python 运行时。

| 层 | 名称 | 内容 | 成本 | 作用 |
|---|---|---|---|---|
| L0 | 声明标签 | 路径前缀继承 + 文件覆盖 + 用户白名单 | 0 | 承认用户意图，只能升级不能降级 |
| L1 | 确定性识别器 | 身份证 GB 11643 校验位、银行卡 Luhn、手机号号段、邮箱、车牌、统一社会信用代码、PEM/API Key 形态、URL 凭据 | 微秒级 | 高精度、零误报、可解释 |
| L2 | EDM 实体库 | 规范化哈希 + 别名表，覆盖全库文本 | 线性扫描，毫秒级 | 解决跨文件引用与漏标 |
| L3 | 轻量 NER | ONNX int8 token-classification，中文，≤120MB，PER/ORG/LOC + 细粒度 | 单块 20–50ms | 补足规则与实体库覆盖不到的自由文本 |
| L4 | 上下文裁决 | 关键词窗口（"身份证号""住在""就诊"）提升/降低置信度；按类型阈值；冲突消解 | 微秒级 | 压制误报，参照 Presidio `LemmaContextAwareEnhancer` |
| L5 | 策略执行 | 有效级别计算 + 出境闸门 + 审计 | — | 唯一的强制点 |

**刻意不采用生成式小模型做判级**：0.6B 每条内容推理需要数百毫秒到数秒，且判定不可复现。L3 使用编码器模型，一次前向即可输出全部分类结果，才是"专业模型"的正确形态。

### 3.1 候选 NER 模型与准入条件

不预先锁定单一模型，采用"接口固定 + 评测准入"：

| 候选类型 | 代表 | 结论 |
|---|---|---|
| 中文 NER 编码器（RoBERTa/DeBERTa 系，约 100–400MB） | UER CLUENER 系列等 | 首选，需核对许可证与中文细粒度标签 |
| 多语零样本 NER | GLiNER PII 系列（60+ 类别，提供 ONNX UINT8） | 备选，中文效果需实测 |
| Piiranha（278M，mdeberta-v3-base） | — | **排除**：仅 6 种欧洲语言，无中文；CC-BY-NC-ND 不允许商用 |
| 大参数多语 PII 分类器（559M / FP32 约 2.2GB） | — | 排除：移动端内存不可接受 |

准入硬条件：许可证为 Apache-2.0/MIT 或等价可商用；int8 ONNX 体积 ≤120MB；中文实体召回达标；可在 Android arm64 上以 `ort` + `libonnxruntime.so` 运行。

### 3.2 缓存与失效

分类结果按 `(inode, rev, content_hash)` 缓存。任何写入都会产生新 `rev`，缓存自动失效；**未分类文档默认按 S1 处理**（fail-closed），不做"默认公开"。

---

## 4. 脱敏、回填与出境闸门

### 4.1 管线

```
本地模型请求 cloud_consult(doc_ids, purpose)
  → Rust 读取 VFS 原文（模型不传正文，只传路径）
  → L1–L4 检测，生成 span 列表
  → 代码替换为稳定占位符，写入本次会话映射表（内存 + 加密落盘）
  → [可选] 本地小模型做语义泛化（如"某三甲医院"），返回 diff
  → Rust 校验 diff：不得新增原文片段、不得删除/改写占位符
  → 出境闸门：对最终 JSON 载荷再跑一次 L1+L2+L3
       命中高置信度实体 → 拒绝发送，返回结构化错误给本地模型
  → 云端强模型（审查专用 system prompt，要求返回结构化 JSON）
  → Rust 按映射表回填，写回本地；占位符版本不落库
  → 审计：时间、目标模型、实体类型计数、字节数、决策；不记录任何原文
```

### 4.2 占位符规范

- 格式 `[[TYPE_NN]]`，如 `[[PERSON_01]]`、`[[PHONE_01]]`、`[[ORG_02]]`。
- 生成时校验用户原文不含同形串，冲突则改用 `[[TYPE_NN_X]]`。
- 回填只替换白名单内的合法占位符；云端返回中出现未登记占位符时原样保留并提示"云端产生了未知占位符"。
- 映射表生命周期：单次会话，可配置为"本次任务"；任务结束即清除。

### 4.3 三条必须存在的不变量

1. 云端请求体中不得出现任何实体库明文或高置信度 span（闸门强制）。
2. S0 文档只能使用本地链路；`cloud_consult` 与 `agent_stream` 对 S0 目标一律拒绝。
3. 本地模型不能直接发起 HTTP；它只能调用 Rust 暴露的工具。

---

## 5. 本地模型运行时（Android 优先）

### 5.1 构建

- 依赖：`llama-cpp-sys-2` / `llama-cpp-2`。该系列使用 `bindgen` 生成绑定，**构建机必须安装 clang/libclang**；`llama-cpp-sys-2` 无预生成绑定特性，因此 Android 构建需要固定 CI 镜像。
- Android 交叉编译：NDK 的 `android.toolchain.cmake` + `-DANDROID_ABI=arm64-v8a` + `-DANDROID_PLATFORM=26`；`-DGGML_NATIVE=OFF` 保证可移植；CPU 后端（NEON），不启用 CUDA/Vulkan/Metal。
- ABI：仅 `arm64-v8a`，与现有 `crate-type = ["staticlib","cdylib","rlib"]` 的 Tauri Android 打包方式一致。
- 风险与缓解：`bindgen` + CMake 是最容易卡住的一环，先用 Docker 固化工具链，再接入 CI；不把构建环境依赖带进开发者的日常 `cargo check`（feature flag 隔离）。

### 5.2 线程、内存与优先级

| 项 | 策略 |
|---|---|
| 推理线程 | 独立 `std::thread`，不占用 async 运行时；`spawn_blocking` 桥接 |
| 线程数 | `min(4, 性能核数)`；4GB 机型降为 2 |
| 优先级 | `nice +10`，避免抢占 UI 线程 |
| 内存 | IQ4_XS 0.6B + 2K 上下文约 700MB–1.0GB；32K 上下文 KV 约 3.6GB，**手机端不开放** |
| 取消 | 每生成一个 token 检查取消标记，沿用现有 `cancels` 注册表 |
| 并发 | 单实例、单生成；并发生成直接排队或拒绝 |
| 上下文预算 | 为小模型提供独立紧凑 prompt（不带技能索引、1–2 个工具），`trimContext` 必须把 system + tools 计入预算；现有实现只裁消息，会溢出 |

### 5.3 生命周期状态机

```
Unloaded → Loading → Ready ⇄ Generating
    ↑          ↓         ↓
    └──── Failed ←──── Suspended（后台/热压/低电量）
```

| 事件 | 动作 |
|---|---|
| 应用进入前台 | 若已启用本地模型，异步 `Loading`（不阻塞首屏） |
| 应用进入后台 | 默认 `Suspended` 并释放 context；开启"允许后台常驻"则转前台服务 |
| 热状态 ≥ SEVERE 或电量 <15% 且未充电 | 强制 `Suspended`，UI 提示 |
| 用户手动关闭 | `Unloaded`，本次进程不再自动加载 |
| 模型切换 | 先 `Unloaded` 再加载新模型，校验 sha256 |

**平台事实**：Android 后台进程会被冻结/回收，真正的常驻只有前台服务一条路，且必须显示通知。因此默认策略是"前台常驻、后台卸载"，"允许后台常驻"是用户显式开启的可选项，不是默认行为。

### 5.4 输出契约

内嵌分支直接复用现有事件枚举 `StreamEvent`（`start/text_start/text_delta/.../done`），前端 `nativeStreamFn` 无需改动。新增 `ApiFormat::LocalLlama` 仅在 `llm::run` 内部分流，不进入 HTTP 代码路径。

---

## 6. 模型目录、设备能力与下载

### 6.1 目录来源

- **受信仓库白名单**，例如 `Qwen/Qwen3-0.6B-GGUF`、`unsloth/Qwen3-0.6B-GGUF`，外加评测通过的 NER 仓库。白名单随版本发布，前端不能传任意仓库地址。
- 只展示 `.gguf` 文件，按量化档位过滤；展示体积、许可证、量化说明。
- 实测差异：官方 `Qwen/Qwen3-0.6B-GGUF` 仅提供 Q8_0；多量化档位需走社区仓库（IQ4_XS/IQ4_NL/Q2_K 均已核验存在）。

### 6.2 下载安全

| 控制 | 实现 |
|---|---|
| 仅 HTTPS | 复用受信域名校验，固定 `modelscope.cn` |
| 完整性 | 以接口返回的 `Sha256` 为准，下载后校验，不匹配即删除 |
| 体积 | 与 `Size` 比对，偏差即失败 |
| 断点续传 | `Range` + 临时文件 + 原子重命名 |
| 空间 | 下载前检查剩余空间 ≥ 1.5 倍文件体积 |
| 进程 | 仅前台下载；退后台暂停，回前台续传 |
| 前端权限 | 只接受 `{repo, path}` 且必须在白名单与文件列表内，不接受 URL |

### 6.3 设备能力检测与推荐

| 指标 | 来源 |
|---|---|
| 总内存 / 可用内存 / low-RAM 标记 | `/proc/meminfo` + Android `isLowRamDevice` |
| CPU 核心数 | `std::thread::available_parallelism` |
| 磁盘余量 | `statvfs` |
| 热状态 | `PowerManager.getCurrentThermalStatus`（Kotlin 插件上报） |
| ABI | `Build.SUPPORTED_ABIS` |

推荐只做提示，不自动下载：

| 设备档位 | 建议 |
|---|---|
| <4GB 或 low-RAM | 不推荐生成式模型；仅保留云端 + 脱敏链路 |
| 4–6GB | 0.6B IQ4_XS / IQ4_NL，2K 上下文，2 线程 |
| 6–8GB | 0.6B Q8_0，4K 上下文，3–4 线程 |
| ≥8GB | 0.6B Q8_0 或 1.7B Q4，4K 上下文 |

**能力边界必须写进 UI**：0.6B 适合总结、改写、分类、单轮问答；不适合多轮 `fs_*` 编排与长文分析。对应的 `toolRounds` 限 1–2，或进入"轻量模式"（无工具）。

---

## 7. 局域网模型信任档

与内嵌模型无关，是独立入口，**只对 `ModelKind::Chat` 生效**。

| 约束 | 规则 |
|---|---|
| 地址 | 仅 RFC1918 字面 IPv4（`10/8`、`172.16/12`、`192.168/16`），禁止域名、`.local`、公网、`169.254/16` |
| 协议 | 允许 `http`，但仅限上述地址 |
| 鉴权 | **强制** API Key（llama-server `--api-key` → `Authorization: Bearer`），回环可豁免 |
| 首次配对 | 用户确认设备；`GET /props` 或 `/health` 识别服务指纹并记录 |
| 客户端 | 独立 client：`redirect::none()` + `.no_proxy()` + `https_only(false)`，仅该档使用 |
| 范围 | 仅 chat；MCP 与媒体维持 public-only |
| 提示 | UI 明示"局域网明文，同网段可被嗅探" |

现有 HTTPS/SSRF 规则保持不动（`model_store::validate_base_url`），新增 `network_scope = private` 的独立校验函数，读取侧按条目自身 scope 复核，避免私有条目被公网规则静默丢弃。

---

## 8. 代码落点

### 8.1 新增 Rust 模块

| 模块 | 职责 |
|---|---|
| `privacy/recognizers.rs` | L1 确定性识别器 + 校验位 |
| `privacy/entity.rs` | EDM 实体库、规范化、加盐哈希、别名分配 |
| `privacy/classify.rs` | L3 ONNX NER 适配 + L4 上下文裁决 + 缓存 |
| `privacy/policy.rs` | 有效级别、工具可用性、S0 阻断 |
| `privacy/redact.rs` | 占位符生成、diff 校验、回填 |
| `privacy/egress.rs` | 出境闸门（唯一强制点） |
| `agent/local/` | llama.cpp 绑定封装、状态机、事件映射 |
| `models/catalog.rs` | ModelScope 目录、白名单、下载、校验 |
| `models/device.rs` | 能力检测与推荐 |

### 8.2 改动既有代码

| 文件 | 改动 |
|---|---|
| `agent/mod.rs` | 增加 `client_private`；`AgentState` 增加本地运行时句柄 |
| `agent/llm.rs` | `run` 分流 `LocalLlama`；**发送前调用 `privacy::egress::guard`** |
| `agent/model_store.rs` | `ModelEntry` 增加 `network_scope`、`prompt_profile`；校验拆分 |
| `agent/discovery.rs` | 私有档使用 `client_private` + 指纹检查 |
| `commands/agent.rs` | 保存私有条目需 `ack`；无 Key 的回环条目放行 |
| `src/agent/tools.ts` | 新增 `cloud_consult`（只传 doc id 与 purpose） |
| `src/agent/context.ts` | `trimContext` 预留 system + tools 预算 |
| `src/agent/prompt.ts` | 增加小模型紧凑 prompt 版本 |
| `src/pages/settings/` | 本地模型、模型目录、下载、分级与审计页 |

### 8.3 表结构（schema v11）

```sql
-- 声明级别：最长前缀匹配，文件可覆盖目录
CREATE TABLE sensitivity_labels (
    path_prefix TEXT PRIMARY KEY,
    level       INTEGER NOT NULL CHECK (level IN (0,1,2)), -- 0=S0 1=S1 2=S2
    source      TEXT NOT NULL DEFAULT 'user',              -- user | default | rule
    updated_at  TEXT NOT NULL
);

-- 分类缓存：rev 或哈希变化即失效
CREATE TABLE doc_classification (
    inode         INTEGER PRIMARY KEY,
    rev           INTEGER NOT NULL,
    content_hash  TEXT NOT NULL,
    level         INTEGER NOT NULL,
    spans         TEXT NOT NULL,        -- JSON: type/start/end/score/source
    engine_version TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

-- EDM 实体库：只存哈希与别名，明文在密钥库
CREATE TABLE entity_vault (
    alias      TEXT PRIMARY KEY,        -- PERSON_01 / PHONE_01
    kind       TEXT NOT NULL,
    norm_hash  TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

-- 出境审计：不含任何原文
CREATE TABLE egress_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL,
    target      TEXT NOT NULL,          -- 模型条目 id
    purpose     TEXT NOT NULL,
    entity_kinds TEXT NOT NULL,         -- JSON 计数
    bytes       INTEGER NOT NULL,
    decision    TEXT NOT NULL           -- allow | redact | block
);
```

---

## 9. 分阶段实施

| 阶段 | 内容 | 前置 | 完成判据 | 状态 |
|---|---|---|---|---|
| A 安全核心（优先） | L0/L1/L2 + 有效级别 + `egress::guard` 接入现有云端链路 | 无 | 云端请求遇 S0 必被拒；S1 未脱敏必被拒；单测覆盖校验位与归一化 | ✅ 完成（`2188771`） |
| B 本地运行时 | llama.cpp 绑定、状态机、事件映射、热/电量门控 | Android 构建镜像 | 真机加载 IQ4_XS 可流式输出；后台 3 秒内释放内存 | ✅ 已实现（代码验收见 §14；真机验收归 F） |
| C 编排链路 | `cloud_consult`、脱敏、diff 校验、回填、审计 | A + B | 云端抓包只见占位符；回填后本地文本正确 | 未开始 |
| D 目录与分发 | 设备检测、ModelScope 白名单、下载/校验/切换 | B | 断点续传可用；篡改文件被拒；推荐与实际能力一致 | 未开始 |
| E 局域网档 | 私有校验、双 client、配对与指纹 | A | 公网条目行为零变化；内网条目强制 Key | 未开始 |
| F 硬化 | 长稳、热压、4GB 机型、评测集回归 | 全部 | 见第 10 节 | 未开始 |

顺序理由：A 不依赖任何模型，能立即阻断现有云端链路的泄漏；B 是技术风险最高项，需尽早暴露构建问题；C 依赖前两者；D/E 收尾。

---

## 10. 验收与门禁

### 10.1 评测集

- 200 篇中文标注文档（日记、联系人、待办、行程、笔记），覆盖五类实体。
- 门禁：手机号/身份证/邮箱/银行卡 召回 ≥0.98、精确率 ≥0.95；人名/机构/地址 召回 ≥0.85。

### 10.2 自动化

| 用例 | 断言 |
|---|---|
| 证件号/银行卡校验位 | 错位号码不命中，正确号码命中 |
| 全角/半角/空格/破折号变体 | 同一实体归一到同一别名 |
| 跨文件一致性 | 三份文档中同一手机号得到同一占位符 |
| 分类缓存失效 | 编辑后旧结果不得复用；未分类默认 S1 |
| 出境闸门 | 构造含原始手机号的载荷必须被拒 |
| 回填 | 含未知占位符时保留并告警，不误替换 |
| 私有档 | 允许 `http://192.168.1.5:8080/v1`；拒绝 `169.254.1.1`、域名、公网 IP |
| 公网回归 | `model_registry_validates_base_url_and_labels` 全绿 |

### 10.3 真机与隐私验收

- 飞行模式下本地链路可用，云端工具返回明确的"不可用"错误。
- 抓包确认：S0 请求零出境；S1 请求只含占位符；S2 请求与现状一致。
- 4GB 机型 30 分钟连续对话无 OOM，热压后自动暂停并提示。
- 后台切换：默认 3 秒内释放模型内存；开启常驻后通知存在且可手动关闭。

---

## 11. 风险与不做的事

| 风险 | 处置 |
|---|---|
| bindgen/NDK 构建卡住 | Docker 固化工具链；先用预编译产物打通，再回接源码构建 |
| 0.6B 能力不足 | 明确定位为轻量助手；限制工具轮次；不承诺 Agent 级任务 |
| NER 中文效果不达标 | 评测准入；不达标时退回 L1+L2，S1 默认更保守 |
| 脱敏过度导致云端不可用 | 展示脱敏预览；允许按类型关闭（仅限 S1，S0 不可关） |
| 映射表泄漏 | 明文仅存密钥库；数据库只存哈希；导出与备份默认排除 |
| 用户误把敏感文件标为 S2 | 检测级别只能升级不能降级，S0 永远阻断云端 |
| 前台服务被 ROM 杀进程 | 常驻为可选项；失败时降级为前台常驻并提示 |

**明确不做**：不做任意 ModelScope 仓库的即点即下；不做云端对 S0 数据的任何调用；不做后台自动推理；不做把 MCP/媒体链路开放到内网；不把 0.6B 用于多轮工具编排作为默认体验。

---

## 12. 回写状态

| 文档 | 回写内容 | 状态 |
|---|---|---|
| [Model Management.md](./Model%20Management.md) | 云端出境闸门、审计、默认分级对模型使用的影响 | ✅ 已回写 |
| [LifeOS_厂商适配说明.md](./LifeOS_%E5%8E%82%E5%95%86%E9%80%82%E9%85%8D%E8%AF%B4%E6%98%8E.md) | 安全约束、代码基线与已知限制补充分级/闸门 | ✅ 已回写（v4） |
| [LifeOS_下一步执行计划_v1.3.0.md](./LifeOS_%E4%B8%8B%E4%B8%80%E6%AD%A5%E6%89%A7%E8%A1%8C%E8%AE%A1%E5%88%92_v1.3.0.md) | 阶段 A 实施记录、M6 红线补充项与后续约束 | ✅ 已回写（§16） |
| 本方案 | 阶段状态与实施记录 | ✅ v1.2.0 |

---

## 13. 阶段 A 实施记录（2026-11-01）

> 本节是执行记录，不改变第 1–11 节的设计决策；对应提交 `2188771`。

### 13.1 交付物与代码落点

| 设计项 | 实现 | 文件 |
|---|---|---|
| L0 声明分级 | 最长前缀匹配；未标记默认 S1；内置 `contacts/diary=S0`、`notes/todos/schedule=S1`；内置规则不可删除 | `src-tauri/src/privacy/policy.rs`、`db/schema.rs`（v11） |
| L1 确定性识别器 | 身份证 GB 11643、银行卡 Luhn、手机号（全半角/分隔符/`+86`）、邮箱、车牌、USCC、PEM/API Key/URL 凭据；重叠按优先级消解 | `privacy/recognizers.rs` |
| L2 EDM 实体库 | 明文只写密钥库 `privacy.entities`；数据库存加盐 SHA-256 与别名；命中用规范化后的明文 | `privacy/entity.rs` |
| 有效级别 | 取声明与检测中更严格者（按敏感度 S0 > S1 > S2） | `privacy/policy.rs`、`privacy/egress.rs` |
| 出境闸门 | `agent_stream` 发请求前裁剪上下文 → 加载快照 → 判定 → 审计；命中 S0/S1 以 `error` 事件阻断 | `commands/agent.rs`、`privacy/egress.rs` |
| 路径范围解析 | 只取 `fs_*` 工具参数：read/edit/write 用 `path`；glob 按 `root` 归位后截到目录；grep 用 `path`（缺省 `/life`），`pattern` 不当作路径 | `privacy/egress.rs` |
| 审计 | `egress_audit` 记录时间、目标、purpose、实体类型计数、字节数、决策；不含原文 | `db/schema.rs`、`privacy/egress.rs` |
| 命令 | `privacy_labels_list / privacy_label_set / privacy_label_delete / privacy_entities_list / privacy_entity_add / privacy_entity_delete / privacy_audit_list` | `commands/privacy.rs`、`lib.rs` |
| 设置页 | 「数据分级与出境保护」：规则、实体库、最近判定 | `src/pages/settings/PrivacySection.tsx`、`SettingsPage.tsx` |
| 前端契约 | `privacyApi` 与类型 | `src/api.ts`、`src/types.ts` |

### 13.2 对外行为（阶段 A）

| 场景 | 结果 |
|---|---|
| 请求涉及 S0 路径或 S0 实体（证件号/银行卡/密钥） | 拒绝，`code=s0` |
| 请求涉及 S1 路径（含默认 `/life/notes`、`/life/todos`、`/life/schedule`） | 拒绝，`code=s1_unredacted` |
| 请求只涉及 S2 路径且无命中实体 | 放行并写审计 |
| 未标记路径 | 按 S1 处理（fail-closed） |
| 图片 base64 | 不参与文本扫描（跳过 `data` / `mimeType`） |

### 13.3 验证

| 项 | 结果 |
|---|---|
| `cargo check` | 通过，无告警 |
| `cargo test --lib` | 67 passed（新增 6 个隐私用例） |
| 隐私用例覆盖 | 证件号校验位、归一化变体、内置分级不可删、S0 路径拦截、S1 未脱敏拦截、S2 放行、实体匹配与移除、glob/grep 范围解析 |
| 前端 | `tsc -b` 通过；`vitest run` 14 文件 / 139 用例；`oxlint` 0 警告 |

### 13.4 与设计的偏差与延后项

| 项 | 现状 | 归属 |
|---|---|---|
| L3 轻量 NER | 未实现；`doc_classification` 表已建但未写入 | 后续阶段（评测准入后） |
| 脱敏、占位符、回填 | 未实现；因此 S1 只能拒绝，不能“脱敏后放行” | 阶段 C |
| 实体来源 | 仅支持设置页手工添加；`/life/contacts` 自动抽取未做 | 阶段 C |
| 本地/局域网模型档 | 未实现；当前仍只有 HTTPS 公网条目 | 阶段 B/E |
| 按类型关闭脱敏 | 未实现（S0 不可关，S1 开关属于脱敏链路） | 阶段 C |
| 审计写入失败 | 记录告警但不阻断请求（判定本身仍 fail-closed） | 可在 F 收紧为阻断 |

### 13.5 对后续阶段的约束

1. C 阶段的脱敏必须基于本节识别器输出的 span 结构扩展；替换与回填在 Rust 完成，模型不接触映射表。
2. E 阶段的私有档只对 `network_scope=private` 条目放宽地址校验，不得改动本节的出境闸门。
3. F 阶段需把第 10.2 节的隐私用例扩展为真机抓包验收（S0 零出境、S1 仅占位符、S2 与现状一致）。

---

## 14. 阶段 B 实施记录（2026-11-01）

> 本节是执行记录，不改变第 1–11 节的设计决策；阶段 B 尚未提交（代码基线待补）。

### 14.1 交付物与代码落点

| 设计项 | 实现 | 文件 |
|---|---|---|
| 构建隔离 | `local-llm` feature 引入可选依赖 `llama-cpp-2`；默认构建不触发 clang/cmake | `src-tauri/Cargo.toml` |
| 引擎封装 | GGUF 加载、聊天模板、分块解码提示词、采样链、UTF-8 增量输出、停止串 | `src-tauri/src/agent/local/engine.rs` |
| 生命周期 | `Unsupported/Unloaded/Loading/Ready/Generating/Suspended/Failed`；手动关闭、后台暂停、切换模型都先取消再释放权重 | `src-tauri/src/agent/local/mod.rs`、`runtime.rs` |
| 线程与内存 | 加载/推理在 `tauri::async_runtime::spawn_blocking`；单实例 `busy` 互斥；每次生成新建 context，空闲只驻留权重 | `runtime.rs` |
| 热/电量门控 | sysfs 读取 thermal_zone 与 battery；≥45°C 或 ≤15% 且未充电即暂停并释放 | `local/gating.rs` |
| 设备推荐 | `/proc/meminfo` + 核数分档（<4GB 不推荐、4–6GB、6–8GB、≥8GB），只提示不自动下载 | `gating.rs` |
| 模型条目 | 新增 `ApiFormat::LocalLlama`；本地条目 `base_url` 存 `.gguf` 文件名，跳过 HTTPS 校验，读取侧按格式分别校验 | `agent/model_store.rs` |
| 请求分流 | `llm::run` 在发送前分流本地；本地请求不加载 EDM 快照、不写出境审计、不经过 HTTP | `agent/llm.rs`、`commands/agent.rs` |
| 事件映射 | 复用 `StreamEvent`（`TextStart/TextDelta/TextEnd/Done`）；取消回 `aborted` | `llm.rs` |
| 配置持久化 | `settings` 键 `agent.local.v1`；文件名/线程/上下文/输出上限校验 | `runtime.rs` |
| 命令 | `local_model_status/config_set/load/unload/pause/resume/import/remove/activate` | `commands/local.rs`、`lib.rs` |
| 设置页 | 状态、设备档位、门控、文件列表、导入/删除、加载/卸载、参数、启用与后台常驻 | `src/pages/settings/LocalModelSection.tsx` |
| 生命周期钩子 | 前台恢复加载、后台默认释放（`keepAlive` 时保持） | `src/agent/localLifecycle.ts`、`App.tsx` |
| 前端契约 | `localApi` 与本地模型类型；模型列表为本地条目显示“无网络请求”并禁用测试/编辑 | `src/api.ts`、`src/types.ts`、`AgentSettingsSection.tsx` |

### 14.2 对外行为（阶段 B）

| 场景 | 结果 |
|---|---|
| 当前模型为本地条目、已加载 | `agent_stream` 直接流式返回本地输出，全程无网络请求、无出境审计 |
| 本地条目未启用 / 未加载 | 明确错误提示，不隐式回退到云端（避免 S0 意外出境） |
| 本地条目被选为当前模型但从未加载 | `agent_stream` 触发一次异步加载（受热/电量门控约束） |
| 设备 ≥45°C 或 ≤15% 且未充电 | 加载/生成前拒绝，状态转 `Suspended` 并释放权重 |
| 应用切到后台且未开启常驻 | `local_model_pause` 释放权重；开启常驻则保持 |
| 导入模型 | 仅接受 `.gguf` 文件名（ASCII、无路径分隔符）、≤3GB、同名不覆盖；先写 `.part` 再原子重命名 |
| 尝试删除使用中的模型 | 拒绝，要求先卸载 |
| 未启用 `local-llm` 的构建 | 状态 `unsupported`；本地条目仍可保存，但加载返回可行动错误 |

### 14.3 构建前置与已知风险

1. **Windows 桌面构建已验证（2026-11-01）**：VS Build Tools 18 自带 CMake 4.3.1、Ninja 1.13.2 与 MSVC 14.51；bindgen 所需的 libclang 通过 PyPI `libclang 18.1.1` 提供（`C:\Users\16412\miniconda3\Lib\site-packages\clang\native`）。已把 VS 的 CMake/Ninja 目录写入用户 `PATH`，并设置用户级 `LIBCLANG_PATH`。首次 `cargo check --features local-llm` 用时 15m40s（含 llama.cpp 全量编译），增量 10s。
2. **Android 构建仍需独立环境**：NDK 的 `android.toolchain.cmake`、`-DANDROID_ABI=arm64-v8a`、`-DANDROID_PLATFORM=26`、`-DGGML_NATIVE=OFF`，并需在固定 CI 镜像内预装 clang/cmake；桌面验证不代表 Android 可直接产出。
3. **llama-cpp-2 API 版本**：已按锁定版本 `0.1.160` 完整编译通过（`chat_template/apply_chat_template`、`LlamaVocab::tokenize/token_to_piece`、`LlamaSampler` 均匹配）；升级版本时仍需重新验证 `engine.rs`。
4. **后台常驻**：Android 真正的后台常驻仍需要前台服务与通知；本轮只实现“默认后台卸载 / 用户可选保持”，前台服务归阶段 F。
5. **小模型能力**：本地分支不注入工具声明，模型不会调用 `fs_*`；system 提示裁到 1200 字符，历史按 token 预算丢弃最旧轮次。

### 14.4 验证

| 项 | 结果 |
|---|---|
| `cargo check`（默认 feature） | 通过，无告警 |
| `cargo check --features local-llm` | 通过，无告警（首次 15m40s，增量 10s） |
| `cargo test --lib` | 73 passed（新增 6 个本地运行时用例：门控、设备分档、配置校验、文件名安全、本地条目校验、无 feature 状态） |
| `cargo test --lib --features local-llm` | 73 passed，含 llama.cpp 链接 |
| `tsc -b` | 通过 |
| `vitest run` | 14 文件 / 139 用例通过 |
| `oxlint` | 0 errors；2 个既有 `set-state-in-effect` 警告（`McpSection`、`MediaUsageSection`），与本节改动无关 |

### 14.5 与设计的偏差与延后项

| 项 | 现状 | 归属 |
|---|---|---|
| ModelScope 目录与下载 | 未实现；目前只能手动导入 GGUF，无 sha256/断点续传 | 阶段 D |
| 自动下载与“仅推荐不自动下载” | 已按设计只提示推荐，不触发下载 | D |
| Android 热/电量 | 只读 sysfs；无 `PowerManager` 前台服务上报 | F |
| 本地 prompt 档位 | 前端未新增紧凑 prompt；Rust 侧裁剪 system 与历史 | C/F |
| `cloud_consult` 脱敏链路 | 未实现；本地模型仍只处理本会话 | C |
| 预编译产物 | 未接入预编译 llama.cpp，仍走源码构建 | F（风险处置） |

### 14.6 对后续阶段的约束

1. C 阶段的 `cloud_consult` 必须复用本地 `LocalState` 与门控，不得绕过 `require_gate`。
2. D 阶段的下载必须写同一模型目录、复用 `is_valid_file_name` 与 `MAX_MODEL_BYTES`，并补 sha256 与断点续传。
3. E 阶段的局域网档不得改动 `ApiFormat::LocalLlama` 的零网络语义；本地条目永远跳过出境闸门。
4. F 阶段需补齐真机验收：IQ4_XS 流式输出、后台 3 秒内释放、4GB 机型 30 分钟无 OOM。
