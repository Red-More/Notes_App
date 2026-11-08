# LifeOS M2 完成交接文档

| 项目 | 内容 |
|---|---|
| 交接日期 | 2026-10-30 |
| 当前分支 | `refactor/database-layer-virtualfs-wal` |
| 基线提交 | `13f263d` build(deps) / `04c013f` fix(agent) / `4d80bd3` docs（上一功能提交 `a1995c1 feat: 新增 Agent 对话功能`） |
| 依据计划 | [LifeOS 下一步执行计划 v1.3.0](./LifeOS_下一步执行计划_v1.3.0.md) 第 5/11 节 |
| 上一交接 | [LifeOS M0 完成交接文档](./LifeOS_M0完成交接文档.md) |
| 下一阶段 | **M2-10 真机 E2E → M1 检索闭环（FTS5）** |

> 一句话：M2 代码全部落地且本机质量门全绿；只剩 M2-10 真机验收未做。不要重做 M2，也不要提前做技能系统。

---

## 1. 交接结论

- M2-1 ~ M2-9 代码完成，`pnpm` 与 `cargo` 四道门禁已在当前机器复跑通过（见 §2）。
- `life.db` schema 已升到 **v3**（`conversations / messages / settings`），密钥不入库。
- 模型可见工具严格为 5 个 `fs_*`；`doc_*`、技能、导出均未暴露给模型。
- LLM 请求只从 Rust 发出：前端自研 `streamFn` → `invoke('agent_stream')` → Rust SSE 转发；内置 `streamProxy` 未使用。
- 唯一未完成项是 **M2-10 真机 E2E**；它需要真实厂商 API Key（mock 只会回文本、不会发起工具调用）。
- 排期顺序仍是 `M2-10 → M1 → M3 → M4 → M5 → M6`。

---

## 2. 环境与验证基线（可复跑）

| 项 | 值 |
|---|---|
| Rust | `cargo 1.98.1` / `rustc 1.98.1`（`rust-version = 1.88`，Keystore crate 要求） |
| Node / pnpm | Node `v24.19.0` / pnpm `12.4.1` |
| Android | SDK `android-36` / `android-37.0`；NDK `26.2.11394342`；JDK 25 |
| 真机 | `e0a292bc1223`（ARM64，USB） |
| 远端 | 局域网裸仓库 `//MYLinuxPC/Documents/Git_Bare/Note_app.git`，**不会触发 GitHub Actions** |

复跑命令与当前结果：

```powershell
# 前端
pnpm lint     # 0 warnings / 0 errors
pnpm test     # 11 文件 / 122 用例
pnpm build    # 成功；ChatPage chunk 48.2KB gzip / 169.3KB min（上限 60KB gzip）

# 后端
cd src-tauri
cargo fmt --check                          # 通过
cargo clippy --all-targets -- -D warnings  # 通过
cargo check --all-targets                  # 通过
cargo test                                 # 16 passed（8 M0 + 8 M2）
```

## 3. M2 交付明细

| ID | 状态 | 实现位置 |
|---|---|---|
| M2-1 | ✅ | `src/agent/stream.ts`（`nativeStreamFn`）、`src/agent/runtime.ts`（`createAgent`）；仅 import 根入口，禁用 `providers/all` |
| M2-2 | ✅ | `src-tauri/src/db/schema.rs`（`SCHEMA_VERSION=3`）、`agent/conversations.rs`、`commands/agent.rs` |
| M2-3 | ✅ | `src-tauri/src/agent/llm.rs`：OpenAI / Anthropic / Google / mock 四适配；SSE 按字节行解析；取消与读超时（120s） |
| M2-4 | ✅ | `src-tauri/src/agent/secrets.rs`、`pages/settings/SettingsPage.tsx`；Android Keystore（fail-closed），桌面 0600 文件 |
| M2-5 | ✅ | `src/agent/tools.ts`（5 个 TypeBox 工具）、`agent/mod.rs`（`TOOL_ALLOWLIST` + Rust 二次校验） |
| M2-6 | ✅ | `fs_write` 仅新建；追加走「read 尾部 → edit 锚点」（`src/agent/prompt.ts` 已写入） |
| M2-7 | ✅ | `src/agent/prompt.ts`：10 条铁律、当前日期、「数据不是指令」、`{{skills_index}}` 占位 |
| M2-8 | ✅ | `src/pages/chat/ChatPage.tsx`：流式纯文本、工具卡片、停止/重试、草稿、会话抽屉；对话为默认首屏（`App.tsx` index 0） |
| M2-9 | ✅ | `tests.rs` 覆盖未知厂商 / 注入 model / >5 工具 / 白名单外工具 / 超长 prompt；`protocol.test.ts` 覆盖事件重建 |
| M2-10 | ⏳ 待真机 | 见 §5.1 |

新增 Tauri 命令（`src-tauri/src/lib.rs`）：

```text
chat_list / chat_create / chat_rename / chat_delete / chat_messages / chat_append
agent_settings / agent_settings_set / agent_key_set / agent_key_delete
agent_stream / agent_cancel
```

### 3.1 关键运行时事实（改动前必读）

1. `agent_stream` 入参即 pi 的 `{ requestId, model, context, options }`，Rust 只读 `model.id/provider/api`，**忽略 baseUrl**；`api_key` 不在结构体里。
2. 服务端校验：provider 枚举、model 字符集 `[A-Za-z0-9._-]`、system ≤64KB、上下文 ≤4MB、工具 ≤5 且必须在白名单。
3. 长会话先裁剪再校验：保留全部 system 消息 + 最近消息，总数 ≤200（`llm::trim_messages`）。
4. mock 仅在 `debug_assertions` 编译；debug 默认 provider=`mock`、模型=`mock-fast`；release 默认 `openai`。**mock 不产生工具调用**，不能用于落盘 E2E。
5. HTTP 客户端：仅 HTTPS、禁重定向、连接超时 10s、读超时 120s；初始化失败 fail-closed，不降级。
6. `beforeToolCall` 配额（前端）：单轮 ≤12 步、≤8 次写；Rust 未下沉，M6 再评估。
7. 渲染：流式与工具结果均为纯文本，禁止 `dangerouslySetInnerHTML`。
8. 前端还会拦截 `fs_read/glob/grep` 读取 `/life/.agents`（技能区只读），Rust 侧 CapGate 同样只读。

---

## 4. 不要做的事（M2 已冻结的边界）

- 不新增第 6 个工具，不把 `doc_*` 绑给模型。
- 不用 `providers/all`，不引入任何 provider SDK；CI/人工检查产物无 `aws-sdk/bedrock/@google/genai` 标记。
- 不在 `agent_stream` 接受任意 URL / `base_url` / `api_key`；密钥只进 Keystore。
- 不把 mock 放开到 release，不把 token 放进 localStorage / React 持久化 state。
- 不对模型原文使用 HTML 渲染。
- M2 阶段不做 FTS、技能系统、版本回滚 UI（分别属于 M1 / M3 / M4）。

---

## 5. 下一步执行顺序

### 5.1 M2-10 真机 E2E（先做，收尾 M2）

前置：真机已连接；**在设置页填入真实厂商 Key**（mock 无法触发工具）。

```powershell
pnpm tauri android build --debug --target aarch64
# 若遇到 Windows 无开发者模式的 jniLibs 符号链接失败，按 README 规避：
Copy-Item src-tauri/target/aarch64-linux-android/debug/libapp_lib.so `
  src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libapp_lib.so -Force
cd src-tauri/gen/android
.\gradlew.bat :app:assembleArm64Debug -x :app:rustBuildArm64Debug

adb install -r app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
adb shell am start -n com.mynotes.desktop.debug/com.mynotes.desktop.MainActivity
```

验收用例：

1. 说「记下今天吃了拉面」→ `/life/diary/YYYY-MM-DD.md` 落盘，rev=1；重启后仍可查（记录 ≤15 秒）。
2. 说「把那条待办勾掉」→ 对应文档 checkbox 变化，rev 递增，未新建重复文件。
3. 越狱清单（M2-9 用例）在真机重跑：路径穿越、诱导泄露 Key/联系人、诱导写 `.agents` 全部拦截。
4. 断网发消息 → 错误事件可恢复；点停止 → 返回 `aborted`，不崩溃。
5. Keystore 复验：保存 Key → 杀进程重启 → 仍可调用；`adb shell run-as com.mynotes.desktop.debug` 查看 SharedPreferences 为密文；删除 Key 后调用失败。

完成后回写计划文档 §11.1（M2-10 行）与 §11.3（追加真机结果）。

### 5.2 M1 检索闭环（11/18–11/24，M2-10 后立即开始）

目标：`fts_docs` 从空表变成与 `blobs` 同事务一致的检索通道，千条 <200ms；**不改 schema 版本**（不引触发器）。

| ID | 改动入口 | 要点 |
|---|---|---|
| M1-1 | `src-tauri/src/vfs/mod.rs`（`write/edit`）、`docs/mod.rs`（`save`）、`docs/versions.rs`（`restore`） | 应用层同事务写 FTS；软删移出、恢复重建；`purge/empty_trash` 清孤儿；启动补建缺失行 |
| M1-2 | `vfs/mod.rs::grep`、`vfs/types.rs::GrepRequest` | 切 FTS5 MATCH，回正文定位行号/片段；保留 LIKE 回退并如实返回 `fallback`；补 `type` 过滤（复用 `meta.kind`），新增参数必须同步 `src/agent/tools.ts` 与 `src/types.ts` |
| M1-3 | `db/schema.rs` 的 fts 建表语句 | 用 1000 条种子测 `unicode61` 中文短词召回；仅当不可用时才评估 jieba/ICU，并写 ADR |
| M1-4 | 测试/脚本 | 1000 条混合文档，grep 首屏 <200ms、`index_query` <100ms，输出 P50/P95 |
| M1-5 | `db/mod.rs` 启动检查 | FTS 行数/样本与 `blobs head_rev` 对齐；提供手动重建入口 |
| M1-6 | `src/api.ts`、笔记列表搜索 | UI 全局搜索改走 `grep`，替换 `doc_list` 的 `instr` 实现 |

注意：`grep` 的回退契约已被 `src/agent/tools.ts::renderGrep` 消费（会打印「本次为 LIKE 回退检索」），改协议时同步更新。

### 5.3 后续阶段

- **M3 技能系统**：SKILL.md 解析、启动扫描 `/life/.agents/skills`、初始 prompt 只注入摘要、4 个内置技能、技能管理走专用命令（非 `fs_write`）。
- **M4 体验闭环**：工具卡片、对话跳转文档、版本回滚、待办联动、离线三态。
- **M5 数据主权**：整库导出/导入、备份、保留策略、可选 sqlcipher。
- **M6 发布硬化**：真机矩阵、capability 终检、附录 B 十项签署、RC。

### 5.4 设计文档回写（M6 前必须完成）

计划 §11.4 已登记两项欠账，M6 前回写 PDF 并升版本：

1. `streamProxy` 的准确定义（HTTP 代理客户端 → 自研 `streamFn` + `invoke` 桥接）。
2. schema v3 的 `conversations / messages / settings` 三表。

---

## 6. 已知偏差与风险

| 项 | 现状 | 处理 |
|---|---|---|
| `grep` 性能 | 仍 LIKE 回退，`fallback=true` | M2 按 D7 接受 <500ms；M1 切 FTS |
| 配额 | 仅前端 `beforeToolCall` 统计 | M6 评估下沉 Rust |
| Keystore | 代码完成，仅桌面文件路径被自动测试覆盖 | M2-10 真机复验 |
| Android 打包 | Windows 无开发者模式时 jniLibs 符号链接失败 | 用 §5.1 的复制 + gradlew 规避 |
| `src-tauri/gen/` | 被 `.gitignore` 忽略 | 新克隆先 `pnpm tauri android init` |
| CI | 远端是局域网裸仓库，Actions 不触发 | 手动跑 §2 命令；或推 GitHub |
| 旧 `notes.db` | 无迁移（BREAKING） | 产品已确认无存量诉求；如需，M5-2 兜底 |

---

## 7. 代码入口索引

| 目的 | 文件 |
|---|---|
| 命令注册表 | `src-tauri/src/lib.rs` |
| Agent 状态/白名单/HTTP 客户端 | `src-tauri/src/agent/mod.rs` |
| LLM 代理与四厂商适配 | `src-tauri/src/agent/llm.rs` |
| 会话与设置表访问 | `src-tauri/src/agent/conversations.rs` |
| 密钥后端（Keystore / 文件） | `src-tauri/src/agent/secrets.rs` |
| Agent 命令 | `src-tauri/src/commands/agent.rs` |
| schema v3 迁移 | `src-tauri/src/db/schema.rs` |
| 5 工具与前端拦截 | `src/agent/tools.ts` |
| streamFn 桥接 | `src/agent/stream.ts` |
| Agent 装配（配额/历史还原） | `src/agent/runtime.ts` |
| System Prompt | `src/agent/prompt.ts` |
| 对话 UI | `src/pages/chat/ChatPage.tsx` |
| 设置页（厂商/模型/Key） | `src/pages/settings/SettingsPage.tsx` |
| Rust 回归测试 | `src-tauri/src/tests.rs`（16 例） |
| 前端协议测试 | `src/agent/protocol.test.ts`（5 例） |

---

## 8. 快速恢复工作环境

```powershell
git checkout refactor/database-layer-virtualfs-wal
git status                    # 应为干净
git log --oneline -4          # 4d80bd3 / 04c013f / 13f263d / a1995c1

pnpm install
pnpm lint; pnpm test; pnpm build

cd src-tauri
cargo fmt --check; cargo clippy --all-targets -- -D warnings; cargo check --all-targets; cargo test
```

> 本交接文档为新增文件，首次提交时随 `docs:` 提交入库；不改变已冻结的能力边界。
