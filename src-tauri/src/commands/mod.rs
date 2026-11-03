//! Tauri command 模块汇总。
//!
//! 内容命令统一走通用文档层（doc_*），文件夹/版本/导出/索引是其配套命令。
//! Agent 命令（chat_* / agent_*）只读写会话表与 Rust 私有密钥文件。
//! 旧的关系型笔记/待办/联系人命令已全部移除。

pub mod agent;
pub mod chat_job;
pub mod doc;
pub mod export;
pub mod folder;
pub mod fs;
pub mod index;
pub mod local;
pub mod local_mnn;
pub mod mcp;
pub mod media;
pub mod privacy;
pub mod skill;
pub mod version;
