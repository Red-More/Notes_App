# LifeOS MNN 推理引擎技术调研报告（v1.0.0）

| 项目 | 内容 |
|---|---|
| 文档编号 | LIF-2026-RES-004 |
| 版本 | v1.0.0 |
| 编制日期 | 2026-11-02 |
| 开发分支 | `experiment/mnn-inference-engine`（base `8405e3f` docs: update LifeOS plan document to v1.3.1，即 `c6ae2a6` 内嵌 llama.cpp 之前的最后一个提交） |
| 工作目录 | `Notes_App-mnn-engine`（独立 worktree，与主线 `refactor/database-layer-virtualfs-wal` 共享 `.git`、互不干扰） |
| 研究对象 | MNN / MNN-LLM（阿里）；对照组为 llama.cpp（本项目 `llama-cpp-2` 0.1.160） |
| 关联文档 | [LifeOS_本地模型与数据分级方案_v1.0.0.md](./LifeOS_本地模型与数据分级方案_v1.0.0.md)（LIF-2026-DES-002）、`LifeOS_本地推理生产化研究报告_v1.0.0.md`（LIF-2026-RES-003，仅存在于主线 `57dde74` 之后，本分支未包含） |
| 阶段声明 | **本阶段只做调研与文档输出，不含任何开发实现**；MNN 的编译、模型转换、基准测试均未执行 |

---

## 0. 一页结论

1. **MNN 在技术上可行，且在"Android + 单实例 + 4-bit + 小模型"这一本项目主场景上拥有可验证的速度优势证据**。第三方独立测量显示，Llama 3.2 1B（4-bit）在骁龙 8 Gen 3 机型上 CPU 解码：MNN 25.7–34.0 tok/s，llama.cpp 3.05–3.29 tok/s（约 8–10 倍差距）；MNN 团队的论文另给出 CPU prefill 最高 8.6x、decode 2.3x，GPU prefill 25.3x、decode 7.1x 的对比数据。两个来源方向一致，但**差距量级随模型与量化档位变化，不能直接外推到本项目的 0.6B**。
2. **真正的落地门槛在集成层，不在推理层**：MNN 的 LLM 能力以 C++ 接口为主，Rust 侧目前只有一个社区小型项目 `mnn-rs` 0.1.7 提供 LLM 封装（2026-03 建库、累计下载 259 次、单维护者、构建期从 GitHub Releases 拉预编译二进制）。要么接受它并自建供应链加固，要么自写一层 C ABI 薄封装。这比 llama.cpp（上游明确、版本可跟踪、但构建依赖 clang/CMake/NDK）风险更集中、更不可控。
3. **模型侧是结构性切换，不是可选优化**：GGUF 单文件 → `.mnn` 多文件目录（`llm.mnn` / `llm.mnn.weight` / `tokenizer.mtok` / `config.json` / `llm_config.json` 等）。现有"扫描 `.gguf` + 文件名白名单 + 单文件 sha256"的分发与校验链路必须重做为 bundle manifest。收益是 ModelScope `MNN` 官方组织已提供 4-bit 预转换模型，与现有 ModelScope 白名单策略天然兼容。
4. **长期稳定性方面 MNN 的已知短板更"硬"**：多实例吞吐下降最多 55%（同研究下 llama.cpp 为 17%）、OpenCL 后端单会话 RSS 从 0.85GB 涨到 1.96GB、导出模型与引擎版本经 C4 图融合强耦合、部分后端算子覆盖不全（linear attention 在 image 模式 OpenCL/Vulkan 直接回落 CPU）。这些在本项目"单实例、前台常驻"的产品边界内影响有限，但会封死未来"后台常驻 + 并行任务"的想象空间。
5. **数据安全维度两家基本持平**：都是进程内本地推理、无网络出口、同样没有崩溃隔离。差异只在供应链：MNN 依赖预编译二进制与多文件模型（无标准签名），llama.cpp 是源码编译 + GGUF 单文件 sha256。无论选谁，完整性校验、工具链固化、审计都必须由本项目自己实现。
6. **建议（供产品决策，不构成本分支的开发指令）**：主线继续以 llama.cpp 为准；MNN 作为"性能备选"进入下一阶段的受控对比验证（同模型、同设备、同构建类型、同量化档位）。切换与否的**前置条件是三组本项目自测数据**：解码 tok/s、首 token 延迟（TTFT）、30 分钟峰值 RSS。本阶段不做任何代码迁移。

---

## 1. 分支背景、建设目标与核心定位

### 1.1 为什么需要这条分支

| 事实 | 来源 | 对本分支的意义 |
|---|---|---|
| llama.cpp 路线已落地阶段 B，并在真机跑通中文流式输出 | 主线提交 `c6ae2a6`、`57dde74` | 主线已有可用基线，对照实验有"参照物" |
| 本项目实测解码约 5 tok/s、冷启动首 token 30.8s（Redmi Note 12 Turbo / Android 14 / Qwen3-0.6B IQ4_XS / 3 线程 / debug 未优化） | LIF-2026-RES-003 | 体验偏弱，存在"换引擎能否显著提速"的合理疑问 |
| 生产化研究报告把 MNN-LLM 列为"国内 Android 商业化备选"，仅一段文字、无展开评估 | LIF-2026-RES-003 §6 | 该结论缺少量化证据，无法支撑决策，需要升级为可评审的对照研究 |
| 主线仍存 Android 侧硬缺口：16 KB 页、进程隔离、模型分发校验、构建可重复性 | LIF-2026-RES-003 §5、§7 | 这些缺口与引擎无关，换引擎也不会自动消失；调研必须把引擎能力与项目缺口分开评估 |
| llama.cpp 的 Rust 绑定构建依赖 bindgen + CMake + NDK，桌面默认构建必须关闭 `local-llm` feature | `src-tauri/Cargo.toml`、`scripts/build-android.mjs`（主线） | 这是"换引擎可能更省事"的直接动机之一，需专门核查 |

**分支 base 选择的理由**：`8405e3f` 是 `c6ae2a6 feat(agent): embed llama.cpp local runtime` 之前的最后一个提交。此提交下不存在 `src-tauri/src/agent/local/*`、`agent/llm.rs` 的本地分流、`commands/local.rs`、`LocalModelSection.tsx` 等 llama.cpp 落地代码。基于该点开分支，可以保证：

- MNN 方案的模块边界、接口形态、模型分发方式**不被已落地的 llama.cpp 实现先验绑死**；
- 对照实验的"起点"是干净的：两份实现各自从零设计，差异来自引擎本身而非历史包袱；
- 主线工作区（含 2 个未提交改动）与实验分支完全隔离，实验失败可直接丢弃分支引用。

### 1.2 建设目标

| 编号 | 目标 | 可验证的完成判据 |
|---|---|---|
| G1 | 建立技术对照依据 | 本文档第二模块的维度表可逐项追到来源；每个数字标注口径与证据等级 |
| G2 | 识别 MNN 落地前置条件 | 构建、Rust 绑定、模型格式、许可、合规五类条件各给出"已确认/待验证"状态 |
| G3 | 输出产品决策输入 | 给出"继续使用 llama.cpp / 引入 MNN 作为备选 / 双引擎抽象"三条路径的代价与触发条件 |
| G4 | 为后续对比验证定义基准 | 第三阶段所需的设备矩阵、指标、门禁阈值为可执行清单 |

### 1.3 核心定位（本分支的边界）

> **本分支是为 MNN 推理方案开发提供技术对照依据的研究分支，不是第二条产品主线。**

具体边界：

1. **用途**：为 MNN 方案开发提供对照基线（引擎能力、集成成本、性能证据、稳定性格局），支撑后续产品决策与选型评审。
2. **产出物**：调研文档 + 后续基准数据 + 可选最小 PoC。**不产出可发布功能，不合入主线**。
3. **不预设结论**：本文给出的是"证据评级与条件判断"，不是"选型决定"。选型权归产品决策，输入必须包含本项目自测数据。
4. **不越界**：不在本分支做模型分发、UI、脱敏链路的改造；不把 MNN 代码写进主线分支。

### 1.4 分支与主线的隔离方式

| 项 | 主线工作区 | 本分支工作区 |
|---|---|---|
| 路径 | `Notes_App` | `Notes_App-mnn-engine` |
| 分支 | `refactor/database-layer-virtualfs-wal` | `experiment/mnn-inference-engine` |
| HEAD | `2edfa2b` | `8405e3f` |
| 共享资源 | `.git` 对象库 | 同左；索引、HEAD、工作区独立 |
| 清理方式 | — | `git worktree remove`（提交前先确认改动已落分支） |

---

## 2. 调研范围与方法

### 2.1 方法

- **一手来源优先**：MNN 官方文档站、GitHub 仓库、crates.io/docs.rs 元数据、论文原文（arXiv 与 ACM 页面）。二手汇总只作为线索，不作为结论依据。
- **口径并列**：任何吞吐量数字必须同时标注设备、模型、量化、线程、构建类型；口径不一致时并列展示，不取平均、不做无标注外推。
- **区分证据等级**：
  - **强**：第三方独立测量（非厂商团队）、可复现口径、公开数据；
  - **中**：厂商自报或论文自报（方法与口径公开但存在自评估偏差）；
  - **弱/待实测**：只有定性描述或与目标场景口径不匹配的间接数据。
- **"不存在"也写结论**：例如 MNN 的桌面 GPU 在 Tauri 目标平台上并非必需路径，这类"不需要"的判断同样记录，避免后续重复调研。

### 2.2 本阶段做了与没做的事

| 项 | 状态 |
|---|---|
| MNN 官方能力、平台矩阵、后端/精度矩阵核查 | ✅ 已完成（官方文档） |
| MNN-LLM 导出链路、量化参数、模型产物结构核查 | ✅ 已完成（官方文档） |
| Rust 绑定现状核查（`mnn-rs` / `mnn` / `*-sys`） | ✅ 已完成（crates.io API 与 docs.rs） |
| 第三方实测数据核查（速度、内存、多实例） | ✅ 已完成（ACM EdgeFM'25 论文） |
| 本项目 llama.cpp 基线数据核对 | ✅ 已完成（主线代码与 LIF-2026-RES-003） |
| MNN 在本机/真机的编译、模型转换、基准测试 | ❌ 未执行（属下一阶段，本阶段不做实现） |
| MNN 在 Tauri 2 工程内的集成验证 | ❌ 未执行（同上） |

### 2.3 术语

- **MNN**：阿里的通用轻量推理引擎（Apache-2.0），覆盖 CV/NLP/多模态。
- **MNN-LLM**：基于 MNN 的 LLM 运行方案（同一仓库内 `transformers/llm` 与 `apps/Android/MnnLlmChat`），下文在不引起歧义时统一用"MNN"。
- **GGUF**：llama.cpp 的模型格式与量化生态。
- **`.mnn`**：MNN 的模型格式，LLM 场景为"多文件目录"而非单文件。

---

## 3. 第一模块：MNN 推理框架技术可行性专项研究

### 3.1 能力基线（事实层）

| 维度 | MNN 基线 | 状态 |
|---|---|---|
| 定位 | 通用深度神经网络推理/训练引擎；LLM 为其上层运行方案 | 已确认 |
| 许可 | Apache-2.0（Rust 侧绑定沿用同许可） | 已确认 |
| 操作系统 | Windows / iOS 8.0+ / Android 4.3+ / Linux 及 POSIX 嵌入式 | 已确认 |
| CPU 架构 | ARMv7a / ARMv8（含 FP16、BF16、Int8；ARMv8.2/8.6 指令适配）、x86 SSE4.1 / AVX2 / AVX512 | 已确认 |
| GPU 后端 | OpenCL、Vulkan、Metal、CUDA（精度矩阵中各后端对 Int8/FP16 的支持度不同） | 已确认 |
| NPU 后端 | CoreML（A 级）、HIAI（A 级）、NNAPI（B 级）、QNN（B 级）；Android Hexagon（新增，限 4-bit 对称量化） | 已确认 |
| 库体积 | Android armv7a 主体动态库约 800KB；iOS 全功能静态库约 12MB/链接增量约 2MB，可裁剪至 6.1MB/600KB；Mini 选项再降约 25% | 已确认 |
| 模型格式与来源 | `.mnn`（LLM 为多文件目录）；转换链路 torch → onnx → mnn | 已确认 |
| 预转换模型供给 | ModelScope `modelscope.cn/organization/MNN`、Hugging Face `taobao-mnn` | 已确认 |
| LLM 覆盖 | 千问系列（Qwen2/2.5/3）、Llama3、百川、智谱；官方 App 已支持 DeepSeek-R1-0528-Qwen3、Qwen3-30B-A3B、Qwen2.5-Omni 3B/7B 等 | 已确认（仓库 News 与镜像说明） |
| 量化能力 | 权重 2/3/4/8-bit、block 64/128 等；HQQ/AWQ/Omni/GPTQ/LoRA；运行时 KV/激活量化与混合精度 | 已确认 |
| 端到端参考实现 | `apps/Android/MnnLlmChat`（官方全模态 LLM Android App） | 已确认 |

> 注：2-bit / 3-bit 权重量化要求 ARMv8.6 `i8mm` + FP16，**意味着低端与老机型不可用**；这一点直接影响"多设备兼容性"判断，不能把 MNN 的量化档位数直接等同于覆盖能力。

### 3.2 落地适配的基础条件（本项目视角）

#### 3.2.1 Android 构建与打包

| 项 | MNN 路径 | 与主线 llama.cpp 路线的差异 |
|---|---|---|
| 引擎编译 | CMake + NDK 交叉编译，必须 `-DMNN_BUILD_LLM=ON`；Android GPU 可选 `-DMNN_OPENCL=ON`；产物为 `libMNN.so`、`libllm.so` 等 | 少一层 `bindgen`（不需要 clang/libclang），但需要新的 CMake 构建编排 |
| 与 Rust/Tauri 的连接 | 通过 C++ 接口 + C 封装（社区 crate 或自写 `extern "C"` 薄层） | llama.cpp 用 `llama-cpp-2` 直接把源码编进 Rust 静态库；MNN 更可能需要"动态库 + 头文件"形态 |
| 打包进 APK | 需把 `.so` 落到 AGP 默认目录 `src/main/jniLibs/arm64-v8a/`（或改为静态链接进 Rust 库） | 主线当前是"编进 Rust staticlib"，Android 打包不需要额外 jniLibs 步骤 |
| ABI 范围 | 本项目只需 `arm64-v8a`，与 MNN 官方 demo 的多 ABI 默认不对齐 | 一致，可裁剪，不构成问题 |
| 16 KB 页合规 | 与 llama.cpp 同受 Android 平台要求约束（NDK r28+ 默认 16 KB 对齐） | **共性约束**，非引擎差异 |

#### 3.2.2 Rust 绑定现状（最高风险项）

| 候选 | 版本/时间 | LLM 能力 | 预编译 | 采用度 | 结论 |
|---|---|---|---|---|---|
| `mnn-rs` | 0.1.7 / 2026-08-17（0.1.x 起 2026-03） | ✅ 提供 `Llm::create / generate_stream / response_messages / replay KV` | ✅ 构建期下载 GitHub Releases 预编译（Android arm64-v8a、iOS、Windows、Linux、macOS；基于 MNN 3.6.1） | 累计下载 259、近期 117；单维护者（`wapznw/mnn-rs`） | **能力最贴合，但采用度极低、供应链需自建加固** |
| `mnn` | 0.3.0（另有 0.2.0） | ❌ 仅通用 `Interpreter`；Vulkan/OpenGL 明确未实现 | ❌ 需 vendor MNN 源码 + CMake | 非 LLM 场景的小众 crate | 不能直接支撑 LLM |
| `mnn-rs-sys` / `mnn-sys` | 0.1.x / 0.2.0 | 取决于上游 build 开关 | 部分 | 极低 | 只能作为底层原料，需自封装 |
| 自写 C ABI 薄封装 | — | 可控 | 可控（静态/动态自选） | — | **生产路径的现实选项**，但需评估 C++ 接口稳定性与 ABI 维护成本 |

**关键判断**：MNN 的"LLM + Rust + Android"组合目前没有"上游官方维护"的成熟路径。这与 llama.cpp 侧的处境不同：`llama-cpp-2` 同样是社区维护、无 semver 承诺，但它**持续跟随上游源码**、版本节奏公开、构建失败可从源码定位；MNN 的社区绑定还叠加了"预编译二进制下载"这一构建期供应链环节。

#### 3.2.3 模型与分发链路

| 项 | MNN 现状 | 对现有实现的影响 |
|---|---|---|
| 导出链路 | `transformers/llm/export/llmexport.py`：torch → onnx → mnn；默认 4-bit、block 64，可 `--quant_bit`/`--quant_block`/`--hqq`/`--awq`/`--omni` | 需要在桌面建立 Python 导出环境（新增构建期工具链，但只在模型生产环节，不进 App） |
| 产物结构 | 目录多文件：`llm.mnn`、`llm.mnn.weight`、`tokenizer.mtok`、`config.json`、`llm_config.json`、可选 `embeddings_bf16.bin` | 现有 `.gguf` 单文件扫描/单文件 sha256 逻辑不适用，必须引入 bundle 清单 |
| 运行时配置 | `config.json` 决定 `backend_type`、`thread_num`、`precision`、`memory`、`sampler_type`、`reuse_kv` | 与现有 `LocalConfig`（线程、上下文、输出预算）可映射，但采样器语义不同，需要适配层 |
| 引擎-模型耦合 | 导出默认开启 Transformer C4 图融合；**新模型依赖新版引擎，旧引擎无法加载**；`--disable_transformer_c4` 可回退兼容 | 引入"模型版本 ↔ 引擎版本"矩阵管理，属长期维护成本 |
| 官方预转换模型 | ModelScope MNN 组织提供 4-bit 模型，`git lfs clone` 即可用 | 与现有"仅受信仓库白名单 + sha256"策略天然兼容，但需要按目录做多文件校验与续传 |

#### 3.2.4 许可与合规

- 引擎 Apache-2.0：可闭源分发，保留版权与许可声明。
- 模型许可需逐个复核（Qwen 系列为 Apache-2.0，但量化者条款、再分发条款需读仓库 `LICENSE`，不依赖二手站点结论）。
- 16 KB 页：Play 自 2025-11-01 起要求面向 Android 15+ 的新提交与更新支持 16 KB；官方要求自 2027-02-01 起更新必须支持。NDK r28+ 默认满足。**两家引擎共用同一约束**。
- 生成式应用还受内容安全与能力披露政策约束，与引擎无关。

### 3.3 核心优势（逐条给出证据等级）

| # | 优势 | 机制 | 证据 | 等级 |
|---|---|---|---|---|
| A1 | 移动端硬件感知调度 | 启动时按核心实测算力分配负载（prime / gold / silver 异构核心），而非均分线程 | 独立测量：1B 4-bit CPU 解码 25.7–34.0 tok/s vs llama.cpp 3.05–3.29 tok/s；论文归因为 llama.cpp 缺少移动端硬件感知调度 | **强** |
| A2 | 移动端算子与数据重排 | 按指令集重排权重/输入、分块量化、混合精度、几何计算、多核负载均衡 | 论文（阿里团队）：CPU prefill 最高 8.6x、decode 2.3x；GPU prefill 最高 25.3x、decode 7.1x（Xiaomi 14，4 线程，Qwen2-1.5B/7B、Llama3-8B） | 中（自报） |
| A3 | 内存优化与更大可运行模型 | DRAM-Flash 混合存储（低利用率参数放 Flash）、KV 超阈值下沉 Flash 并预取、运行时量化 | 论文方法与实测；**本项目未验证** | 中（待实测） |
| A4 | 国内生态与分发对齐 | ModelScope 官方模型组织、国产模型优先适配、中文文档与钉钉社群 | 官方文档与仓库 | **强** |
| A5 | 体积与裁剪 | Android 核心 so 约 800KB、可裁剪、Mini 选项再降 25% | 官方文档 | **强** |
| A6 | 后端覆盖宽度（为后续 GPU/NPU 留门） | OpenCL / Vulkan / Metal / CUDA / QNN / Hexagon | 官方文档；Hexagon 仅 4-bit 对称量化 | 中 |
| A7 | 桌面构建可能更省事 | `mnn-rs` 预编译支持 Windows MSVC；无需 clang/libclang | crate README；**未在本项目验证 CRT 兼容性** | 弱（待验证） |

> 注意 A2 与 A7 的偏差：论文数字来自 **7B/8B 级模型**，"小模型优势会被压缩"是合理预期；预编译二进制在 MSVC 下的 CRT 一致性也需实测。

### 3.4 可行性结论与准入条件

**结论：MNN 方案可行（Go with conditions），但不能以"论文更快"直接进入实施。**

五个准入条件（全部满足才建议进入 PoC）：

| # | 准入条件 | 判据 | 当前状态 |
|---|---|---|---|
| C1 | 可构建 | 在既有 NDK/CMake 环境产出 `arm64-v8a` 的 `libMNN.so`，并可被 Rust 调用 | 待验证 |
| C2 | 可生成可流式 | 同一中文 prompt 能逐 token 输出，且取消标记在 1 token 内生效 | 待验证 |
| C3 | 可测量 | 复用现有"load / prefill / decode"三段计时口径，可直接与 llama.cpp 对比 | 待验证（口径已在主线建立） |
| C4 | 可校验与可回退 | 模型多文件 bundle 有逐文件 sha256；失败可回退到 GGUF 路线 | 设计可行，未实现 |
| C5 | 可合规 | 引擎与模型许可、16 KB 页、模型来源白名单均通过 | 引擎已确认，模型待逐项复核 |

**与既有设计的兼容性（正面因素）**：阶段 B 的状态机（`Unloaded / Loading / Ready / Generating / Suspended / Failed`）、热/电量门控（45°C、15% 电量）、事件契约（`StreamEvent`）、配置校验（2048–8192 上下文、≤8 线程）、`spawn_blocking` 桥接，全部位于 Rust 运行时层，**与引擎无关**。换引擎的实际改动集中在"Engine 实现 + 模型文件形态 + 分发校验"，不需要动 UI 契约与隐私闸门，这一点显著降低切换成本。

**与产品主张的冲突（必须由产品决策）**：当前"用户自选模型"以 GGUF 为默认心智模型。MNN 路线要么收窄为"官方预转换模型白名单"，要么保留"用户自行导出"的高门槛路径。这不是工程问题，是产品定位问题。

### 3.5 风险与不确定项

| 风险 | 影响 | 缓解 |
|---|---|---|
| `mnn-rs` 单维护者、下载量极低 | 关键路径依赖不可控；预编译下载失败即构建失败 | 锁版本 + vendor 预编译产物并校验哈希；同时准备自写 C ABI 备选 |
| 预编译二进制供应链 | 构建期引入外部二进制，破坏可重复构建 | 产物入库/私有镜像 + sha256 固定；CI 不使用动态下载 |
| 模型-引擎 C4 融合耦合 | 换引擎版本即换模型，回归成本高 | 版本矩阵 + `--disable_transformer_c4` 兼容导出 |
| 2/3-bit 需 ARMv8.6 | 低端机想用小体积模型时不可用 | 低端机固定 4-bit；以 Q4 为基线档 |
| 后端算子覆盖不全 | OpenCL/Vulkan 特定结构回落 CPU，性能不可预期 | 首版只做 CPU；GPU 作为可选实验项 |
| 桌面 GPU 不是必需品 | 研究投入可能浪费 | 桌面只在 CPU 路径上验证 |
| 无本项目实测数据 | 无法判断 0.6B 收益 | 下一阶段基准测试为前置门禁 |

---

## 4. 第二模块：MNN 与 llama.cpp 横向对比分析

### 4.1 对比口径与边界

- **运行环境一：Android（Tauri 2 应用内嵌）**——主场景，`arm64-v8a`，CPU 优先。
- **运行环境二：Tauri 2 桌面（Windows / macOS / Linux）**——开发与桌面端复用同一 Rust 接口。
- **公平性前提**：同模型（Qwen3-0.6B 或同规模替代）、同量化档位（4-bit 为主）、同线程数、同设备、同构建类型（release）；先冷启动 1 次再取 5 次均值。
- **本报告的局限**：本项目的 MNN 数据尚未产生，第二模块是"证据评级 + 条件判断"，不是定量结论；凡推断均显式标注"推断，待实测"。

### 4.2 已知实测数据汇总（口径并列）

| 来源 | 设备 / 系统 | 引擎与版本 | 模型与量化 | 口径 | 结果 |
|---|---|---|---|---|---|
| 本项目（LIF-2026-RES-003） | Redmi Note 12 Turbo / Android 14 | llama.cpp（`llama-cpp-2` 0.1.160），3 线程，debug 未优化 | Qwen3-0.6B IQ4_XS | 端到端 99 输出 token；冷启动 | ≈5 tok/s；首 token 30.8s；桌面首次全量编译 15m40s、Android 12m18s |
| 独立测量（ACM EdgeFM'25） | OnePlus 12 / Galaxy S24+ / Xiaomi 14（Android 14/15），SD 8 Gen 3，12GB | llama.cpp b4646；MNN 3.1.0 | Llama 3.2 1B，4-bit（另有 6/8-bit） | prompt 1024、生成 4096、单实例平均解码 | CPU：llama.cpp 3.05–3.29 tok/s；MNN 25.70–34.03 tok/s。GPU：llama.cpp OpenCL/Vulkan 10–16 tok/s（4-bit）；MNN OpenCL 29 tok/s（S24+，低于其 CPU 33.4 tok/s 约 15%） |
| 同上（多实例） | 同上 | 同上 | 同上 | 2 个实例并发 | 吞吐下降：MNN 最多 −55%，llama.cpp −17% |
| 同上（内存） | 同上 | 同上 | Llama 3.2 1B 4-bit | 单会话 RSS / GPU 显存 | llama.cpp RSS 稳定在 ≈1.56GB；MNN OpenCL 会话内 RSS 0.85GB → 1.96GB（+130%），前 1000 token 内稳定 |
| 厂商论文（MNN-LLM, MM Asia'24） | Xiaomi 14 | llama.cpp / MNN-LLM | Qwen2-1.5B / 7B、Llama3-8B，量化 | 4 线程 CPU；OpenCL GPU | CPU prefill 最高 8.6x、decode 2.3x（相对 llama.cpp）；GPU prefill 最高 25.3x、decode 7.1x |

**读法提示**：

1. 两个速度来源方向一致（MNN CPU 明显更快），但**量级差 3–4 倍**（论文 2.3x vs 独立测量 ~10x），原因可能是模型规模（1B vs 1.5–8B）、量化方式、线程策略与年份版本差异。引用时必须带口径。
2. 独立测量是**强证据**，但只覆盖 1B/3B 与 SD8Gen3 旗舰机；本项目 0.6B + 中端机属不同区间。
3. MNN 的"CPU 快于自身 OpenCL"与 llama.cpp 的"Vulkan 优于 OpenCL"说明：**移动端 GPU 路径整体不可靠**，首版不应计划 GPU。

### 4.3 分维度对比

#### 维度 1：技术实现难度

| 子项 | llama.cpp（本项目现状） | MNN（预期） | 难度判定 |
|---|---|---|---|
| Android 引擎构建 | bindgen + CMake + NDK；需 pin NDK、cmake/ninja 入 PATH、`GGML_NATIVE=OFF`；已用 `scripts/build-android.mjs` 固化 | CMake + NDK（`MNN_BUILD_LLM=ON`），无 bindgen；但需新增 CMake 编排与 `.so` 打包步骤 | llama.cpp 现已"趟通"（中）；MNN 尚未验证（中高） |
| Rust 接入 | `llama-cpp-2` 直接暴露 `LlamaModel/Context/Sampler`，API 结构清晰；版本漂移需回归 | `mnn-rs` 有 LLM API 但采用度极低；或自写 C ABI 层 | **MNN 明显更高** |
| Tauri 2 桌面构建 | Windows 需 clang/CMake，故默认构建关闭 `local-llm` | 预编译 MSVC 二进制可能免 clang；桌面 macOS 需 Metal/CPU 验证 | MNN 有潜在优势（待验证） |
| 模型准备 | 下载 GGUF 即用；量化档位现成 | 需官方预转换模型或桌面 Python 导出（新增构建期工具链） | **MNN 更高** |
| 模型分发/校验改造 | 单文件 `.gguf` + sha256 + 文件名白名单（现有逻辑） | 多文件 bundle + 逐文件哈希 + 目录级清单 | MNN 需重做（中） |
| 与既有运行时对接 | 状态机/门控/事件契约已落地 | 同层可复用，只需替换 Engine 与文件形态 | 两家相同（低） |

**小结**：llama.cpp 的难度是"一次性构建坑 + 持续版本漂移"；MNN 的难度是"接入层空白 + 模型链路重建 + 供应链治理"。前者已付出成本并固化，后者是新增成本。

#### 维度 2：端侧推理速度

| 场景 | llama.cpp | MNN | 判断 |
|---|---|---|---|
| Android CPU，1B 4-bit（独立实测） | 3.05–3.29 tok/s | 25.7–34.0 tok/s | **MNN 显著占优（强证据）** |
| Android CPU prefill | 论文对照组 | 最高 8.6x | MNN 占优（中证据） |
| Android GPU（4-bit） | 10–16 tok/s（OpenCL/Vulkan） | 29 tok/s（OpenCL，且低于自身 CPU） | 两者都不理想；**首版不启用 GPU** |
| 本项目 0.6B（推断） | 已知 ≈5 tok/s（debug） | 未测 | **待实测**；0.6B 解码为带宽受限，MNN 调度优势预计收敛（推断，不给具体倍数） |
| 冷启动首 token（TTFT） | 已知 30.8s（debug） | 未测 | 待实测；与模型加载方式（mmap vs 全量读入）强相关 |
| 桌面 CPU | 单核/多核均远高于手机；本地小模型可接受 | 未测 | 桌面不作为选型决定项 |

**关键结论**：速度优势成立，但**其来源是"移动端调度与移动端调优"，不是"引擎通用更强"**。因此：

- 若最终目标仍是手机上的 0.6B 小模型，MNN 的收益需要实测确认，不应按 8–10x 预期投入；
- 若未来要在手机上跑 1.5B–3B，MNN 的证据强度进一步提高（独立测量覆盖 1B/3B）；
- 桌面端速度不构成差异，**不要为了桌面性能选型**。

#### 维度 3：多设备兼容性

| 子项 | llama.cpp | MNN | 判断 |
|---|---|---|---|
| Android CPU 架构 | ARM64/ARMv7 + NEON；x86 桌面为主 | ARMv7a/ARMv8（含 FP16/BF16/Int8、i8mm）；x86 SSE4.1/AVX2/AVX512 | MNN 官方矩阵更细 |
| 移动端调度 | **无硬件感知调度**（实测被点名） | 按核心算力分配负载 | **MNN 优势（强）** |
| Android GPU | OpenCL/Vulkan（4-bit 可用；6/8-bit OpenCL 明显弱） | OpenCL/Vulkan（1B 4-bit OpenCL 29 tok/s，低于 CPU） | 均为"可选且不稳定" |
| NPU | 无官方稳定 NPU 路径 | CoreML/HIAI/NNAPI/QNN/Hexagon（部分为 B 级、限 4-bit 对称） | MNN 有门，但覆盖窄、限制多 |
| 低内存/低端机 | IQ2/IQ3 等 GGUF 档位可用面广 | 2/3-bit 需 ARMv8.6，老机不可用 | **llama.cpp 在低端覆盖更好** |
| 桌面平台 | Windows/macOS/Linux（CPU/Metal/CUDA） | Windows/Linux/macOS（CPU/Metal/OpenCL/CUDA） | 两家都覆盖 |
| 系统差异敏感度 | 同 SoC 不同厂商 OS 下 GPU 差 30%+（实测） | 同上（CPU 稳定、GPU 波动大） | **两家都需真机矩阵，不能靠模拟器** |
| ABIs | 可裁到 `arm64-v8a` | 同 | 一致 |

**小结**：MNN 在"手机 CPU 的真实调度能力"上领先，在"低端机量化档位"上落后；GPU/NPU 两边都不可依赖。

#### 维度 4：数据安全性

| 子项 | llama.cpp | MNN | 判断 |
|---|---|---|---|
| 推理位置 | 进程内、本地 | 进程内、本地 | 持平 |
| 网络出口 | 无（模型由应用侧下载） | 无（模型由应用侧下载） | 持平 |
| 崩溃隔离 | 无：C++ 崩溃即杀 App | 无：同类风险 | **两家都有硬缺口** |
| 模型完整性 | GGUF 单文件 sha256（ModelScope 接口即给） | `.mnn` 多文件，无标准签名；需自建 bundle 清单 | **MNN 需更多自建** |
| 二进制供应链 | 源码编译（可审计构建产物） | 预编译 `.so` / crate 构建期下载二进制 | **MNN 风险更集中** |
| 模型来源治理 | 现有 ModelScope 白名单 | ModelScope 官方 MNN 组织；也可自建导出 | MNN 可做到同等或更严（自建导出） |
| 许可 | MIT（可闭源） | Apache-2.0（可闭源） | 持平 |
| 引擎侧遥测 | 无 | 无（需在 PoC 中抓包复核） | 持平（待复核） |

**小结**：安全性不是选型决定项——**两家都满足"零出境"要求，也都不能提供"崩溃不拖垮 App"**。差异全部落在本项目自己的分发、校验、审计三件事上，而这三件事两种引擎都需要做。

#### 维度 5：长期运行稳定性

| 子项 | llama.cpp | MNN | 判断 |
|---|---|---|---|
| 移动端生产验证 | 生态广（Ollama/Jan/LocalAI/PocketPal/llama.rn），但"移动端 CPU 调度"是短板 | 阿里 30+ App 大规模 CV 推理验证（Walle/OSDI'22）；LLM 运行时较新 | MNN 生产背书强，但**背书对象主要是 CV 而非 LLM** |
| 单实例长稳 | 本项目 30 分钟目标尚未验收；RSS 在 1B 规模表现稳定（≈1.56GB） | 1B 规模 CPU RSS 未见异常增长；**OpenCL 会话内 RSS +130%** | CPU 两家可接受；GPU 不可靠 |
| 多实例/并发 | 吞吐 −17%（实测） | 吞吐 −55%（实测） | **MNN 明显更差**（若做后台常驻 + 并行，需重新评估） |
| 模型/引擎演进耦合 | 版本漂移需回归采样链与 chat template | C4 图融合导致"新模型只能新引擎"；旧引擎无法加载 | 两家都有耦合，MNN 更刚性 |
| 算子覆盖 | 后端差异存在但不影响 CPU 主路径 | image 模式 OpenCL/Vulkan 缺 linear attention（回落 CPU）；Hexagon 限 4-bit 对称 | MNN 后端不一致性更显著 |
| 依赖维护 | crate 无 semver、版本节奏快 | 社区绑定单维护者；官方 C++ 主线稳定 | **MNN 的依赖风险更集中** |
| 热/电量治理 | 已在 Rust 层实现，引擎无关 | 可复用同一门控 | 持平 |

**小结**：在"单实例、前台常驻、CPU 推理"的产品边界内，两家稳定性都可接受；MNN 的三处短板（多实例 −55%、OpenCL 内存增长、C4 耦合）会**限制未来扩展场景**，需要在产品路线图中提前标注。

### 4.4 粗粒度综合评级

评级说明：● 优 / ◐ 中 / ○ 差（相对本项目的目标场景，不是绝对能力）。

| 维度 | MNN | llama.cpp（现状） | 证据等级 | 备注 |
|---|---|---|---|---|
| 技术实现难度（Android） | ◐ | ◐（已趟通） | 强 | MNN 新增接入层与模型链路；llama.cpp 已付出成本 |
| 技术实现难度（Tauri 2 桌面） | ◐ | ◐ | 中 | 桌面两者均可用；MNN 可能免 clang（待验证） |
| 端侧推理速度（Android CPU） | ● | ○ | 强（1B 实测）/ 待实测（0.6B） | 优势来自移动端调度 |
| 端侧推理速度（Android GPU） | ◐（常弱于自身 CPU） | ○ | 强 | 首版不启用 |
| 多设备兼容性 | ●（CPU）/ ○（低端量化档） | ◐ | 强/中 | MNN 后端宽但低端机档位少 |
| 数据安全性 | ◐（需自建校验） | ◐（需自建校验） | 强 | 持平；供应链差异需治理 |
| 长期稳定性（单实例前台） | ● | ◐ | 强/中 | 两家可接受 |
| 长期稳定性（多实例/后台） | ○ | ◐ | 强 | MNN −55% |
| 生态与模型供给 | ◐（官方预转换 + 需转换） | ●（GGUF 通用） | 强 | 直接影响"用户自选模型" |
| 包体与构建依赖 | ●（约 800KB 核心） | ◐（ggml 静态库 + 构建链） | 中 | 需按最终 APK 增量实测 |

### 4.5 对产品决策的含义

1. **主线不动**：现有 llama.cpp 已覆盖阶段 B 并建立可测量口径，切换引擎不会解决 16 KB 页、进程隔离、分发校验等真实缺口。
2. **MNN 作为性能备选，而不是并列主线**：只有在"本项目自测 0.6B 解码 ≥ llama.cpp 的 1.5 倍"且"TTFT 与 RSS 不明显恶化"时，才值得进入实施。
3. **先抽象、后换引擎**：无论是否切换，把"引擎实现"与"模型描述"抽象出来（`Engine` 接口 + 模型 bundle 清单）都是净收益——它让对照实验可控，也让未来换引擎不需要动 UI、隐私闸门与状态机。

---

## 5. 与现有方案的耦合面（仅分析，不含实施）

| 模块 | llama.cpp 现状（主线） | MNN 方案需要的变化 | 风险 |
|---|---|---|---|
| 引擎封装 `agent/local/engine.rs` | 直接持有 `LlamaModel/LlamaContext`，自管 KV 前缀复用与采样链 | 改为 `Llm` 风格封装：`config.json` 驱动、`reuse_kv` 复用；采样链语义对齐 | 中：采样器差异影响输出一致性 |
| 运行时 `agent/local/runtime.rs` | 状态机 + 热/电量门控 + 配置 sanitize + 线程/上下文 | 基本可复用；需新增模型 bundle 校验与引擎状态映射 | 低 |
| 模型目录与选择 UI | 扫描 `.gguf`，姓名白名单，`MAX_MODEL_BYTES=3GB` | 改为目录级 bundle；展示体积/量化/来源；可能需要"一键转换"说明 | 中 |
| 分发与校验（阶段 D） | 单文件 sha256 + 体积 + 断点续传 | 多文件清单、目录级原子落盘、总空间预估 | 中高 |
| 命令层 `commands/local.rs` | 加载/卸载/生成/状态查询 | 参数映射与错误码扩展 | 低 |
| 前端 `LocalModelSection.tsx` | 文件列表 + 线程/上下文/输出上限 | 增加引擎标识与模型格式说明 | 低 |
| 构建脚本 `scripts/build-android.mjs` | 固定 NDK/CMake、prepare 插件目录 | 增加 MNN CMake 构建与 jniLibs 拷贝（或静态链接） | 中 |
| `Cargo.toml` feature | `local-llm` → `llama-cpp-2`（可选依赖） | 新增 `local-mnn` feature，避免默认构建引入新工具链 | 低 |

**建议的最小抽象（供下一阶段设计，不在本阶段实现）**：

```text
Engine: load(bundle) -> ready / generate(turns, params, cancel, sink) / unload / metrics
ModelBundle: { engine: Gguf | Mnn, files: [{name, bytes, sha256}], display, quant, source }
```

该抽象的唯一目的是让两个引擎在**同一测量口径**下可替换，从而产出可对比的基准数据；不引入任何"未来再加第三个引擎"的推测性设计。

---

## 6. 下一阶段对比验证方案（仅规划）

### 6.1 基准矩阵

| 变量 | 取值 |
|---|---|
| 设备 | 旗舰（SD 8 Gen 3 级）、中端（SD 7 系）、低端/4GB 档 |
| 引擎 | llama.cpp（现有 0.1.160）、MNN（锁定同一版本） |
| 模型 | Qwen3-0.6B（两家同一源模型、各自量化） |
| 量化 | 4-bit 主档；可选 8-bit 对照 |
| 线程 | 2 / 4 |
| 上下文 | 2048 / 4096 |
| 轮次 | 冷启动 1 次预热；每组 5 次取均值；另做 30 分钟长稳 1 次 |
| 构建 | release（不得使用 debug 结论） |

### 6.2 指标与门禁

| 指标 | 采集方式 | 门禁 |
|---|---|---|
| 解码速度 | 复用现有 `local perf: prompt_tokens/prompt_ms/decode_ms` 口径 | MNN ≥ llama.cpp 1.5x 才进入下一轮 |
| 首 token 延迟 | 加载完成 → 首个 `text_delta` | 不得比 llama.cpp 恶化 30% 以上 |
| 峰值 RSS | `dumpsys meminfo` / `/proc/<pid>/status` 采样 | ≤ llama.cpp 的 1.5 倍 |
| 长稳 | 30 分钟连续对话 + 热压 | 无 OOM、无降频失控、门控正常触发 |
| APK 增量 | 对比安装包与 `jniLibs` 体积 | ≤ 15MB |
| 崩溃率 | 连续 50 轮对话 | 0 次原生崩溃 |

### 6.3 失败退出条件

出现以下任一情况即判定"MNN 不进入实施"，保留为文档结论：

1. 无法在现有工具链内产出可运行 `arm64-v8a` 产物；
2. 0.6B 解码速度未达 1.5x，或 TTFT/RSS 明显恶化；
3. 模型 bundle 校验与回退机制无法在阶段 D 的复杂度预算内完成；
4. 许可或合规（含 16 KB 页）任一项不通过。

### 6.4 明确不做

- 不在本阶段做 GPU/NPU 路径（含 Adreno OpenCL、Hexagon）。
- 不做双引擎并行上的功能开发（例如按设备自动选择引擎）。
- 不为 MNN 重建一套 UI、隐私或脱敏链路。
- 不用第三方汇总的 tok/s 数字替代本项目自测。

---

## 7. 参考来源

**MNN 官方与文档**

1. [MNN 介绍（平台、后端、体积、许可）](https://mnn-docs.readthedocs.io/en/latest/intro/about.html)
2. [MNN 大语言模型部署（导出链路、量化参数、后端配置）](https://mnn-docs.readthedocs.io/en/latest/transformers/llm.html)
3. [MNN 预转换模型下载（ModelScope / Hugging Face）](https://mnn-docs.readthedocs.io/en/latest/transformers/models.html)
4. [alibaba/MNN 仓库](https://github.com/alibaba/MNN)

**论文与独立测量**

5. [MNN-LLM: A Generic Inference Engine for Fast LLM Deployment on Mobile Devices（arXiv:2506.10443，MM Asia'24）](https://arxiv.org/abs/2506.10443)
6. [Large Language Models on Mobile Devices: A Measurement Study of Single- and Multi-Instance Execution（EdgeFM'25）](https://dl.acm.org/doi/10.1145/3737902.3768359)

**Rust 绑定**

7. [mnn-rs（crates.io，含 LLM feature 与预编译说明）](https://crates.io/crates/mnn-rs)
8. [mnn 0.3.0（docs.rs，通用 Interpreter 绑定）](https://docs.rs/mnn/0.3.0/mnn/)

**llama.cpp 与平台约束**

9. [llama.cpp 官方 Android 文档](https://github.com/ggml-org/llama.cpp/blob/master/docs/android.md)
10. [llama-cpp-2（crates.io）](https://crates.io/crates/llama-cpp-2)
11. [Android 16 KB 页面支持要求](https://developer.android.com/guide/practices/page-sizes)

**本项目内部文档**

12. `docs/LifeOS_本地模型与数据分级方案_v1.0.0.md`（LIF-2026-DES-002）
13. `docs/LifeOS_本地推理生产化研究报告_v1.0.0.md`（LIF-2026-RES-003，主线 `57dde74` 起存在）
14. 主线代码基线：`src-tauri/Cargo.toml`（`local-llm` feature、`llama-cpp-2` 0.1.160）、`src-tauri/src/agent/local/{mod,engine,runtime,gating}.rs`、`scripts/build-android.mjs`

---

## 附：核查方法与局限

1. **一手来源优先**：平台矩阵、量化参数、产物结构、许可均来自官方文档或仓库；crate 采用度取自 crates.io API 元数据（`mnn-rs` 2026-03-22 建库、0.1.7 于 2026-08-17 发布、累计 259 次下载）。
2. **第三方数据不等价于本项目数据**：EdgeFM'25 覆盖 1B/3B 与骁龙 8 Gen 3 旗舰机，MNN 版本为 3.1.0；本项目的 0.6B + 中端机 + 当前 MNN 版本尚未测量，**不得外推**。
3. **厂商论文存在自评估偏差**：MNN-LLM 论文由阿里团队撰写，对比口径（Xiaomi 14、4 线程、Qwen2-1.5B/7B、Llama3-8B）与本项目不同，仅作方向性证据。
4. **"未验证"项已显式标注**：预编译二进制 MSVC CRT 兼容性、MNN 桌面构建可行性、0.6B 速度收益、模型 bundle 校验成本，均属待实测。
5. **本报告不含实现**：本阶段未执行任何编译、模型转换、推理或基准测试；任何"已完成"表述均指文档与代码基线核对。
