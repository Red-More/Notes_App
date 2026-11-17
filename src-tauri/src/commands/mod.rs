//! Tauri command 模块汇总。
//!
//! 内容命令统一走通用文档层（doc_*），文件夹/版本/导出是其配套命令。
//! Agent 命令（chat_* / agent_*）只读写会话表与 Rust 私有密钥文件。
//! 旧的关系型笔记/待办/联系人命令已全部移除。

pub mod agent;
pub mod assets;
pub mod dir_config;
pub mod doc;
pub mod export;
pub mod folder;
pub mod fs;
pub mod mcp;
pub mod search;
pub mod skill;
pub mod version;
