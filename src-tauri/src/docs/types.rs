//! 通用文档层的 DTO 与查询参数。
//!
//! 前端不再直接操作关系表：所有内容（笔记/待办/日程/联系人）都以 `Doc` 返回，
//! 由 `src/api.ts` 再做领域映射，保证现有页面 DTO 不变。

use std::collections::BTreeMap;

use serde::Serialize;

/// frontmatter 字段：保持 JSON 值类型，便于后续扩展任意结构化字段。
pub type DocFields = BTreeMap<String, serde_json::Value>;

/// 一篇文档（一个 Markdown 文件）的完整视图。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    /// inode，作为稳定 id 暴露给前端。
    pub id: i64,
    pub path: String,
    /// note | todo | event | contact | diary
    pub kind: String,
    pub title: String,
    /// 正文（已剥离 frontmatter）。
    pub content: String,
    pub fields: DocFields,
    /// 仅笔记有文件夹；默认文件夹为 null。
    pub folder_id: Option<i64>,
    pub folder_name: Option<String>,
    pub pinned: i64,
    pub rev: i64,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

/// 文档的历史版本。`id` 来自 version_meta，全局唯一。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocVersion {
    pub id: i64,
    pub doc_id: i64,
    pub version_number: i64,
    pub title: String,
    pub content: String,
    pub label: Option<String>,
    pub label_description: Option<String>,
    pub is_manual: i64,
    pub created_at: String,
}

/// 笔记文件夹（本质是 /life/notes 下的目录）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: i64,
    pub name: String,
    pub is_pinned: i64,
    pub sort_order: i64,
    pub note_count: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderStats {
    pub total: i64,
    pub unclassified: i64,
    pub default_folder_name: String,
    pub folders: Vec<Folder>,
}

/// 交叉索引查询结果：轻量引用，供“人物/地点/日期”聚合列表使用。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRef {
    pub id: i64,
    pub path: String,
    pub kind: String,
    pub title: String,
    pub updated_at: String,
}

/// 文档列表查询参数（由 Tauri command 逐项构造）。
#[derive(Debug, Clone, Default)]
pub struct ListQuery {
    pub kind: Option<String>,
    pub folder_id: Option<i64>,
    pub unclassified: Option<bool>,
    pub search: Option<String>,
    pub sort: Option<String>,
    pub deleted: Option<bool>,
    pub tag: Option<String>,
    pub month: Option<String>,
    pub limit: Option<usize>,
}
