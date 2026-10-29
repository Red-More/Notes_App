# LifeOS 下一步执行计划（v1.2.0 · Agent 优先）

| 项目 | 内容 |
|---|---|
| 文档编号 | LIF-2026-PLAN-001 |
| 版本 | v1.2.0 |
| 编制日期 | 2026-10-29 |
| 依据文档 | `LifeOS_数据库重构与Agent能力扩展设计文档_v1.0.0.pdf`（LIF-2026-DES-001）、`refactoring-sqlite-vfs-pi-agent.md`（PRD） |
| 代码基线 | `b3ea410` feat(vfs): rebuild domain features on generic document layer<br>`da56090` refactor(storage): replace relational notes.db with VirtualFs-backed life.db |
| 适用范围 | DB 层、Agent 工具层、技能层、移动端 UI |
| 排期假设 | 2 人并行（Rust 后端 1 人 + 前端 1 人）；单人执行时按阶段串行，日期整体顺延 |

### 修订历史

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v1.2.0 | 2026-10-29 | 完成 `pi-agent-core@1.4.0` 运行时审查：内置 `streamProxy` 改为自研 `streamFn` + `invoke` 桥接；`fs:default` 提升为 M2 前置门禁（导出不受影响）；补充 Agent 打包体积基线、对话渲染策略与风险项 |
| v1.1.0 | 2026-10-29 | **调整为 Agent 优先**：M2 Agent 闭环前置到 M1 检索之前；FTS 顺延为 Agent MVP 后的检索升级；发布节点保持 12/22 |
| v1.0.0 | 2026-10-29 | 初版：基于两次提交与设计文档建立 M0–M6 执行基线 |

> 本计划是设计文档的落地分解，不改变已冻结的能力边界：**5 个工具、文档即数据、三条安全红线**。任何工具增删、表结构变更、能力边界调整，都必须先回写设计文档并递增版本号。

---

## 0. 一页结论

**当前基线**：存储底座重构已完成——`life.db` 单库 + VirtualFs 五工具 + 通用文档层 + 前端领域映射；但 **FTS5 索引尚未维护、LLM 代理与 Agent 闭环尚未开始、技能系统尚未开始、对话 UI 尚未开始**。

**Agent 优先的可行性结论**：

- `pi-agent-core@1.4.0` 已通过运行时代码审查：dist 无 `node:` 内建导入、无 `eval/new Function`，`pi-telemetry` 无网络代码；`typebox + pi-ai` 依赖可在浏览器打包，根入口实测 52KB gzip。
- 该版本内置的 `streamProxy` 是 **HTTP 代理客户端**（`fetch(proxyUrl/api/stream)` + Bearer token），不能直接使用；M2 改为自研 `streamFn` 经 `invoke('agent_stream')` 桥接，token 永不下发 WebView。
- 5 个工具中的 `grep` 当前走 LIKE 回退，功能可用；Agent MVP 阶段接受 `<500ms`，M1 再提升到 `<200ms`。
- 硬前置共四项：M0 最小质量门、Android debug APK（真机验证）、capability 移除 `fs:default`、LLM 代理 + 会话表。
- **结论：Agent 可以先做，FTS 后置。**

**下一步主线**：

```
质量门(M0) → Agent 闭环(M2) → 检索闭环(M1) → 技能系统(M3) → 体验闭环(M4) → 数据主权(M5) → 发布硬化(M6)
```

**关键节点**：

| 节点 | 日期 | 判定标准 |
|---|---|---|
| 基线校准完成 | 2026-11-05 | CI 双端全绿，Rust 核心回归测试可执行，Android debug APK 可启动，capability 无 `fs:default` |
| Agent MVP 完成 | 2026-11-17 | 真机一句话记录落盘，5 工具越狱清单全拦，Agent chunk 体积达标 |
| 检索闭环完成 | 2026-11-24 | 千条笔记 grep 首屏 < 200ms，中文短词可用 |
| 技能 v1 完成 | 2026-12-01 | “复盘今天”端到端产出复盘章节 |
| 体验闭环完成 | 2026-12-08 | 对话内可回滚版本，离线/取消不丢草稿 |
| 数据主权完成 | 2026-12-15 | 导出 → 清库 → 导入，数据/索引/版本一致 |
| 发布候选 | 2026-12-22 | 红线检查表 10 项全部签署 |

**pi-agent-core 运行时审查结论（2026-10-29）**：

| 项 | 结论 |
|---|---|
| 包内实现 | `dist` 无 `node:` 内建导入、无 `eval/new Function`；`pi-telemetry` 仅内存/noop 实现，无 fetch/http |
| 内置 `streamProxy` | HTTP 代理客户端（向 `<proxyUrl>/api/stream` 发起 fetch，并携带 Bearer token），与红线②冲突，改为 `invoke` 桥接 |
| 打包体积 | 根入口（agent + pi-ai + typebox）193KB min / **52KB gzip**；`providers/all` 1.94MB min / 310KB gzip，禁止使用 |
| 渲染职责 | pi-agent 无 UI、无 Markdown 渲染，只发 `AgentEvent`（`message_update/tool_execution_*`）；渲染策略由前端决定 |

> `streamProxy` 的准确定义以本节及 v1.2.0 修订为准；设计文档 PDF（LIF-2026-DES-001）§3.2/术语表中“自定义传输适配器”的表述待下一版回写。

---

## 1. 基线快照

### 1.1 已完成，可直接复用（不重做）

| 模块 | 状态 | 代码证据 | 说明 |
|---|---|---|---|
| 单库 `life.db` + WAL | ✅ 完成 | `src-tauri/src/db/mod.rs`、`db/wal.rs` | 启动 `integrity_check` + TRUNCATE checkpoint，损坏只告警不阻塞 |
| Schema v1/v2 | ✅ 完成 | `db/schema.rs`（`SCHEMA_VERSION = 2`） | `inodes / blobs / meta / fts_docs` + `version_meta / index_entries / path_acl`，含默认 `/life` 目录 |
| VirtualFs 五操作 | ✅ 完成 | `vfs/mod.rs` | `read / write / edit / glob / grep`；写即追加 rev；`edit` 带 `expect_rev` 乐观锁 |
| CapGate | ✅ 完成 | `vfs/cap_gate.rs` | 路径规范化锁 `/life`，拒绝 `..`、越界绝对路径、控制字符；`.agents` 只读；文件 ≤1MB、glob ≤200、grep ≤200 |
| 通用文档层 | ✅ 完成 | `docs/mod.rs` | `doc_list/get/create/save/delete/restore/purge/empty_trash/set_pinned/move` |
| 文件夹/版本/导出/索引 | ✅ 完成 | `docs/folders.rs`、`versions.rs`、`export.rs`、`index.rs` | 版本恢复追加新 rev；导出单文件/多文件 ZIP；交叉索引 `type/date/time/due/location/person/tag` |
| 前端领域映射 | ✅ 完成 | `src/api.ts`（`docApi`） | Note/Todo/Schedule/Contact/Folder DTO 全部映射到通用文档接口；旧关系型 invoke 已移除 |
| 前端工程门禁 | ✅ 通过 | `pnpm lint / test / build` | 提交记录已声明通过 |
| CI 骨架 | ✅ 已配置 | `.github/workflows/ci.yml` | 前端 lint/test/build + 后端 `cargo test` |

### 1.2 未完成或有缺口（下一步必须处理）

| 缺口 | 影响 | 代码证据 |
|---|---|---|
| Rust 本地无法编译 | 仅 CI 能作为编译门禁，本地开发反馈慢 | 当前环境无 `cargo/rustc`；提交记录亦注明 CPU 指令兼容性问题 |
| Rust 回归测试为 0 | `cargo test` 实际无断言，重构风险不可控 | `src-tauri/src` 无 `#[cfg(test)]` |
| FTS5 只建表未维护 | `grep` 恒走 `instr/LIKE` 回退，`fallback=true`；千条性能与排序弱 | `vfs/mod.rs#grep`、`db/schema.rs` 注释“P2 接入” |
| `grep` 缺 `type` 过滤 | 无法按 `note/todo/contact` 限定搜索，与设计契约不一致 | `vfs/types.rs::GrepRequest` 仅 4 参数 |
| ACL 仅预留 | `path_acl` 表存在但恒放行 | `vfs/acl.rs` 的 `ensure_allowed` 直接 `Ok(())` |
| Agent/LLM 完全未接入 | 无对话、无流式、无工具调用 | 无 `reqwest`、无 `@earendil-works/pi-agent-core`、无 `agent_stream` |
| 会话持久化缺表 | PRD 要求会话/消息落库，schema 无 `conversations/messages` | `db/schema.rs` 仅 7 个对象 |
| 技能系统未开始 | 无扫描、解析、注入、开关 | `/life/.agents/skills` 目录已建，无 loader |
| 对话 UI 未开始 | 前端仅笔记/待办/日程/人脉 4 个 Tab | `src/App.tsx` |
| 导入/备份/加密未开始 | 仅能导出，不能恢复；无 sqlcipher | `docs/export.rs`、`Cargo.toml` |
| 回收站无 30 天自动清理 | 数据只增不减 | `docs/mod.rs::delete_many` 仅软删 |
| `source` 语义不一致 | `fs_write` 恒记 `user` 且 `is_manual=1`；`fs_edit` 恒记 `agent` | `vfs/mod.rs::write/edit` |
| capability 含 `fs:default` | 与设计“不给 fs:default”红线冲突；该权限可让被注入的 WebView 递归读取应用私有目录（含 `life.db`），绕过 VirtualFs | `src-tauri/capabilities/default.json`；导出写盘在 Rust 侧完成，移除不影响导出 |
| 旧 `notes.db` 不做迁移 | 有意为之，但需产品确认无存量用户数据诉求 | 提交 `d205ec6` BREAKING CHANGE |
| Android 工程未初始化 | 无 `src-tauri/gen/android`，mobile-first 构建路径未验证 | `src-tauri` 目录无 `gen/android`；`tauri.conf.json` 仅配置桌面窗口 |

---

## 2. 核心目标与不可偏离的边界

### 2.1 核心目标 → 计划落点

| 设计目标 | 可验证指标 | 本计划落点 |
|---|---|---|
| 数据即文档 | 任一笔记/待办/联系人是单个 Markdown，可人工读、可导出 | 已达成；M5 补齐整库导出/导入 |
| 秒级检索 | 千条笔记 grep 首屏 < 200ms | Agent MVP 先以 LIKE 回退满足 `<500ms`；M1 再提升到 `<200ms` |
| 误删可救 | 任意内容保留全量 rev，可回滚 | 底座已达成；M4 暴露回滚入口，M5 定保留策略 |
| 模型不越界 | 工具表外字符串不可见；红队注入不逃逸 | M0 测试 + M2 工具绑定 + M6 红线验收 |
| 可扩展 | 新能力 = 加一个 `SKILL.md`，零 Rust 改动 | M3 |

### 2.2 三条不可谈判红线（全程验收项）

1. 模型永远拿不到 shell / bash，工具注册表中物理不存在该字符串。
2. 模型只走一条网络出口（LLM API），密钥永不下发 WebView。
3. 所有“文件”都是 SQLite 虚拟节点，真实文件系统对模型不可见。

### 2.3 Anti-Goals（本计划不启动）

`bash/shell`、`notebook`、`task` 后台任务、`web_search/webfetch`、真实 FS 访问、动态 JS 执行、语义向量/RAG、多 Agent、多人协作/云端同步。仅当出现明确用户痛点且回写设计文档后，才进入“P7 再说”。

---

## 3. 与已完成模块的衔接关系

| 已完成能力 | 下一步消费者 | 衔接动作 | 阶段 |
|---|---|---|---|
| `inodes/blobs/head_rev` | Agent 五工具 | `read/write/edit/glob/grep` 直接绑定 `fs_*` 命令；不新增工具、不把 `doc_*` 暴露给模型 | M2 |
| `meta` 镜像 + `index_entries` | 结构化查询、人物聚合 | 保持 `write/edit/doc_save/version_restore` 同事务刷新；`grep` 增加 `type` 过滤复用 `meta.kind` | M1/M2 |
| `version_meta` | 对话内撤销、版本历史 | 统一 `source` 语义；自动写入（user/agent）不标手工版本，仅显式快照置 `is_manual=1`；UI 对全部文档类型开放版本入口 | M0/M4 |
| `path_acl`（预留表） | 未来扩展/技能写权限 | v1 继续预留，不强制；仅保留 `acl::ensure_allowed` 钩子，避免业务层散落判断 | M6 复核 |
| `fs_*` 五命令 | Agent 工具层 | 工具 schema 与 Rust 入参一一对应；服务端 CapGate 二次校验，不信任前端 | M2 |
| `doc_*` 通用文档层 | 笔记/待办/日程/人脉 UI | 继续作为 UI 唯一写入口；与 Agent 写入共用同一套 meta/index/version 维护 | M4 |
| `folder/version/export/index_query` | UI 与数据主权 | 导出扩展为“整库目录树 ZIP”；导入复用 frontmatter 解析 | M5 |
| `docApi` 前端映射 | 对话页“打开笔记” | 复用 DTO 映射，不重写领域层 | M4 |
| CapGate `.agents` 只读 | 技能管理 | 模型不能写技能目录；技能安装/开关走**专用 Rust command**（非 `fs_write`） | M3 |
| 导出命令（dialog + fs 插件） | capability 收口 | 移除 `fs:default`，保留 `dialog:default` 与 Rust 侧 `FsExt` 写入；已确认前端零 `plugin-fs` 调用，导出不依赖 WebView fs 权限 | M0/M2 |

---

## 4. 总体路线图

> **执行顺序：M0 → M2 → M1 → M3 → M4 → M5 → M6。** 任务编号保留原归属（M1=检索、M2=Agent），但实际执行以本表顺序为准。

| 执行序 | 阶段 | 日期 | 目标 | 关键交付物 | 优先级 | 退出标准 |
|---|---|---|---|---|---|---|
| 1 | **M0 基线校准** | 10/30–11/05 | 建立可编译、可回归、可发版的质量门 | CI 强化、Rust 核心测试、source 语义、capability 收口（移除 `fs:default`）、Android 工程、v0.1.0 基线 | P0 | CI 双端全绿；核心回归用例通过；Android debug APK 可启动；capability 无 `fs:default` |
| 2 | **M2 Agent 闭环** | 11/06–11/17 | 打通“说话 → 工具 → 落盘 → 回显” | LLM 代理、Keystore、会话表、pi-agent-core、5 工具绑定、对话 UI、system prompt | P0 | 真机一句话记录成功；越狱清单全拦；断网不崩；grep 可接受 LIKE 回退；Agent chunk 达标 |
| 3 | **M1 检索闭环** | 11/18–11/24 | 把 Agent 的检索质量与性能补齐 | FTS5 同事务维护、`grep` FTS + type 过滤、千条种子性能报告 | P0 | 千条笔记 grep < 200ms；索引与 blobs 一致 |
| 4 | **M3 技能系统** | 11/25–12/01 | 用技能放大同一套工具 | SKILL.md 规范、扫描注入、6 个内置技能、技能管理 UI | P1 | “复盘今天”端到端；卸载后不再套用 |
| 5 | **M4 体验闭环** | 12/02–12/08 | 达到可用级 App | 工具卡片、笔记跳转、版本回滚、待办联动、离线三态 | P1 | 15 秒完成一次记录；撤销不丢数据 |
| 6 | **M5 数据主权** | 12/09–12/15 | 数据可带走、可恢复 | 整库目录树导出、ZIP 导入、备份、保留策略、可选加密 | P1/P2 | 导出→清库→导入后数据/索引/版本一致 |
| 7 | **M6 发布硬化** | 12/16–12/22 | 可发布 | 真机矩阵、capability 终检、红线检查表、性能/崩溃、RC | P0 | 设计文档附录 B 十项全部签署 |

---

## 5. 分阶段任务表

> 优先级定义：**P0** = 阻塞后续或安全红线；**P1** = 产品闭环必需；**P2** = 可延后增强。
> 分节按任务归属编号排列；实际执行顺序以第 4 节为准（M0 → M2 → M1 → M3 → M4 → M5 → M6）。

### M0 基线校准（10/30–11/05）

目标：让“已完成”的代码真正可验证，并把 Agent 写入语义提前修正，避免 M2 返工。

| ID | 任务 | 优先级 | 预期成果 | 验收标准 | 目标日 |
|---|---|---|---|---|---|
| M0-1 | CI 强化：增加 `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo check/test`，缓存 Rust 依赖 | P0 | PR 门禁可拦截编译/格式问题 | 故意引入编译错误时 CI 变红；正常 PR 全绿 | 10/31 |
| M0-2 | 补 Rust 回归测试：CapGate 全变体（`..`、越界绝对路径、反斜杠、空/超长路径）、write→edit→read→grep 链路、并发 `expect_rev` Conflict、软删/恢复/物理删、版本恢复、交叉索引刷新 | P0 | `src-tauri` 内可执行的测试集 | `cargo test` 覆盖上述场景并全部通过；虚拟 FS 无符号链接解析入口 | 11/03 |
| M0-3 | 统一写入 `source` 语义：`WriteRequest/EditRequest` 增加 `source`（user/agent）；`fs_*` 固定 agent，`doc_*` 固定 user；`version_meta.is_manual` 仅由显式版本快照置 1 | P0 | Agent 写入不再被误标为手工版本 | 单测断言：fs 写 → `source=agent, is_manual=0`；doc 自动保存 → `source=user, is_manual=0`；`version_create` → `is_manual=1` | 11/03 |
| M0-4 | capability 收口：从 `capabilities/default.json` 移除 `fs:default`，保留 `dialog:default`；确认 WebView 无 `plugin-fs` 调用；记录网络白名单方案 | P0 | 权限最小化 + 导出回归 | capability 无 shell / 无 `fs:default`；单文档 / 多文档 ZIP / 文件夹 ZIP 导出全部回归通过 | 11/04 |
| M0-5 | 基线固化：计划文档入库、README 补运行/验证说明、打 `v0.1.0` 标签 | P1 | 团队可复现的基线 | 新成员按 README 可跑前端测试；标签指向 `b3ea410` 后首个通过提交 | 11/05 |
| M0-6 | Android 工程预检：初始化 `tauri android` 工程，构建 ARM64 debug APK 并安装真机，验证 invoke/dialog/notification 基础链路 | P0 | 移动端构建路径打通 | 真机可启动 App 并完成一次 `doc_list` invoke | 11/05 |

**退出标准**：CI 双端全绿；M0-2 测试在 CI 稳定通过；Android debug APK 可启动；`fs:default` 已移除且导出回归通过。

---

### M1 检索闭环（11/18–11/24）

前置：M2 Agent MVP 完成。FTS 只提升检索质量与性能，不新增工具、不阻塞 Agent 功能。
目标：把 `fts_docs` 从“空表”变成与 `blobs` 同事务一致的检索通道，兑现千条 <200ms。

| ID | 任务 | 优先级 | 预期成果 | 验收标准 | 目标日 |
|---|---|---|---|---|---|
| M1-1 | FTS 同事务维护：`write/edit/doc_save/version_restore` 写入时同步 FTS；软删移出 FTS、恢复重建；`purge/empty_trash` 清理 FTS；启动补建缺失索引。优先应用层同事务写入，不新增触发器（避免历史 rev 重复入索引，schema 保持不变） | P0 | FTS 与可见正文强一致 | 写入成功即可搜到；事务回滚无残留；软删后不可搜、恢复后可搜；清空回收站后无孤儿行 | 11/19 |
| M1-2 | `grep` 切换 FTS5 MATCH：FTS 召回后回正文定位行号与上下文片段；保留 LIKE 回退并如实返回 `fallback`；补 `type` 过滤参数 | P0 | 与设计 5.2 契约对齐 | `fallback=false` 正常路径；无命中时回退；`type=note/todo` 过滤生效 | 11/20 |
| M1-3 | 中文分词决策：用 1000 条种子数据测 `unicode61` 召回；仅当短词召回不可用时才评估 jieba/ICU | P0 | 分词选型记录（ADR 一节） | “日语/复盘/张三”等短词可召回；不引入额外动态库 | 11/21 |
| M1-4 | 千条种子性能基线：生成 1000 篇混合类型文档，测 grep 首屏、`index_query`、目录列举 | P0 | 性能报告（P50/P95） | grep 首屏 < 200ms；`index_query` < 100ms | 11/22 |
| M1-5 | 索引一致性巡检：扩展启动检查，FTS 行数/关键样本与 `blobs head_rev` 对齐；提供手动重建入口 | P1 | 可自愈的检索索引 | 人为删 FTS 行后重启可恢复 | 11/23 |
| M1-6 | UI 全局搜索接入 `grep`（替换当前 `doc_list` 的 `instr` 搜索） | P2 | 搜索质量与后端一致 | 搜索页命中高亮、空结果与回退提示正确 | 11/24 |

**退出标准**：FTS 与正文同事务；千条性能达标；中文短词决策落地；Agent 的 `grep` 切到 FTS 后回归通过。

---

### M2 Agent 闭环（11/06–11/17）

前置：M0-6 Android debug APK 可安装；M0-4 已移除 `fs:default`。FTS 不阻塞 Agent：`grep` 暂走 LIKE 回退（`fallback=true`），M1 再升级。
目标：用户说一句话，Agent 通过 5 个工具完成落盘并流式回显；密钥不出 Rust。

| ID | 任务 | 优先级 | 预期成果 | 验收标准 | 目标日 |
|---|---|---|---|---|---|
| M2-1 | 可行性 spike：验证 `pi-agent-core@1.4.0` 浏览器打包与 TypeBox schema；**不使用内置 `streamProxy`**（其实现为 HTTP fetch + Bearer token），改为自研 `streamFn` 经 `invoke('agent_stream')` 桥接；验证 Android Keystore 插件候选；记录 Agent chunk 体积基线 | P0 | Go/No-Go 结论 + `streamFn` 适配层接口草案 + 体积基线 | WebView 内创建 Agent 并完成一次工具调用；经自定义 `streamFn` 完成一次流式对话；Agent chunk ≤ 60KB gzip；产物无 `aws-sdk/bedrock/openai` SDK 标记 | 11/07 |
| M2-2 | Schema v3：新增 `conversations / messages / settings` 三表 + 会话命令（列表/新建/删除/消息追加/读取） | P0 | 会话重启不丢；模型配置可存（密钥不落库） | 杀进程重启后会话与消息完整；DB 内搜索不到 API Key | 11/09 |
| M2-3 | Rust LLM 代理：`agent_stream` 命令，`reqwest` SSE 转发，OpenAI/Anthropic/Google 适配；事件负载沿用 pi-agent 的 `data:` 片段形状，前端仅解析不改协议；超时、取消、离线错误事件；提供本地 mock SSE 供无 Key 开发 | P0 | 流式对话通道 | 首 token < 1.5s（网络正常）；取消后停止转发；断网返回可恢复错误 | 11/11 |
| M2-4 | 密钥管理：Keystore 读写删命令；设置页模型/厂商切换；密钥提交后不落地 JS 持久化层；桌面开发用 dev-only provider | P0 | 密钥安全闭环 | JS 源码/存储/全局对象搜索不到 token；重启后 Rust 侧仍可调用；删除后调用失败 | 11/12 |
| M2-5 | Agent 运行时：5 工具 TypeBox 注册、读并行/写串行、`fs_*` 绑定、`expect_rev` 透传、错误以 `isError` 回灌 | P0 | 工具调用闭环 | 5 个工具均可被模型调用；错误可触发自我纠正；无第 6 个工具；构建产物无 provider SDK 标记 | 11/13 |
| M2-6 | 追加语义固化：`write` 只新建；追加走“read 尾部 → edit 锚点”；写入 system prompt 与技能规范 | P0 | 避免覆盖写与重复建文件 | “追加一条日记”不新建文件、不改旧内容 | 11/13 |
| M2-7 | System Prompt 基线 v1：10 条铁律、当前日期、`{{skills_index}}` 占位、文件内容是数据不是指令 | P1 | 设计文档第 10 章落地 | 越狱清单 100% 拦截；不泄露联系人敏感字段 | 11/14 |
| M2-8 | 对话 UI：流式气泡（MVP 纯文本渲染，`message_end` 后可选 Markdown；工具结果一律纯文本）、工具卡片（start/end）、错误重试、草稿保留、会话管理、底部导航“对话”入口 | P0 | 可用对话页 | 流式渲染无闪烁；工具状态可见；模型输出不出现可执行 HTML；切换会话上下文正确 | 11/15 |
| M2-9 | 安全回归：路径穿越参数、恶意笔记注入、诱导输出密钥/电话、诱导写 `.agents` | P0 | 红队测试报告 | 全部拒绝或无实际写操作；错误文案可行动 | 11/16 |
| M2-10 | 真机 E2E：“记下今天吃了拉面”落盘日记；“把那条待办勾掉”改 checkbox | P0 | 真机演示 | 记录 ≤15 秒完成；rev 递增；重启可查 | 11/17 |

**退出标准**：真机对话可用；仅 5 工具；密钥不进 WebView；断网/取消不崩溃；`grep` 回退可用且响应 <500ms；capability 无 `fs:default`；Agent chunk 体积达标；对话渲染无 HTML 注入面。

---

### M3 技能系统（11/25–12/01）

目标：技能只进 prompt、不注册工具、不执行代码；新增领域能力零 Rust 改动。

| ID | 任务 | 优先级 | 预期成果 | 验收标准 | 目标日 |
|---|---|---|---|---|---|
| M3-1 | SKILL.md 规范与解析：frontmatter `name/description/triggers/scope/version`，正文按需读取 | P1 | 技能格式定稿 | 非法 frontmatter 不导致启动失败 | 11/26 |
| M3-2 | 发现与注入：启动扫描 `/life/.agents/skills/*/SKILL.md`，初始 prompt 只注入摘要；触发后读正文 | P1 | 轻量索引 + 按需展开 | 初始 prompt 不含技能正文；触发后正文进入上下文 | 11/27 |
| M3-3 | 内置 6 技能：`daily-review / contact-manager / study-planner / trip-planner / weekly-review / note-taking` | P1 | 随包技能包 | 每个技能有明确触发词与工作流 | 11/29 |
| M3-4 | 技能管理：列表、启用开关、卸载（删目录）、自定义创建；状态存 `settings`；写 `.agents` 走专用命令 | P1 | 技能页可用 | 模型无法写 `.agents`；UI 可正常安装/卸载 | 11/30 |
| M3-5 | E2E：“复盘今天”产出 `## 复盘` 小节并补明日待办 | P1 | 技能演示 | 四步流程不跳步；明日待办不编造 | 12/01 |
| M3-6 | 恶意技能测试：伪造“注册 bash 工具/读取密钥”的 SKILL.md | P1 | 安全结论 | 不新增工具、不执行、不越权 | 12/01 |

**退出标准**：6 技能可用；开关生效；技能正文不进初始 prompt。

---

### M4 体验闭环（12/02–12/08）

目标：从“能跑”到“顺手”；复用已有 `version_meta` 与 `docApi`，不重做底座。

| ID | 任务 | 优先级 | 预期成果 | 验收标准 | 目标日 |
|---|---|---|---|---|---|
| M4-1 | 工具卡片美化：可展开参数/结果、错误标红、可重试 | P1 | 对话可读性 | 长结果折叠；错误可一键重试 | 12/03 |
| M4-2 | 对话内跳转笔记：按 path/id 打开预览，复用 `docApi.get` | P1 | 对话与文档联动 | 点击工具结果可打开对应文档 | 12/04 |
| M4-3 | 版本回滚入口：对话消息与文档详情均可恢复上一 rev；覆盖全部文档类型 | P1 | 撤销闭环 | 恢复追加新 rev，历史不丢；FTS/meta/索引同步 | 12/05 |
| M4-4 | 待办勾选联动：UI 勾选与 Agent edit 双向一致，`meta.status` 同步 | P1 | 状态一致性 | 勾选后搜索/索引立即可见 | 12/06 |
| M4-5 | 离线/超时/取消三态 UI：不丢草稿、保留最后成功状态 | P1 | 移动端弱网体验 | 飞行模式提示明确；恢复后可继续 | 12/07 |
| M4-6 | 性能与启动：冷启动 < 2s、工具调用 < 100ms、列表首屏优化 | P2 | 性能报告 | 中端真机达标 | 12/08 |

**退出标准**：15 秒完成一次记录；回滚不丢数据、不破坏索引。

---

### M5 数据主权（12/09–12/15）

目标：数据可带走、可恢复；导出产物普通编辑器可读。

| ID | 任务 | 优先级 | 预期成果 | 验收标准 | 目标日 |
|---|---|---|---|---|---|
| M5-1 | 整库目录树导出：按 `/life/` 结构导出全部类型 Markdown + frontmatter | P1 | 可读的目录树 ZIP | 解压后目录与虚拟 FS 一致；无 id 前缀污染文件名 | 12/10 |
| M5-2 | ZIP 导入：解析 frontmatter，按类型落库；冲突策略（跳过/重命名/覆盖）可配置 | P1 | 恢复通道 | 重复导入幂等；冲突有明确提示 | 12/12 |
| M5-3 | 备份：手动备份到手机存储；WebDAV 作为可选 | P2 | 备份入口 | 备份文件可被 M5-2 导入 | 12/13 |
| M5-4 | 保留策略：回收站 30 天自动物理清理；旧 rev 清理（保留 head + 手工版本 + 最近 N 个自动版本）；VACUUM | P1 | 存储可控 | 清理后检索/版本仍正确；默认不删手工版本 | 12/14 |
| M5-5 | 可选加密：`sqlcipher` feature + Keystore 密钥 + 迁移/回滚方案 | P2 | 加密开关 | 开关切换不丢库；无密钥无法打开 | 12/15 |
| M5-6 | 往返测试：导出 → 清库 → 导入 → 比对文档/索引/版本 | P1 | 数据主权验收 | 文档数、rev、索引查询结果一致 | 12/15 |

**退出标准**：导出可读、导入可恢复、清理不误删。

---

### M6 发布硬化（12/16–12/22）

目标：按设计文档附录 B 逐项签署，产出 RC。

| ID | 任务 | 优先级 | 预期成果 | 验收标准 | 目标日 |
|---|---|---|---|---|---|
| M6-1 | Android 10+ / ARM64 真机矩阵：安装、SSE、通知、Keystore、导出 | P0 | 兼容性报告 | 目标机型全部通过核心路径 | 12/18 |
| M6-2 | capability 终检：无 `shell:allow-exec`、无 `fs:default`；WebView CSP `connect-src` 仅 `self/ipc`（现状已满足）；外部网络仅 Rust LLM 代理；无遥测 | P0 | 权限清单 | 逐项截图/配置 diff 留档 | 12/19 |
| M6-3 | 红线检查表签署（附录 B 十项） | P0 | 签署记录 | 10/10 通过，缺一不发版 | 12/20 |
| M6-4 | 性能/崩溃：启动、工具延迟、搜索、崩溃率；日志轮转 | P0 | 发布性能报告 | 崩溃率 < 0.1%；指标达标 | 12/21 |
| M6-5 | RC 打包与回滚预案；版本标签 | P0 | 可发布 APK | 安装/升级/回滚演练通过 | 12/22 |

**退出标准**：RC 签署；发布检查表归档。

---

### P7 明确暂不启动

`task` 索引任务、向量检索、联网模式、多端同步、多 Agent。启动条件：有明确用户痛点 + 回写设计文档第 11 章 + 版本号递增。

---

## 6. 验收红线（设计文档附录 B 映射）

| # | 红线 | 验收阶段 | 验证方式 |
|---|---|---|---|
| 1 | capability 无 `shell:allow-exec`、无 `fs:default` | M0/M2/M6 | 配置 diff + 全局 grep |
| 2 | 网络白名单仅 LLM 域名，WebView 直连被拒 | M2/M6 | CSP 配置审查 + 抓包 |
| 3 | 工具注册表无 `bash/task/notebook/web/fetch` 字样 | M2 | 注册表快照测试 |
| 4 | CapGate 覆盖 `..`、越界绝对路径、反斜杠、空路径、超长路径（虚拟 FS 无符号链接入口） | M0 | 单元测试 |
| 5 | `edit` 并发 Conflict 可回放，前端提示“内容已变” | M0/M2/M4 | 并发测试 + UI 演示 |
| 6 | FTS 与 blobs 同事务：写入可见、回滚无残留 | M1 | 事务回滚测试 |
| 7 | 密钥仅存 Keystore，JS 侧搜不到 token | M2 | 全局搜索 + 存储检查 |
| 8 | 技能正文不进初始 prompt；恶意 SKILL.md 不新增工具 | M3 | prompt 快照 + 恶意样本 |
| 9 | 离线/超时/取消三态不丢草稿 | M2/M4 | 飞行模式真机测试 |
| 10 | 导出产物可被普通 Markdown 编辑器打开 | M5 | 桌面端打开验证 |

---

## 7. 风险与应对

| 风险 | 影响 | 应对 | 责任阶段 |
|---|---|---|---|
| 本地无 Rust 工具链，编译反馈依赖 CI | 开发效率与合并阻塞 | M0-1 强化 CI；统一团队 rustup 版本；必要时提供 Docker 构建环境 | M0 |
| Android 工程与工具链未验证 | 移动端 E2E 阻塞，M2/M6 无真机可测 | M0-6 提前初始化并跑通 debug APK；CI 增加 Android 构建任务 | M0 |
| `pi-agent-core` 浏览器兼容/API 变动 | Agent 层返工 | 1.4.0 实测无 `node:` 内建导入、无 `eval`，浏览器打包通过；M2-1 先验证实例创建与工具调用；Rust 侧保持 `agent_stream` 稳定契约 | M2 |
| 内置 `streamProxy` 是 HTTP 代理客户端 | 直接把 token 放进 WebView，违反红线②，并被 CSP 拦截 | 不使用内置 `streamProxy`；M2-1 自研 `streamFn` 经 `invoke` 桥接，只复用其事件解析 | M2 |
| 误 import `providers/all` 导致包体膨胀 | APK 增大且引入 Node SDK 依赖 | Agent 仅 import 根入口；M2-1 记录体积基线，CI 检查产物无 SDK 标记；core 实测 52KB gzip | M2 |
| Agent 先行期间 `grep` 仍为 LIKE 回退 | 千条以上检索可能超过 200ms | M2 接受 `<500ms`；响应标注 `fallback=true`；M1 在 7 天内切 FTS | M2/M1 |
| Android Keystore 插件不成熟 | 密钥方案受阻 | spike 两个候选；失败则原生 JNI 封装，接口不变 | M2 |
| FTS5 中文短词召回不足 | 搜索体验差 | 千条种子实测；先 LIKE 回退，确需再评估 jieba/ICU | M1 |
| `fs:default` 移除影响导出 | 功能回归 | 已确认导出写盘走 Rust `FsExt`、前端零 `plugin-fs` 调用，移除不影响；M0-4 做全量导出回归 | M0/M2 |
| 对话渲染 XSS | 模型输出注入到 WebView | MVP 纯文本流式，`message_end` 后可选 Markdown 且 `html:false`；禁止用 `dangerouslySetInnerHTML` 接原始模型文本 | M2/M6 |
| 新增 `conversations/messages/settings` 表偏离设计文档 | 基线不一致 | 按变更规则回写设计文档第 4 章并升版本（M1 不变 schema 时为 v3；若 M1 引入触发器则 M2 顺延 v4） | M2 |
| 版本历史无限增长 | 存储膨胀 | M5-4 保留策略：head + 手工 + 最近 N 个自动版本 | M5 |
| 单 `Mutex<VirtualFs>` 串行化 | 高并发工具调用排队 | 工具调用短事务；流式期间不持锁；M1/M4 性能实测 | M1/M4 |
| 旧 `notes.db` 无迁移 | 存量用户数据丢失 | 确认无存量用户；若有，M5-2 提供一次性导入 | M5 |

---

## 8. 待决策事项（需项目负责人确认）

| # | 决策 | 建议 | 截止 |
|---|---|---|---|
| D1 | 排期假设是否为 2 人并行 | 按 2 人排；单人则整体顺延 | M0 启动前 |
| D2 | 会话存储方案 | 新增 `conversations/messages` 关系表（非文档），符合 PRD 且查询高效 | M2-2 前 |
| D3 | Keystore 实现 | 优先成熟 Tauri 插件；无合适插件则 JNI 封装 | M2-1 后 |
| D4 | 导入冲突策略 | 默认“重命名”，提供“跳过/覆盖”选项 | M5-2 前 |
| D5 | sqlcipher 是否进 v1 | 建议先做 feature 开关，不阻塞首发 | M5-5 前 |
| D6 | `path_acl` 是否 v1 强制 | 建议 v1 仅预留，技能/扩展需要时再启用 | M6 前 |
| D7 | Agent MVP 的检索接受标准 | 接受 LIKE 回退 `<500ms`，M1 再提升到 `<200ms` | M2-3 前 |
| D8 | Agent 流式传输实现 | 自研 `streamFn` + `invoke` 桥接，禁用内置 `streamProxy` | M2-1 前 |
| D9 | 对话渲染策略 | MVP 纯文本流式，`message_end` 后可选 Markdown（`html:false`） | M2-8 前 |

---

## 9. 执行与变更管理

1. **周节奏**：每周五更新本计划状态（未开始/进行中/完成/阻塞），偏差 >3 天需在周报说明。
2. **完成定义（DoD）**：代码 + 测试 + 文档 + 可演示，四项缺一不算完成。
3. **设计文档联动**：工具增删、表结构变更、能力边界调整 → 同步更新设计文档第 4/5/11 章并递增版本号；本计划随之更新。
4. **提交规范**：沿用 `feat/fix/refactor/docs/test` 前缀，模块范围写在标题括号内（如 `feat(agent): ...`）。
5. **安全回归常驻**：M2-9 的红队用例纳入 CI 前置清单，后续每个阶段发版前重跑。

---

— LifeOS · LIF-2026-PLAN-001 v1.2.0 · Agent 优先执行基线 —
