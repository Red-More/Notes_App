# LifeOS 本地推理生产化研究报告

| 项目     | 内容                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文档编号 | LIF-2026-RES-003                                                                                                                                                                                                                      |
| 版本     | v1.0.0                                                                                                                                                                                                                                |
| 编制日期 | 2026-11-01                                                                                                                                                                                                                            |
| 研究对象 | llama.cpp 及其 Rust 绑定、移动端落地项目、替代引擎                                                                                                                                                                                    |
| 关联文档 | [LifeOS_本地模型与数据分级方案_v1.0.0.md](./LifeOS_%E6%9C%AC%E5%9C%B0%E6%A8%A1%E5%9E%8B%E4%B8%8E%E6%95%B0%E6%8D%AE%E5%88%86%E7%BA%A7%E6%96%B9%E6%A1%88_v1.0.0.md)（LIF-2026-DES-002）、[Model Management.md](./Model%20Management.md) |
| 适用场景 | Tauri 2 + React + Rust，Android 优先，内嵌 GGUF 本地推理                                                                                                                                                                              |

---

## 0. 结论摘要

1. **技术路线正确，但当前实现处于"能跑通"而非"生产级"**。llama.cpp + Rust 绑定在 Android 上可用，真机已跑通中文流式推理；差距集中在模型分发、进程隔离、热与内存治理、构建可重复性四块。
2. **llama.cpp 仍是移动端事实标准**。Ollama、Jan、LocalAI、GPT4All、PocketPal、llama.rn、官方 `llama.android` 全部以 llama.cpp 为推理内核，加上自研的调度、分发与生命周期管理。真正的"生产级"差异不在推理引擎，而在这三层外围。
3. **`llama-cpp-2` 适合内嵌，但要接受"跟随上游、无 semver 承诺"**。它版本节奏快（2026 年 4 个大版本），锁定 0.1.160 是正确做法；升级必须回归测试。
4. **Android 侧有三个硬性合规/稳定性缺口**：16 KB page 支持（Play 2025-11 起强制）、前台服务类型与时长限制、`onTrimMemory` 释放策略。当前 NDK 26.2 + API 24 的组合不满足第一条。
5. **建议的投资顺序**：预编译产物与可重复构建 → 模型分发（断点续传 + sha256）→ 进程隔离与内存/热治理 → 引擎升级通道。GPU/NPU 后端应放在最后，且只做 Adreno 可选路径。

---

## 1. 核查范围与方法

- **一手来源优先**：GitHub 仓库、官方文档、release notes、crates.io/docs.rs。
- **二手数据标注口径**：所有吞吐量数字均注明设备、模型、量化与线程条件；口径不一致时并列而非取平均。
- **明确"不存在"的结论**：用户提到的两个项目名做了独立核查，结果写在第 2 节，不做模糊化处理。

---

## 2. 对 "Neurix / Zynkot" 的核查结论

| 名称       | 核查结果                                                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Neurix** | 真实存在。MIT 许可，TypeScript 实现，作者为独立开发者；面向 Android APK 与 Windows，使用 llama.cpp CPU 推理；模型商店按设备内存推荐（约 640 MB–5.2 GB 区间）；下载支持断点续传与 SHA-256 校验。但项目规模很小（2026-10 约 14 stars），属**早期个人项目**，可借鉴其产品化细节（按内存推荐、下载校验），**不足以作为生产标杆**。 |
| **Zynkot** | **未找到任何与 llama.cpp 或本地推理相关的项目**。精确检索仅命中漫画中的地名。最接近的真实项目是 **Zynkbot**（Tauri 桌面应用 + 本地 GGUF + SQLite 记忆），技术栈与本项目高度相似，值得作为架构参考；另有 Ollama 上的模型条目与一家波兰营销公司，均与本地推理无关。                                                              |

- https://github.com/adoslabsproject-gif/Liara-toolkit?tab=License-1-ov-file
- https://github.com/MilanDanilovic/opnlocal
- https://github.com/Lucent-Project/Lucent

> 结论：报告其余部分不把这两个项目当作证据来源，改为以 Ollama、llama.rn、PocketPal、官方 Android 示例等可验证项目为基准。

---

## 3. Rust 绑定层：`llama-cpp-2` 的定位与代价

### 3.1 事实基线

| 项             | 值                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 当前锁定版本   | `llama-cpp-2` / `llama-cpp-sys-2` 0.1.160（2026-10-15）                                                                           |
| 上游 llama.cpp | v0.8.0（2026-10-28），crate 快照通常落后 1–2 周                                                                                   |
| 版本承诺       | README 明确"跟随上游、不遵循 semver"，2026 年内已发布多个 0.1.x                                                                   |
| 默认 features  | `android-shared-stdcxx`、`common`、`openmp`                                                                                       |
| 可选后端       | `cuda` / `vulkan` / `opencl` / `metal` / `rocm` / `mkl` / `webgpu` / `mtmd` / `dynamic-link` / `dynamic-backends` / `system-ggml` |
| 构建依赖       | CMake ≥ 3.20、`bindgen`（需 libclang）、`cc`、活跃的 NDK                                                                          |
| 许可           | llama.cpp MIT、ggml MIT → 可闭源商用，保留版权声明即可                                                                            |

### 3.2 为什么仍然选它

- **零网络、零云端**：与 LIF-2026-DES-002 的出境闸门模型天然契合，推理不产生任何可被拦截的外发面。
- **生态对齐**：模型格式（GGUF）与量化生态由 llama.cpp 定义，换引擎等于换模型格式。
- **已有真机证据**：本项目已在 Redmi Note 12 Turbo 上跑通 Qwen3-0.6B IQ4_XS 的中文流式输出。

### 3.3 需要接受的代价

1. **构建期依赖重**：bindgen + CMake + NDK 三件套，单机首次全量编译 15 分钟量级（本项目桌面 15m40s、Android 12m18s）。
2. **版本漂移**：升级 crate 等于升级推理引擎，`engine.rs` 必须回归（尤其 `chat_template`、`LlamaSampler`、`token_to_piece` 的签名）。
3. **Android 属"可用边界路径"**：上游有针对 NDK triple 的修复，也存在仍开放的 Android 相关 issue（Direct IO、Snapdragon 后端）。用得上，但不能假设它和 x86 桌面同等成熟。
4. **已知编译坑**：
   - 某些 ARM 目标需 `-C target-feature=+fp16`，否则报 `instruction requires: fullfp16`；
   - build.rs 判目标要用 `CARGO_CFG_TARGET_OS`，不能用 `cfg!()`；
   - NDK 构建建议显式关闭 `GGML_NATIVE`、`GGML_LLAMAFILE`、`LLAMA_OPENSSL`，并避免 OpenMP 与 NDK 自带运行时的冲突。

### 3.4 被排除的替代方案

| 方案                               | 排除理由                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `rustformers/llm`（原 `llama-rs`） | 已归档停更（2024-06）。注意 crates.io 2026 年出现同名 `llama-rs`，是独立实现，易混淆。 |
| `mistral.rs`                       | 独立引擎（非 llama.cpp 绑定），面向服务器/桌面 GPU，无 Android 预编译与移动调度。      |
| `candle` / `Kalosm`                | candle 是张量框架，Kalosm 是其高层封装；均不提供 GGUF 移动运行时路径。                 |

---

## 4. 生产项目的架构谱系与可借鉴点

### 4.1 桌面与服务端

| 项目          | 架构                                                                                                                                                      | 可借鉴                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Ollama**    | Go 常驻服务；模型存为 OCI 风格 `manifests/` + `blobs/`，按 sha256 内容寻址；默认 5 分钟 `keep_alive`，`0` 立即卸载、`-1` 常驻；调度器做引用计数与容量驱逐 | **keep-alive 的三种语义**、内容寻址存储、单飞加载（同一模型并发请求共享一次加载） |
| **LocalAI**   | Go 编排，每个后端是可外挂的 gRPC server，按需拉起                                                                                                         | 后端进程化，崩溃不传染主进程                                                      |
| **Jan**       | Electron + Cortex.cpp（默认 llama.cpp，也支持 ONNX / TensorRT-LLM）                                                                                       | 引擎抽象层，允许替换后端而不动 UI                                                 |
| **llamafile** | llama.cpp + Cosmopolitan，单文件 + mmap 权重                                                                                                              | 极致启动速度；但**官方不支持 Android**，移动端不可照搬                            |
| **GPT4All**   | 维护 llama.cpp fork，用多版本子模块兼容旧量化                                                                                                             | 兼容历史量化格式的版本矩阵管理                                                    |
| **LM Studio** | 闭源；llama.cpp + MLX                                                                                                                                     | 只能借鉴"按模型下载运行时"的产品形态，代码不可复用                                |

### 4.2 移动端

| 项目                                 | 要点                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **`examples/llama.android`**（官方） | Kotlin + `InferenceEngine` / `AiChat`，检测 Arm SME2 等特性；Arm 的 "AI Chat" 已上架 Play，可视为官方生产样例           |
| **PocketPal AI**                     | MIT；GGUF；CPU / Adreno GPU / Hexagon NPU 三档；官方给出的 NPU 实验路径 prefill 2725 tok/s、TTFT 233 ms（仅特定芯片）   |
| **`llama.rn`**                       | MIT；RN 绑定；postinstall 下载**预编译 jniLibs 并做 SHA-256 校验**；OpenCL 仅 Adreno 700+，Hexagon 实验性且限定 SM8450+ |
| **ChatterUI**                        | **AGPL-3.0**，许可证与闭源分发不兼容，不能抄代码，只能看交互设计                                                        |

### 4.3 归纳出的四条通用模式

1. **推理内核统一，外围全部自研**：没有一个生产项目把"加载 + 分发 + 生命周期"交给绑定库。
2. **模型分发 = 断点续传 + sha256 + 原子落盘**：Neurix、llama.rn、Ollama 都是这套。
3. **崩溃隔离靠进程边界**：LocalAI 用 gRPC 后端进程；进程内 FFI 的代价是 C++ 段错误直接杀掉整个 App，且没有 watchdog 重启。
4. **卸载策略产品化**：要么像 Ollama 那样给用户可见的 keep-alive 语义，要么像 PocketPal 那样"前台才加载"。

---

## 5. 移动端生产约束（按风险排序）

### 5.1 合规：16 KB page（阻断级）

2025-11-01 起，面向 Android 15+ 的新提交与更新必须支持 16 KB 内存页，**NDK r28+ 默认满足**。本项目当前为 **NDK 26.2.11394342 + API 24**，不满足该要求；一旦上架 Play 会被拒。

处置：升级到 NDK r28+ 并重新验证 llama.cpp 交叉编译，同时把 `minSdk` 与 16 KB 对齐测试加入验收清单。

### 5.2 前台服务与后台限制

- Android 14 起必须声明 FGS type；Android 15 起 `dataSync` / `mediaProcessing` 每 24 小时累计上限约 6 小时，超时必须 `stopSelf()`，否则崩溃；`shortService` 约 3 分钟。
- 推理应绑定前台 Activity，或使用需在 Play 填写说明的 `specialUse`；不要把"长期后台常驻推理"当成默认可行路径。

### 5.3 内存与热

- **mmap 优先**：按页缺页、共享 page cache；`mlock` 在普通 App 上通常因权限失败。
- **模型放应用私有目录**：`/sdcard` 走 FUSE，随机读放大明显。
- **实现 `onTrimMemory`**：主动释放 KV cache 与上下文，而不是等系统杀进程。
- **WebView 内存随系统 provider 波动**：Tauri 使用系统 WebView（不打包），长会话需限制消息条数或用虚拟列表。

### 5.4 量化与上下文预算

| 量化   | 特点                    | 适用                                     |
| ------ | ----------------------- | ---------------------------------------- |
| Q4_K_M | 通用默认，质量/体积平衡 | 6–8 GB 机型的主力档                      |
| IQ4_XS | 更小，建议配 imatrix    | 内存紧张的 4–6 GB 机型（本项目当前选择） |
| Q8_0   | 近无损但体积大          | 高端机、短上下文场景                     |

KV cache 估算：`2 × dtype_bytes × n_layer × n_kv_heads × head_dim × n_ctx`。GQA（`n_kv_heads < n_head`）是手机能开长上下文的前提；`n_ctx` 每翻一倍，KV 线性增长。

### 5.5 线程调度

同步线程池会"等最慢的那个线程"，因此**不要用满核心**。经验值 `n_threads = min(4, cores - 2)`，或只绑大核；2–4 线程通常最优。本项目设备探测推荐 3 线程，属于该经验区间。

### 5.6 实测吞吐（口径必须并列）

| 来源           | 条件                                                                         | 结果                                                  |
| -------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| 本项目         | Redmi Note 12 Turbo / Android 14 / Qwen3-0.6B IQ4_XS / 3 线程 / debug 未优化 | 99 输出 token ≈ 20s（≈5 tok/s），冷启动首 token 30.8s |
| 第三方汇总     | Snapdragon 8 Elite / 1.7B 级模型 / NPU 路径                                  | ≈40 tok/s                                             |
| 第三方汇总     | 同平台 CPU-only / 1–2B                                                       | ≈8–12 tok/s                                           |
| PocketPal 官方 | 特定芯片 NPU 实验路径                                                        | prefill 2725 tok/s、TTFT 233 ms                       |

> 结论：本项目 debug 包 5 tok/s 属正常区间；release + 优化后预期能进入 1B 以下模型 10 tok/s 量级，但这属于**待验证假设**，不进结论。

---

## 6. 非 llama.cpp 的移动推理方案

| 方案                      | 定位                                                                                 | 与本项目的关系                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **MLC-LLM**               | TVM 编译，GPU/NPU 表现强；模型需转 MLC 格式                                          | 若要极致移动性能可评估，但意味着放弃 GGUF 生态（ModelScope 分发、用户自选模型都要改） |
| **LiteRT-LM / MediaPipe** | Google 官方边缘推理；MediaPipe LLM Inference 的 Android/iOS 已废弃并迁移到 LiteRT-LM | 生产稳定，但绑定 Google 工具链与模型格式，与"用户自选 GGUF"的产品主张冲突             |
| **ExecuTorch**            | PyTorch 原生 + 委托（delegate）                                                      | 委托生态仍在成长，移动 LLM 尚非其最强场景                                             |
| **MNN-LLM**               | 阿里，大量 App 使用，中文场景优化好                                                  | 可作为国内 Android 商业化的备选，但同样脱离 GGUF                                      |

> 建议：**主线坚持 llama.cpp**，把 MLC/LiteRT 作为"若某项指标长期不达标再评估"的后备，不在阶段 C–F 内并行投入。

---

## 7. 与本项目的差距矩阵

对照 [LifeOS_本地模型与数据分级方案_v1.0.0.md](./LifeOS_%E6%9C%AC%E5%9C%B0%E6%A8%A1%E5%9E%8B%E4%B8%8E%E6%95%B0%E6%8D%AE%E5%88%86%E7%BA%A7%E6%96%B9%E6%A1%88_v1.0.0.md) 的阶段 B 实现与上文的通用模式：

| 维度          | 本项目现状                        | 生产基准                                   | 差距等级           |
| ------------- | --------------------------------- | ------------------------------------------ | ------------------ |
| 推理内核      | `llama-cpp-2` 0.1.160，进程内 FFI | 同（多数项目如此）                         | —                  |
| 崩溃隔离      | 无；C++ 崩溃即杀 App              | 独立进程 + watchdog                        | **高**             |
| 模型分发      | 手动导入文件，无校验、无续传      | 断点续传 + sha256 + 原子落盘               | **高**（阶段 D）   |
| 反复卸载/加载 | 切后台即释放，回前台冷启动 30s    | 可见的 keep-alive 语义（如 Ollama 5 分钟） | **中**             |
| 内存治理      | 仅显式卸载                        | `onTrimMemory` + 分级降级                  | **中**             |
| 热/电量       | sysfs 读取 + 门控                 | 同上，另加前台服务上报                     | 低–中              |
| 构建可重复性  | 依赖手工重命名插件目录            | 一条命令可重复                             | **中**（本次已修） |
| 16 KB page    | NDK 26.2 / API 24                 | NDK r28+                                   | **高（阻断上架）** |
| 预编译产物    | 每台机器全量编译 15 分钟          | CI 预编译 + sha256                         | **中**             |
| 引擎升级通道  | 手工锁版本                        | 版本回归矩阵                               | 低                 |
| GPU/NPU       | 未启用                            | Adreno OpenCL 可选                         | 低（非首版必需）   |

### 7.1 建议的实施顺序

**P0（上架与稳定性阻断项）**

1. NDK 升级到 r28+，重建并验证 16 KB page 与现有真机回归。
2. 模型分发补齐 sha256 + 断点续传 + `.part` 原子落盘（阶段 D 原计划）。
3. 内存治理：接入 `onTrimMemory` 回调，按级别释放 KV / 上下文 / 模型。

**P1（体验与健壮性）** 4. keep-alive 语义产品化：提供"立即卸载 / 5 分钟 / 常驻"三档，默认 5 分钟，替代当前二元的开关。5. 崩溃隔离评估：先做**最小可行的进程内防护**（catch panic、超时看门狗），把"独立 `:llama` 进程"作为一期评估项而非承诺。6. 预编译产物：CI 构建一次 `libllama`，产物入库并校验，避免每台机器 15 分钟编译。

**P2（可选增强）** 7. Adreno OpenCL 后端（仅 Adreno 700+），失败时无条件回落 CPU。8. 引擎升级通道：锁定版本 + 升级回归清单（`chat_template`、采样链、`token_to_piece`、多模态）。

### 7.2 明确不做的事

- 不把 llamafile 的方案搬到 Android（官方不支持）。
- 不引入 MLC/LiteRT 作为并行主线（会破坏 GGUF 与"用户自选模型"的产品前提）。
- 不在首版做 Hexagon NPU（绑定过窄、实验性、机型覆盖极低）。

---

## 8. 许可与合规

| 对象                         | 许可                     | 分发要求                                      |
| ---------------------------- | ------------------------ | --------------------------------------------- |
| llama.cpp                    | MIT                      | 保留版权与许可声明                            |
| ggml                         | MIT                      | 同上                                          |
| Qwen3-0.6B                   | Apache-2.0（模型卡标注） | 保留许可与声明；GGUF 再分发还需遵守量化者条款 |
| PocketPal / llama.rn（参考） | MIT                      | 若复用代码需署名                              |
| ChatterUI（参考）            | AGPL-3.0                 | **不可**闭源分发，只可参考交互                |

应用内应提供"开源许可"页，列出 llama.cpp、ggml、各模型许可证与下载 sha256。Google Play 不审查模型许可证，但生成式应用受 AIGC / NCII 政策约束，需要内容安全能力与能力披露。

---

## 9. 风险与不确定项

| 项                | 性质     | 处置                                                                              |
| ----------------- | -------- | --------------------------------------------------------------------------------- |
| 绑定版本漂移      | 结构性   | 锁版本 + 升级回归清单；关注上游"预生成 bindgen"提案（可缩短 CI 与降低构建脆弱性） |
| Android 边界路径  | 结构性   | 每次升级 crate 都在真机回归；保留回退到上一个可用版本的能力                       |
| 第三方 tok/s 数字 | 数据质量 | 只作旁证，项目内以自测为准，标注设备/模型/量化/线程/构建类型                      |
| Qwen 系列许可表述 | 需复核   | 上线前读仓库 `LICENSE.txt`，不依赖二手站点                                        |
| Play 政策细节     | 需复核   | 以官方政策页为准，不依赖解读类文章                                                |
| 进程隔离成本      | 待评估   | 一期只做看门狗与 panic 捕获，独立进程另立项评估                                   |

---

## 10. 参考来源

**绑定与引擎**

- [llama-cpp-2 on crates.io](https://crates.io/crates/llama-cpp-2)
- [utilityai/llama-cpp-rs](https://github.com/utilityai/llama-cpp-rs)
- [llama-cpp-2 0.1.160 features](https://docs.rs/crate/llama-cpp-2/0.1.160/features)
- [llama.cpp 官方 Android 文档](https://github.com/ggml-org/llama.cpp/blob/master/docs/android.md)
- [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases)
- [llama.cpp LICENSE](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/LICENSE)
- [ggml LICENSE](https://raw.githubusercontent.com/ggml-org/ggml/master/LICENSE)

**生产项目**

- [Ollama FAQ（keep_alive）](https://docs.ollama.com/faq)
- [Ollama 0.30 GGUF 说明](https://ollama.com/blog/improved-performance-and-model-support-with-gguf)
- [LocalAI 架构](https://localai.io/docs/reference/architecture/index.html)
- [janhq/jan](https://github.com/janhq/jan)
- [llamafile 技术细节](https://mozilla-ai.github.io/llamafile/technical_details/)
- [GPT4All FAQ](https://docs.gpt4all.io/old/gpt4all_faq.html)
- [llama.rn](https://github.com/mybigday/llama.rn)
- [PocketPal AI](https://pocketpal.dev/)
- [ChatterUI](https://github.com/Vali-98/ChatterUI)

**移动平台约束**

- [Android FGS service types](https://developer.android.com/develop/background-work/services/fgs/service-types)
- [Android FGS timeout](https://developer.android.com/develop/background-work/services/fgs/timeout)
- [16 KB page size 支持](https://developer.android.com/guide/practices/page-sizes)
- [Android 内存管理](https://developer.android.com/training/articles/memory)
- [WebView 内存管理](https://developer.android.com/develop/ui/views/layout/webapps/manage-webview-memory)
- [Tauri WebView versions](https://v2.tauri.app/reference/webview-versions/)

**量化与上下文**

- [llama.cpp 量化文档](https://www.mintlify.com/ggml-org/llama.cpp/models/quantizing-models)
- [KV cache 计算（NVIDIA 博客）](https://developer.nvidia.com/blog/mastering-llm-techniques-inference-optimization/)
- [Android 上 llama.cpp 实测](https://hanyuliu.me/posts/running-llama-cpp-on-android/)

**替代引擎**

- [MLC-LLM 论文](https://arxiv.org/pdf/2410.03613)
- [LiteRT-LM](https://ai.google.dev/edge/litert-lm/overview)
- [MediaPipe LLM Inference](https://ai.google.dev/edge/mediapipe/solutions/genai/llm_inference)
- [ExecuTorch Android LLM demo](https://pytorch.org/executorch/main/llm/llama-demo-android.html)
- [MNN](https://github.com/alibaba/MNN)

**项目核查**

- [Neurix (GitHub)](https://github.com/Razee4315/neurix)
- [Zynkbot](https://containai.ai/zynkbot/)

---

## 11. 双推理引擎并存（2026-11-02）

llama.cpp 与 MNN 现在共用一层 `agent::inference` 契约，业务层（Tauri 命令、聊天链路）只依赖 `InferenceEngine` trait。

### 11.1 模块边界

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 统一契约 | `src-tauri/src/agent/inference/` | `InferenceEngine` trait、`EngineKind`、`ModelAsset`、`LoadOptions`、`EngineInput`、`GenerateParams`、`StopReason`、`EngineMetrics`、`EngineError`、通用 `Worker<H>` |
| llama.cpp 适配 | `src-tauri/src/agent/local/` | GGUF 单文件；`engine.rs` 包 context/sampler，`runtime.rs` 实现 trait |
| MNN 适配 | `src-tauri/src/agent/local_mnn/` | `.mnn` 多文件 bundle；worker 独占 `!Send` 句柄，`mod.rs` 实现 trait |

两个引擎的错误统一为 `EngineError`（序列化 `{ code, message }`），流式块统一为 `Box<dyn FnMut(&str) + Send>`，指标统一为 `EngineMetrics`（prompt/output token、prefill/decode/sample、TTFT、decode tok/s、stop reason）。

### 11.2 feature 组合

| 组合 | 行为 | 构建前置 |
| --- | --- | --- |
| 无 feature（默认） | 仅远端模型；本地状态 `supported=false` | 无 C/C++ 工具链 |
| `local-llm` | GGUF 单文件本地推理；原有 llama.cpp 路径不变 | clang + CMake + NDK（Android） |
| `local-mnn` | `.mnn` bundle 本地推理；`local_mnn_*` 命令 | 额外需要静态 `libMNN.a` 与 MNN 头文件 |
| `local-llm,local-mnn` | 两套注册同时保留，状态页返回 `engine` 字段区分 | 同时具备上述两套前置 |

`local-mnn` 默认关闭；两个 feature 互不依赖，代码中没有“启用 A 必须同时启用 B”的耦合。

### 11.3 目录约定

- GGUF：模型目录下的单个 `.gguf` 文件，文件名白名单校验（无路径分隔符）。
- MNN：模型目录下的一个子目录（bundle），必需 `config.json` 与至少一个 `*.mnn`；`tokenizer.mtok`、`*.mnn.weight`、`llm_config.json` 可选。目录名同样走白名单，解析后做 canonicalize 前缀校验，拒绝越界。

### 11.4 构建与环境

```powershell
# 桌面验证：四种组合
cargo check --locked
cargo check --locked --features local-llm
cargo check --locked --features local-mnn
cargo check --locked --features local-llm,local-mnn

# Android：debug（现有脚本已启用 local-llm）
pnpm android:build:local
# Android：release
pnpm android:build
# 双引擎（需先准备 libMNN）
pnpm tauri android build --target aarch64 --features local-llm,local-mnn --debug
```

Windows 上需一次性写入的环境变量（`src-tauri/.cargo/config.toml` 已固化 NDK 路径，换机时改这里即可）：

```powershell
setx MNN_LIB_DIR     "C:\path\to\mnn\lib"      # 含 libMNN.a，建议 c++_shared 构建
setx MNN_INCLUDE_DIR "C:\path\to\mnn\include"  # 含 MNN/Interpreter.hpp
```

注意：构建必须单进程串行（并发 gradle/cargo 会触发 os error 183）；`ANDROID_NDK` 必须显式指向完整的 r28c，否则 `llama-cpp-sys` 会探测到残缺目录。

---

## 附：核查方法与局限

- 版本、feature、许可证、平台限制均来自官方页面或仓库文件，可信度高。
- 吞吐量、APK/so 体积来自第三方或社区，口径不一，仅作量级参考。
- KV cache 示例按公式推算，实际以模型 `config.json` 里 `n_layer` / `n_kv_heads` / `head_dim` 复核。
- 本报告不评价闭源产品（LM Studio）的内部实现，只记录其可见的产品形态。
