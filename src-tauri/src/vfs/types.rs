//! VirtualFs 的请求/响应契约。
//!
//! 这些类型是 Tauri command 与 VirtualFs 之间的唯一数据形状：
//! command 层只负责把参数装进 Request，VirtualFs 返回 Result；
//! 所有响应字段使用 camelCase，与现有前端 `invoke` 约定一致。

use serde::Serialize;

use super::acl::Principal;

/// read 的入参。
#[derive(Debug, Clone)]
pub struct ReadRequest {
    pub path: String,
    pub rev: Option<i64>,
    pub start_line: Option<usize>,
    pub end_line: Option<usize>,
    pub include_meta: Option<bool>,
    /// Caller identity; Agent is subject to `ai.policy`, User bypasses it.
    pub principal: Principal,
}

/// 目录项；`read` 指向目录时返回。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub path: String,
    pub kind: String,
    pub mtime: String,
    pub head_rev: i64,
}

/// read 的响应：目录与文件是两种形状，用 `kind` 区分。
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReadResult {
    Dir {
        entries: Vec<DirEntry>,
    },
    File {
        path: String,
        rev: i64,
        content: String,
        total_lines: usize,
        meta: Option<MetaSnapshot>,
    },
}

/// frontmatter 镜像的只读快照。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaSnapshot {
    pub kind: Option<String>,
    pub title: Option<String>,
    pub status: Option<String>,
    pub due: Option<String>,
    pub tags: Option<String>,
    pub extra: Option<String>,
}

/// Write origin: `fs_*` commands always use Agent, `doc_*` commands always use
/// User. Automatic writes only record `blobs.source`; they never create a
/// manual version snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteSource {
    User,
    Agent,
}

impl WriteSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent => "agent",
        }
    }
}

/// write 的入参。
#[derive(Debug, Clone)]
pub struct WriteRequest {
    pub path: String,
    pub content: String,
    pub create_parents: Option<bool>,
    pub source: WriteSource,
}

/// write 的回执。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReceipt {
    pub path: String,
    pub rev: i64,
    pub bytes: usize,
}

/// edit 的入参。
#[derive(Debug, Clone)]
pub struct EditRequest {
    pub path: String,
    pub old_string: String,
    pub new_string: String,
    pub replace_all: Option<bool>,
    pub expect_rev: Option<i64>,
    pub source: WriteSource,
}

/// edit 的回执。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditReceipt {
    pub path: String,
    pub rev: i64,
    pub bytes: usize,
}

/// glob 的入参。
#[derive(Debug, Clone)]
pub struct GlobRequest {
    pub pattern: String,
    pub root: Option<String>,
    pub case_sensitive: Option<bool>,
    pub principal: Principal,
}

/// glob 的命中项。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobEntry {
    pub path: String,
    pub kind: String,
    pub mtime: String,
    pub head_rev: i64,
}

/// grep 的入参。
#[derive(Debug, Clone)]
pub struct GrepRequest {
    pub pattern: String,
    pub path: Option<String>,
    pub max_results: Option<usize>,
    pub context_lines: Option<usize>,
    /// 扩展名过滤（不含点，大小写不敏感）；空表示不限制。
    pub extension: Option<String>,
    pub principal: Principal,
}

/// grep 的单条命中。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepHit {
    pub path: String,
    pub rev: i64,
    pub line: usize,
    pub preview: String,
}

/// grep 的响应。`fallback` 为 true 表示本次走了 LIKE 回退（FTS 未命中或不可用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepResponse {
    pub total: usize,
    pub hits: Vec<GrepHit>,
    pub fallback: bool,
}
