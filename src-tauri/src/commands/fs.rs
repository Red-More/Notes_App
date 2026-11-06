//! Tauri 边界层：5 个 VirtualFs 工具命令。
//!
//! 这一层只做三件事：接收前端参数、加锁取 VirtualFs、把结果/错误原样返回。
//! 路径白名单、配额、版本冲突等规则全部在 `vfs` 内部执行，command 不复制逻辑。

use crate::vfs::acl::Principal;
use crate::vfs::error::ToolError;
use crate::vfs::types::*;
use crate::vfs::VfsState;
use tauri::State;

/// 读文件或列目录。
/// - 指向目录：返回 `{ kind: "dir", entries: [...] }`
/// - 指向文件：返回正文、`totalLines` 与可选 meta
#[tauri::command]
pub fn fs_read(
    state: State<'_, VfsState>,
    path: String,
    rev: Option<i64>,
    start_line: Option<usize>,
    end_line: Option<usize>,
    include_meta: Option<bool>,
    principal: Option<String>,
) -> Result<ReadResult, ToolError> {
    let vfs = crate::lock(&state.0);
    vfs.read(ReadRequest {
        path,
        rev,
        start_line,
        end_line,
        include_meta,
        principal: Principal::parse(principal.as_deref()),
    })
}

/// 新建文档；已存在返回 Conflict，修改请走 fs_edit。
#[tauri::command]
pub fn fs_write(
    state: State<'_, VfsState>,
    path: String,
    content: String,
    create_parents: Option<bool>,
    auto_frontmatter: Option<bool>,
) -> Result<WriteReceipt, ToolError> {
    let mut vfs = crate::lock(&state.0);
    vfs.write(WriteRequest {
        path,
        content,
        create_parents,
        auto_frontmatter,
        source: WriteSource::Agent,
    })
}

/// 字符串替换编辑，带 expect_rev 乐观锁与 replace_all。
#[tauri::command]
pub fn fs_edit(
    state: State<'_, VfsState>,
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
    expect_rev: Option<i64>,
) -> Result<EditReceipt, ToolError> {
    let mut vfs = crate::lock(&state.0);
    vfs.edit(EditRequest {
        path,
        old_string,
        new_string,
        replace_all,
        expect_rev,
        source: WriteSource::Agent,
    })
}

/// 按路径模式查找文件/目录，最多返回 200 条。
#[tauri::command]
pub fn fs_glob(
    state: State<'_, VfsState>,
    pattern: String,
    root: Option<String>,
    case_sensitive: Option<bool>,
    principal: Option<String>,
) -> Result<Vec<GlobEntry>, ToolError> {
    let vfs = crate::lock(&state.0);
    vfs.glob(GlobRequest {
        pattern,
        root,
        case_sensitive,
        principal: Principal::parse(principal.as_deref()),
    })
}

/// 内容搜索：FTS5 优先，未命中时 LIKE 回退，响应中 `fallback` 如实标记。
/// `type` 按文档类型过滤（note/todo/event/contact/diary）。
#[tauri::command]
pub fn fs_grep(
    state: State<'_, VfsState>,
    pattern: String,
    path: Option<String>,
    r#type: Option<String>,
    max_results: Option<usize>,
    context_lines: Option<usize>,
    principal: Option<String>,
) -> Result<GrepResponse, ToolError> {
    let vfs = crate::lock(&state.0);
    vfs.grep(GrepRequest {
        pattern,
        path,
        max_results,
        context_lines,
        doc_type: r#type,
        principal: Principal::parse(principal.as_deref()),
    })
}
