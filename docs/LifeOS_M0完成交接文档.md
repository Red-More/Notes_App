# LifeOS M0 完成交接文档

| 项目 | 内容 |
|---|---|
| 交接日期 | 2026-10-29 |
| 当前分支 | `refactor/database-layer-virtualfs-wal` |
| 基线提交 | `99718069cf5db7c689e43851a1f1a4f6caa14e87`（`test(m0): add rust regression suite and baseline quality gates`） |
| 基线标签 | `v0.1.0`（annotated，指向上述提交） |
| 依据计划 | [LifeOS 下一步执行计划 v1.3.0](./LifeOS_下一步执行计划_v1.3.0.md) |
| 下一阶段 | **M2 Agent 闭环**（按计划执行序 `M0 → M2 → M1 → M3 → M4 → M5 → M6`） |

> 一句话：M0 已全部完成并在真机验证；不要重做 M0。当前代码可直接作为 M2 的起点。

---

## 1. 交接结论

- M0 六项任务全部完成：CI 强化、Rust 回归测试、写入 source 语义、capability 收口、README 基线、Android 真机验证。
- 工作区干净，基线已打 `v0.1.0` 标签。
- `life.db` schema 仍为 **v2**，未新增表；M2-2 才引入 v3（`conversations / messages / settings`）。
- 5 个 `fs_*` 工具已可用，但**尚无 Agent 运行时、无 LLM 代理、无会话表、无对话 UI**。
- 下一步从 **M2-1 可行性 spike** 开始，不要先做 M1 的 FTS。

---

## 2. 当前环境与版本

| 项 | 值 |
|---|---|
| Rust | `cargo 1.98.1` / `rustc 1.98.1` |
| Node / pnpm | Node `v24.19.0` / pnpm `12.4.1` |
| Android | SDK `android-36`、`android-37.0`；NDK `26.2.11394342`；JDK `25` |
| 真机 | `e0a292bc1223`（ARM64，USB 连接） |
| Git 远端 | `lan //MYLinuxPC/Documents/Git_Bare/Note_app.git`（局域网裸仓库，**非 GitHub**） |

### 2.1 环境注意事项

1. **CI 尚未实际运行**：`.github/workflows/ci.yml` 已强化，但当前远端是局域网裸仓库，不会触发 GitHub Actions。交接后的第一次推送不会自动执行该工作流；如需真实 CI，需推送到 GitHub 或手动跑同等命令。本地已验证全绿。
2. **Windows 无开发者模式时 Android 打包**：`pnpm tauri android build --debug --target aarch64` 会在创建 `jniLibs` 符号链接处失败（`Administrator privilege required`）。Rust 与前端的构建已完成，用 README 中的规避方式继续打包：
   ```powershell
   Copy-Item src-tauri/target/aarch64-linux-android/debug/libapp_lib.so `
     src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libapp_lib.so -Force
   cd src-tauri/gen/android
   .\gradlew.bat :app:assembleArm64Debug -x :app:rustBuildArm64Debug
   ```
3. **`src-tauri/gen/` 被 `.gitignore` 忽略**：新克隆需先 `pnpm tauri android init`，再按 README 构建。签名材料 `keystore.properties` / `keystore.jks` 只在本地，不入库。
4. **设备残留测试数据**：调试包里保留了一条测试笔记 `M0devicecheck`（内容 `invoke ok`），用于验证重启后 `doc_list` 仍能读出。清理可执行 `adb shell pm clear com.mynotes.desktop.debug`。
5. **系统返回键行为**：编辑器内按 Android 返回键会把 App 切到后台，而不是回到列表；验证 UI 时使用 App 内左上角返回箭头。

---

## 3. M0 交付明细

| ID | 结果 | 关键文件 / 证据 |
|---|---|---|
| M0-1 | CI 增加 `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo check --all-targets`、`cargo test`，并接入 Rust 依赖缓存 | `.github/workflows/ci.yml` |
| M0-2 | 新增 8 个内存数据库回归测试，`cargo test` 8/8 通过 | `src-tauri/src/tests.rs`；`src-tauri/src/lib.rs` 的 `#[cfg(test)] mod tests;` |
| M0-3 | 统一写入 source 语义：`fs_*` 固定 `agent`，`doc_*` 固定 `user`；自动写入 `is_manual=0`，仅 `version_create` 置 1 | `src-tauri/src/vfs/types.rs`、`src-tauri/src/vfs/mod.rs`、`src-tauri/src/commands/fs.rs`、`src-tauri/src/docs/mod.rs` |
| M0-4 | capability 移除 `fs:default`；保留 `dialog:default`；导出仍由 Rust 侧 `FsExt` 写盘 | `src-tauri/capabilities/default.json`、`src-tauri/src/commands/export.rs` |
| M0-5 | README 补齐环境、运行、验证、Android 与安全边界说明；基线打标签 | `README.md`、`v0.1.0` |
| M0-6 | ARM64 debug APK 构建、签名、安装、启动、`doc_list` invoke 全部真机通过 | APK：`src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk` |

### 3.1 M0-2 测试覆盖

`src-tauri/src/tests.rs` 中的 8 个用例：

1. `cap_gate_rejects_unsafe_paths` — `..`、越界绝对路径、反斜杠、空/控制字符、超长段/超长路径、`.agents` 只读。
2. `write_edit_read_grep_roundtrip` — `write → read → edit → grep` 链路、rev 递增、`fallback=true`。
3. `edit_expect_rev_rejects_stale_revision` — 过期 `expect_rev` 返回 `Conflict { current, expect }`。
4. `soft_delete_restore_and_purge` — 软删不可读、回收站可见、恢复可读、物理删除级联清空 blobs。
5. `version_restore_appends_new_revision` — 版本恢复追加新 rev、历史不丢、恢复版本 `is_manual=1`。
6. `cross_index_refreshes_on_write_and_save` — `personId / tags / dueDate` 索引随写入与保存刷新，移除字段后旧索引行消失。
7. `export_markdown_and_zip_regression` — 单文档 Markdown、多文档 ZIP、文件夹 ZIP。
8. `write_source_semantics` — `fs` 写 `source=agent, is_manual=0`；`doc_create/doc_save` `source=user, is_manual=0`；`version_create` `is_manual=1`。

### 3.2 source 语义细节（M2 会直接消费）

- `WriteSource` 只有 `User` / `Agent`，序列化值为 `"user"` / `"agent"`。
- `fs_write` / `fs_edit` command 固定传 `WriteSource::Agent`。
- `docs::create` 固定传 `WriteSource::User`；`docs::save`、`versions::create/restore` 仍直接写 SQL，source 为 `"user"`。
- `record_version` 现在恒写 `is_manual=0`；手工快照只由 `versions::create` 产生。
- 历史库升级时 v2 迁移会把每条文档最早 rev 置 `is_manual=1`，这是既有行为，不是 bug。

### 3.3 capability 现状

`src-tauri/capabilities/default.json` 当前权限：

```text
core:default
dialog:default
notification:default
log:default
opener:default
```

- 无 `fs:default`、无 `shell:allow-exec`。
- Rust 侧仍注册 `tauri_plugin_fs::init()`，仅供 `FsExt` 导出写盘使用；WebView 没有 fs 权限。
- 前端只有 `@tauri-apps/plugin-dialog` 的 `save()` 调用；`@tauri-apps/plugin-fs` 仍在 `package.json` 中但无任何 import。后续不要因为“看起来没用”就删除 Rust 插件，否则导出会坏。

---

## 4. 已验证结果（可作为基线复跑）

```powershell
# 后端
cd src-tauri
cargo fmt --check                          # 通过
cargo clippy --all-targets -- -D warnings  # 通过
cargo check --all-targets                  # 通过
cargo test                                 # 8 passed

# 前端
pnpm lint                                  # 0 warnings / 0 errors
pnpm test                                  # 117 passed
pnpm build                                 # 成功
```

真机验证记录：

- `adb install -r .../app-arm64-debug.apk` → `Success`
- `adb shell am start -n com.mynotes.desktop.debug/com.mynotes.desktop.MainActivity` → 前台 Activity
- 新建笔记 `M0devicecheck` → 编辑器显示“已保存”
- `adb shell am force-stop ...` 后重启 → 列表仍显示该笔记，证明 `doc_list` 命中 `life.db` 持久化数据

未做运行时验证的部分：

- 导出只做了函数级（Markdown / ZIP）回归，没有在真机上走完整“保存对话框 → 写盘”流程。
- 通知链路未单独验证；M0 验收只要求 `doc_list` invoke。

---

## 5. M2 启动约束（不要越过）

来自计划第 7 节与三条红线：

1. **模型只能看到 5 个工具**：`fs_read / fs_write / fs_edit / fs_glob / fs_grep`。不得注册第 6 个工具，不得暴露 `doc_*`。
2. **不要让内置 `streamProxy` 可用**：`pi-agent-core@1.4.0` 的 `streamProxy` 是 HTTP 代理客户端，会把 token 带进 WebView。必须自研 `streamFn`，经 `invoke('agent_stream')` 桥接。
3. **`agent_stream` 只接受 provider 枚举**：不接受 `api_key`、`base_url`；密钥只存 Keystore，JS/日志/DB 不可见。
4. **网络出口唯一**：WebView 的 CSP 已是 `connect-src 'self' ipc:`，LLM 请求只能从 Rust 发出。
5. **仅根入口 import `pi-agent-core`**：禁止 `providers/all`（体积 1.94MB min）；Agent chunk 目标 ≤ 60KB gzip。
6. **`grep` 仍是 LIKE 回退**：`fallback=true`。M2 接受 `<500ms`；FTS 升级放到 M1，不要在 M2 顺手做。
7. **单 `Mutex<VirtualFs>`**：工具调用用短事务；流式期间不要持锁。
8. **追加语义**：`fs_write` 只新建；追加必须“read 尾部 → edit 锚点”，并写进 system prompt。
9. **对话渲染**：MVP 纯文本流式；`message_end` 后可选 Markdown 且 `html:false`；禁止 `dangerouslySetInnerHTML` 接模型原文。

---

## 6. 下一项任务：M2 Agent 闭环

计划文档第 5 节 M2 表（11/06–11/17）是权威任务清单，执行顺序建议如下：

1. **M2-1 可行性 spike**
   - 验证 `pi-agent-core@1.4.0` 在浏览器/WebView 打包与 TypeBox schema。
   - 写 `streamFn` 适配层草案，事件形状沿用 pi-agent 的 `data:` 片段。
   - 记录 Agent chunk 体积基线（≤60KB gzip），确认产物无 `aws-sdk/bedrock/openai` 标记。
   - 产出 Go/No-Go 结论后再动 schema 与 UI。
2. **M2-2 Schema v3**
   - `db/schema.rs` 的 `SCHEMA_VERSION` 从 2 升到 3，新增 `conversations / messages / settings` 迁移块。
   - 会话命令：列表、新建、删除、消息追加、读取。
   - 密钥不进库。
3. **M2-3 Rust LLM 代理**
   - `Cargo.toml` 增加 `reqwest`；新增 `agent_stream` command，SSE 转发。
   - OpenAI / Anthropic / Google 适配，provider 枚举映射固定 base URL。
   - 超时、取消、离线错误事件；提供本地 mock SSE。
4. **M2-4 密钥管理**
   - Keystore 读写删命令；设置页厂商/模型切换；桌面 dev-only provider。
5. **M2-5 Agent 运行时**
   - 5 个 TypeBox 工具、读并行/写串行、`fs_*` 绑定、`expect_rev` 透传、错误 `isError` 回灌。
6. **M2-6 追加语义 + M2-7 System Prompt v1**
   - 10 条铁律、当前日期、`{{skills_index}}` 占位、文件内容是数据不是指令。
7. **M2-8 对话 UI**
   - 流式气泡、工具卡片、错误重试、草稿保留、会话管理、底部“对话”入口。
8. **M2-9 安全回归 + M2-10 真机 E2E**
   - 路径穿越、恶意笔记注入、诱导输出密钥/电话、诱导写 `.agents`。
   - 真机“记下今天吃了拉面”落盘日记；“把那条待办勾掉”改 checkbox。

### 6.1 必读决策

- **D7**：Agent MVP 接受 `grep` LIKE 回退 `<500ms`，M1 再提升到 `<200ms`。
- **D8**：自研 `streamFn` + `invoke` 桥接，禁用内置 `streamProxy`。
- **D9**：对话 MVP 纯文本流式，`message_end` 后可选 Markdown（`html:false`）。

### 6.2 优先阅读的代码入口

| 目的 | 文件 |
|---|---|
| 现有 command 注册表 | `src-tauri/src/lib.rs` |
| 5 工具入参与回执形状 | `src-tauri/src/vfs/types.rs`、`src-tauri/src/commands/fs.rs` |
| 工具实现与 CapGate | `src-tauri/src/vfs/mod.rs`、`src-tauri/src/vfs/cap_gate.rs` |
| schema 迁移方式 | `src-tauri/src/db/schema.rs` |
| 文档层（不要暴露给模型） | `src-tauri/src/docs/mod.rs` |
| 导出写盘（保持 Rust 侧） | `src-tauri/src/commands/export.rs` |
| 前端 invoke 封装 | `src/api.ts` |
| 底部导航与页面 | `src/App.tsx`、`src/pages/` |
| 依赖声明 | `src-tauri/Cargo.toml`、`package.json` |

### 6.3 M2 不要做的事

- 不新增第 6 个工具，不把 `doc_*` 绑给模型。
- 不用 `providers/all`，不引入 provider SDK。
- 不在 `agent_stream` 接受任意 URL / `api_key` / `base_url`。
- 不在 WebView 直连 LLM，不把 token 放进 localStorage / React state 持久化。
- 不提前做 FTS5、技能系统、版本回滚 UI（分别属于 M1 / M3 / M4）。

---

## 7. 快速恢复工作环境

```powershell
git checkout refactor/database-layer-virtualfs-wal
git status                                  # 应干净
git log -1                                  # 9971806
git tag -n1 -l "v0.1.0"                     # 指向 9971806

pnpm install
cd src-tauri; cargo test                    # 8 passed
cd ..; pnpm lint; pnpm test                 # 前端基线

adb devices                                 # 确认 e0a292bc1223
adb install -r src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
```

---

## 8. 相关文档索引

- 执行计划：[LifeOS_下一步执行计划_v1.3.0.md](./LifeOS_下一步执行计划_v1.3.0.md)
- 设计文档：[LifeOS_数据库重构与Agent能力扩展设计文档_v1.0.0.pdf](./LifeOS_数据库重构与Agent能力扩展设计文档_v1.0.0.pdf)
- PRD：[refactoring-sqlite-vfs-pi-agent.md](./refactoring-sqlite-vfs-pi-agent.md)
- 运行与验证说明：[README.md](../README.md)

> 本交接文档为新增文件，首次提交时随 `docs:` 提交入库即可；不改变已冻结的能力边界。
