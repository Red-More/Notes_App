//! VirtualFs 的错误类型。
//!
//! 设计文档要求错误“可行动”而不是笼统的 failed：这些变体会被 Tauri
//! 序列化成 `{ code, ... }` 回传前端，随后原样回灌给模型（isError=true），
//! 让模型能根据 `conflict` / `noMatch` 自行纠正。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum ToolError {
    /// 路径越出 `/life` 白名单，或包含 `..`。
    PathEscape { root: String, got: String },
    /// 路径本身非法：空路径、控制字符、反斜杠、超长等。
    InvalidPath { message: String },
    /// 目标 inode 或指定 rev 不存在。
    NotFound { path: String },
    /// 目标存在但不是目录。
    NotADirectory { path: String },
    /// 目标存在但是目录，不能按文件处理。
    IsDirectory { path: String },
    /// write 试图新建一个已存在的路径。
    AlreadyExists { path: String },
    /// create_parents=false 且父目录缺失。
    ParentMissing { path: String },
    /// `/life/.agents/` 为只读区，禁止 write/edit。
    ReadOnlyArea { path: String },
    /// Agent 访问未授权路径（默认拒绝，需用户显式放行）。
    PermissionDenied { path: String, permission: String },
    /// edit 的 expect_rev 与当前 head_rev 不一致。
    Conflict { current: i64, expect: i64 },
    /// edit 的 old_string 未命中任何内容。
    NoMatch { hint: String },
    /// 参数不满足工具契约。
    InvalidArgument { message: String },
    /// 单文件内容超过 1MB 上限。
    ContentTooLarge { limit: usize, actual: usize },
    /// SQLite 读写失败。
    Storage { message: String },
}

impl ToolError {
    /// 便捷构造参数错误，避免每处都写完整结构体。
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::InvalidArgument {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PathEscape { root, got } => {
                write!(f, "路径逃逸：允许根 {root}，收到 {got}")
            }
            Self::InvalidPath { message } => write!(f, "路径非法：{message}"),
            Self::NotFound { path } => write!(f, "未找到：{path}"),
            Self::NotADirectory { path } => write!(f, "{path} 不是目录"),
            Self::IsDirectory { path } => write!(f, "{path} 是目录，不能按文件读写"),
            Self::AlreadyExists { path } => {
                write!(f, "{path} 已存在；修改请用 edit，或先删除后重建")
            }
            Self::ParentMissing { path } => write!(f, "父目录不存在：{path}"),
            Self::ReadOnlyArea { path } => write!(f, "{path} 属于只读区，禁止写入"),
            Self::PermissionDenied { path, permission } => write!(
                f,
                "路径未授权：{path}（需要 {permission} 权限）；请让用户在设置中授权该文件夹"
            ),
            Self::Conflict { current, expect } => write!(
                f,
                "版本冲突：当前 rev={current}，期望 rev={expect}；请先 read 最新内容再重试"
            ),
            Self::NoMatch { hint } => write!(f, "old_string 未命中：{hint}"),
            Self::InvalidArgument { message } => write!(f, "参数非法：{message}"),
            Self::ContentTooLarge { limit, actual } => {
                write!(f, "内容过大：{actual} 字节，上限 {limit} 字节")
            }
            Self::Storage { message } => write!(f, "存储错误：{message}"),
        }
    }
}

impl std::error::Error for ToolError {}

impl From<rusqlite::Error> for ToolError {
    fn from(e: rusqlite::Error) -> Self {
        log::warn!("vfs storage error: {e}");
        Self::Storage {
            message: e.to_string(),
        }
    }
}
