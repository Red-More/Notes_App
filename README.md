# LifeOS / Notes

离线优先的个人助手。笔记、待办、日程、人脉统一存放在单库 `life.db` 的虚拟文件系统中，每条内容都是一篇可被普通编辑器打开的 Markdown。

## 技术栈

- 前端：React 19 + TypeScript + Vite，测试使用 Vitest，lint 使用 Oxlint
- 壳层：Tauri 2（桌面 + Android）
- 存储：Rust + rusqlite（WAL），`VirtualFs` 提供 `read / write / edit / glob / grep` 五个能力
- 文档层：`doc_*` 命令面向 UI；`fs_*` 命令预留给后续 Agent，服务端 CapGate 二次校验路径与配额

## 环境要求

- Node.js 20+、pnpm 12
- Rust 1.77.2+，并安装 `rustfmt` 与 `clippy`（`rustup component add rustfmt clippy`）
- Linux 桌面构建需要 Tauri 系统依赖（`libwebkit2gtk-4.1-dev` 等，见 `.github/workflows/ci.yml`）
- Android 构建需要 Android SDK + NDK 26.2 + JDK 17+，并配置 `ANDROID_HOME`、`NDK_HOME`、`JAVA_HOME`

## 常用命令

| 目的 | 命令 |
|---|---|
| 安装前端依赖 | `pnpm install` |
| 前端开发 | `pnpm dev` |
| 前端 lint / 单测 / 构建 | `pnpm lint` / `pnpm test` / `pnpm build` |
| Rust 格式检查 | `cd src-tauri && cargo fmt --check` |
| Rust 静态检查 | `cd src-tauri && cargo clippy --all-targets -- -D warnings` |
| Rust 回归测试 | `cd src-tauri && cargo test` |
| 桌面调试 | `pnpm tauri dev` |
| 桌面构建 | `pnpm tauri build` |

### Android

```powershell
# 首次生成 Android 工程（src-tauri/gen/ 已被 .gitignore 忽略）
pnpm tauri android init

# 构建 ARM64 debug APK
pnpm tauri android build --debug --target aarch64

# 安装到已连接的真机
adb install -r src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
```

> Windows 未开启开发者模式时，Tauri CLI 的最后一步（创建 `jniLibs` 符号链接）会因权限失败。
> Rust 编译与前端构建通常已经完成，可直接复制产物并用 Gradle 打包：
>
> ```powershell
> Copy-Item src-tauri/target/aarch64-linux-android/debug/libapp_lib.so `
>   src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libapp_lib.so -Force
> cd src-tauri/gen/android
> .\gradlew.bat :app:assembleArm64Debug -x :app:rustBuildArm64Debug
> ```

## 验证基线

提交前至少执行：

```powershell
pnpm lint; pnpm test; pnpm build
cd src-tauri; cargo fmt --check; cargo clippy --all-targets -- -D warnings; cargo test
```

`cargo test` 当前覆盖 CapGate 非法路径、`write → edit → read → grep` 链路、`expect_rev` 冲突、软删/恢复/物理删、版本恢复、交叉索引刷新与写入 source 语义。

## 安全边界

- capability 不含 `shell:allow-exec` 与 `fs:default`；导出写盘由 Rust 侧 `tauri-plugin-fs` 的 `FsExt` 完成，不依赖 WebView 文件权限
- CSP `connect-src` 仅允许 `self` 与 `ipc`；对外网络出口预留给 Rust LLM 代理
- 模型只能看到虚拟路径 `/life/...`，真实文件系统与 `life.db` 均不可见
- `.agents` 目录对 `fs_write / fs_edit` 只读

## 目录结构

```text
src/                 React 前端（笔记/待办/日程/人脉/编辑器）
src-tauri/src/
  db/                life.db 生命周期、WAL、schema 迁移
  vfs/               VirtualFs 五工具、CapGate、frontmatter、交叉索引
  docs/              通用文档层、文件夹、版本、导出
  commands/          Tauri command 边界层
docs/                设计文档与执行计划
```
