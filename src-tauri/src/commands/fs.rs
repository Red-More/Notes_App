//! Tauri 边界层：模型面 5 个 `fs_*` + 界面面 2 个 `user_*` 命令。
//!
//! 这一层只做三件事：接收前端参数、加锁取 VirtualFs、把结果/错误原样返回。
//! 身份由命令面决定，不接受调用方传参：`fs_*` 固定 `Principal::Agent`，
//! `user_*` 固定 `Principal::User`，避免模型把 `principal` 塞进工具参数提权。
//! 路径白名单、配额、版本冲突等规则全部在 `vfs` 内部执行，command 不复制逻辑。

use crate::vfs::acl::Principal;
use crate::vfs::error::ToolError;
use crate::vfs::types::*;
use crate::vfs::VfsState;
use tauri::State;

/// 读文件或列目录（模型面：身份固定为 Agent）。
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
) -> Result<ReadResult, ToolError> {
    let vfs = crate::lock(&state.0);
    vfs.read(ReadRequest {
        path,
        rev,
        start_line,
        end_line,
        include_meta,
        principal: Principal::Agent,
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

/// 按路径模式查找文件/目录，最多返回 200 条（模型面：身份固定为 Agent）。
#[tauri::command]
pub fn fs_glob(
    state: State<'_, VfsState>,
    pattern: String,
    root: Option<String>,
    case_sensitive: Option<bool>,
) -> Result<Vec<GlobEntry>, ToolError> {
    let vfs = crate::lock(&state.0);
    vfs.glob(GlobRequest {
        pattern,
        root,
        case_sensitive,
        principal: Principal::Agent,
    })
}

/// 内容搜索：FTS5 优先，未命中时 LIKE 回退，响应中 `fallback` 如实标记。
/// `type` 按文档类型过滤（note/todo/contact/diary）。（模型面：身份固定为 Agent）
#[tauri::command]
pub fn fs_grep(
    state: State<'_, VfsState>,
    pattern: String,
    path: Option<String>,
    r#type: Option<String>,
    max_results: Option<usize>,
    context_lines: Option<usize>,
) -> Result<GrepResponse, ToolError> {
    let vfs = crate::lock(&state.0);
    vfs.grep(GrepRequest {
        pattern,
        path,
        max_results,
        context_lines,
        doc_type: r#type,
        principal: Principal::Agent,
    })
}

/// 界面预览读取（用户面：身份固定为 User，绕过 Agent 文件夹 ACL）。
#[tauri::command]
pub fn user_read(
    state: State<'_, VfsState>,
    path: String,
    include_meta: Option<bool>,
) -> Result<ReadResult, ToolError> {
    let vfs = crate::lock(&state.0);
    vfs.read(ReadRequest {
        path,
        rev: None,
        start_line: None,
        end_line: None,
        include_meta,
        principal: Principal::User,
    })
}

/// 界面搜索（用户面：身份固定为 User，绕过 Agent 文件夹 ACL）。
/// `path` 可选，用于把检索范围限定到某个虚拟目录（如 `/life/agent`）。
#[tauri::command]
pub fn user_search(
    state: State<'_, VfsState>,
    pattern: String,
    r#type: Option<String>,
    path: Option<String>,
    max_results: Option<usize>,
) -> Result<GrepResponse, ToolError> {
    let vfs = crate::lock(&state.0);
    vfs.grep(GrepRequest {
        pattern,
        path,
        max_results,
        context_lines: None,
        doc_type: r#type,
        principal: Principal::User,
    })
}
