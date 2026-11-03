# P3-1 MNN 跨轮 KV 复用问题说明

> 适用范围：`local-mnn` 特性下的 MNN 3.6.1 推理路径。本文只描述现状与取舍，不代表已修复。

## 1. 结论一句话

MNN 跨轮 KV 复用当前不可用，原因是上游流式接口没有增量 prefill 入口，**不是本项目漏做**：库里有前缀复用能力，但它只挂在阻塞式 `response(const ChatMessages&)` 上，本引擎要求的"流式 + 逐 token 可取消"路径拿不到这个入口。

## 2. 现象

每一轮生成开始前都会执行 `mnn_llm_reset`，把 KV 缓存、token 计数与 history 一并归零，随后由 `mnn_llm_generate_init` 对整段 prompt 做全量 prefill。因此表现是：

- 上下文中已有的历史每轮都要重新计算一遍，上下文越长，每轮开头的等待越久（TTFT 明显上升，整轮耗时随之上升）。
- 模型输出本身正常，逐字流式与中途取消都仍然可用。

对应代码：`src-tauri/src/agent/local_mnn/worker.rs` 中的 `generate` 函数（当前第 179 行起），reset 调用在当前第 242 行。

## 3. 影响范围

- **只影响延迟**：表现为 TTFT 变长与整轮耗时变长，不改变输出正确性与质量，也不会改变采样结果。
- **代价随总上下文长度增长**，而不是随本轮新增语句的长度增长；历史越长，重复 prefill 的开销越大。
- 附带耗电与发热上升（重复 prefill 属于纯算力浪费）。
- **无真机，无性能数字**：本文没有在真机上做过量化测量，不给任何 TTFT / tok/s / 耗电数字，结论仅来自代码路径分析。

## 4. 根因（三层）

### 4.1 库层：复用能力存在，但默认关闭

MNN 3.6.1 的前缀复用实现在 `Llm::response(const ChatMessages&)` 中，位于 `transformers/llm/engine/src/llm.cpp:1104-1211`：它会比较上一轮缓存的模板文本与新模板的公共前缀，在 token 边界切分后只 prefill 增量。

对应开关在 `transformers/llm/engine/src/llmconfig.hpp:160-164`：

```cpp
bool reuse_kv() const { return config_.value("reuse_kv", false); }
bool prompt_cache() const { return config_.value("prompt_cache", false); }
```

两者默认都是 `false`，即模型 bundle 的 `config.json` 不显式打开时，库不会做任何跨轮复用。

### 4.2 流式接口无入口

流式路径走的是 `Llm::response(const std::vector<int>& input_ids, ...)`，位于 `llm.cpp:1074-1080`，其实现只有三步：

```cpp
generate_init(os, end_with);
CHECK_LLM_RUNNING(mContext);
generate(input_ids, max_new_tokens);
```

它没有"只 prefill token 后缀"的参数，只能整段送进去。而 `reuse_kv` 的作用范围仅限于 `generate_init` 是否清空 KV（`llm.cpp:824-828`）：

```cpp
if (!mConfig->reuse_kv()) {
    mContext->all_seq_len = 0;
    mContext->history_tokens.clear();
    mMeta->remove = mMeta->previous;
}
```

也就是说 `reuse_kv` 只决定"清不清"，不做前缀去重——真正的去重逻辑只在 4.1 的 `response(const ChatMessages&)` 里。

### 4.3 C 封装锁死在阻塞路径

`mnn_llm_response_messages` 位于 `wrapper/mnn_llm_wrapper.cpp:191-208`，内部直接调用 `handle->llm->response(messages, &oss, nullptr, max_new_tokens)`，把整段结果写进 `ostringstream` 后一次性返回：

- 没有 chunk 回调，无法逐字输出；
- 生成期间无法在 token 之间检查取消标记。

对应的 Rust 安全封装 `response_messages` 在 `mnn-rs-0.1.7/src/llm.rs:198-228`，同样是阻塞式、一次性返回字符串。

本引擎要求流式 + 逐 token 取消，因此只能走 `mnn_llm_generate_init` / `mnn_llm_generate_step` / `mnn_llm_stoped` 这套 C 接口，也就无法接入复用入口。

> 行号来源：MNN 3.6.1 源码位于本机临时工作区 `%LOCALAPPDATA%\Temp\mnn-workspace\MNN-3.6.1`；`mnn-rs` / `mnn-rs-sys` 版本由 `src-tauri/Cargo.toml` 锁定为 `0.1.7`，对应 Cargo registry 中的 crate 源码。行号已按当前源码核对，若上游版本变化需重新确认。

## 5. 为什么不能简单删除 reset 或打开 reuse_kv

- 删掉 `mnn_llm_reset`：旧 KV 未清空，而流式接口又把整段新 prompt 全量 prefill，结果是旧状态叠加新序列，上下文串味（模型会在错误的历史上继续生成）。
- 打开 `reuse_kv`：它只阻止 `generate_init` 清 KV，并不做前缀去重，仍然会整段 prefill 并叠加，问题同上。
- 因此当前把 `mnn_llm_reset` 当作**正确性边界**保留下来，牺牲速度换正确性。相关说明也写在本项目两个位置：
  - `src-tauri/src/agent/local_mnn/mod.rs` 顶部的模块说明段（当前第 13-29 行，标题为"跨轮 KV 复用：上游能力受限，当前未启用"）；
  - `src-tauri/src/agent/local_mnn/worker.rs` 中 `generate` 函数的 reset 处注释（当前第 235-242 行）。

## 6. 三种出路与代价

| 方案 | 做法 | 收益 | 代价 |
| --- | --- | --- | --- |
| **A 维持现状** | 每轮 reset + 全量 prefill | 功能完整：流式输出 + 可取消；无维护成本 | 上下文越长越慢，算力与耗电浪费 |
| **B 增加非流式"快答"路径** | 改走 `mnn_llm_response_messages`（即 `response_messages`），借用 `prompt_cache` 复用 | 能拿到上游前缀复用，长上下文单轮更快 | 无逐字输出、生成中不能取消；与现有流式契约并存需要额外分支 |
| **C 产品侧压缩上下文** | 限制历史轮数 / 摘要化历史 / 精简系统提示 | 立竿见影，不依赖上游 | 损失记忆，回答质量可能下降 |
| **D（补充）自维护 MNN fork** | 在流式路径上新增"增量 prefill 后缀"入口 | 流式 + 复用兼得，最彻底 | 需维护补丁、跟随上游 rebase、重新交叉编译；长期成本最高 |

排序建议：C 是零代码成本、立即生效的缓解手段；B 是中等成本的功能分支；D 成本最高，只有在复用收益被真机数据证明后才值得做。

## 7. 当前状态

- 已提交 `76d6804`：记录"跨轮 KV 复用不可用"的结论与代码依据（模块顶部说明段）。
- 已提交 `d2568f7`：给 `mnn_smoke` 增加可选的 `--repeat <n>`，用于在真机上连续跑多轮同一 prompt 观察逐轮 TTFT / prefill；不带该参数时输出逐字节不变。
- **复用未实现**：当前每轮仍执行 reset + 全量 prefill，没有任何跳过前缀的代码路径。
- 待确认项"每轮送入的是完整历史还是仅新增句"的核对结论：
  - 引擎侧可以确认：`LocalMnnState::generate_stream` 只接收单段 `prompt` 字符串，`worker::generate` 每轮把它整体交给 `mnn_llm_generate_init` 后立即 reset，引擎内部不留存任何历史；`mnn-rs` 侧也没有历史累积接口。
  - 调用侧现状：`local_mnn_generate`（`src-tauri/src/commands/local_mnn.rs`，当前第 98-123 行）是 MNN 的唯一生成入口，prompt 由调用方自行拼装；仓库内暂未把 MNN 接入聊天链路（聊天本地路径仍只走 `agent/llm.rs` 中的 llama.cpp runtime）。
  - 因此"完整历史 / 仅新增句"取决于将来接线时调用方的拼装口径，目前不存在增量传句的实现；一旦接入聊天链路，若按常规做法传入完整历史，则会命中本文描述的重复 prefill 问题。
