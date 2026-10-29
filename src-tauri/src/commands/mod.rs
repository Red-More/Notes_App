//! Tauri command 模块汇总。
//!
//! 重构后只保留 VirtualFs 的 5 个工具命令；旧的笔记/待办/联系人等
//! 关系型命令已随 notes.db 一并移除。

pub mod fs;
