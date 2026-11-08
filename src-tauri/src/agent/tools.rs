//! Model-visible tools executed by the Rust supervisor.
//!
//! The 6 built-in tools reuse the same `VirtualFs` / `skills` cores as the Tauri
//! commands, so ACL, quotas and revision rules stay in one place. Remote `mcp_*`
//! tools are not wired yet: they degrade to an explicit `tool_not_supported`
//! tool result instead of failing the run.

use serde_json::{json, Value};

use super::llm::ToolSpec;
use crate::skills;
use crate::vfs::acl::Principal;
use crate::vfs::error::ToolError;
use crate::vfs::types::{
    EditRequest, GlobRequest, GrepRequest, ReadRequest, WriteRequest, WriteSource,
};
use crate::vfs::VirtualFs;

const GREP_TYPES: [&str; 5] = ["note", "todo", "event", "contact", "diary"];

/// One tool call requested by the model.
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    /// Set when the provider streamed unparsable arguments; the call is not run.
    pub argument_error: Option<String>,
}

impl ToolCall {
    /// JSON stored in `messages.tool_calls`; mirrors pi's `ToolCall` blocks.
    pub fn to_json(&self) -> Value {
        json!({
            "type": "toolCall",
            "id": self.id,
            "name": self.name,
            "arguments": self.arguments,
        })
    }
}

/// Outcome fed back to the model as a `toolResult` turn.
#[derive(Debug, Clone)]
pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
    /// Stable code for degradations the model can act on (`tool_not_supported` etc.).
    pub error_code: Option<String>,
}

impl ToolResult {
    pub fn ok(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_error: false,
            error_code: None,
        }
    }

    pub fn fail(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_error: true,
            error_code: None,
        }
    }

    pub fn fail_with(text: impl Into<String>, code: &str) -> Self {
        Self {
            text: text.into(),
            is_error: true,
            error_code: Some(code.to_string()),
        }
    }
}

/// Tool declarations sent to the provider; descriptions mirror `src/agent/tools.ts`.
pub fn specs() -> Vec<ToolSpec> {
    vec![
        spec(
            "fs_read",
            "读取一个文件，或列出目录。文件返回正文、行数与 rev。默认只能访问自己的工作目录 /life/agent；其它目录需用户授权。修改前先 read 拿到最新 rev。",
            json!({
                "path": {"type": "string", "description": "虚拟路径，如 /life/agent/2026-10-30.md"},
                "rev": {"type": "number", "description": "指定历史版本；省略读当前版本"},
                "startLine": {"type": "number", "description": "起始行（1 起）"},
                "endLine": {"type": "number", "description": "结束行（含）"},
                "includeMeta": {"type": "boolean", "description": "是否返回 frontmatter 元数据"}
            }),
            &["path"],
        ),
        spec(
            "fs_write",
            "新建一个 Markdown 文档。只能新建，不能覆盖：目标已存在会返回 alreadyExists。默认只能写自己的工作目录 /life/agent；其它目录需用户授权。追加内容请先 read 文件尾部，再用 fs_edit 锚定追加。",
            json!({
                "path": {"type": "string", "description": "虚拟路径；省略 .md 会自动补"},
                "content": {"type": "string", "description": "Markdown 正文（可含 frontmatter）"},
                "createParents": {"type": "boolean", "description": "自动创建父目录，默认 true"},
                "autoFrontmatter": {"type": "boolean", "description": "按路径自动补 frontmatter，默认 true"}
            }),
            &["path", "content"],
        ),
        spec(
            "fs_edit",
            "按字符串替换修改已有文档，追加新 rev。old_string 必须唯一命中；追加内容时把它设为文件末尾附近的一段原文。带上 expectRev 可在版本冲突时被拒绝。默认只能改自己的工作目录 /life/agent；其它目录需用户授权。",
            json!({
                "path": {"type": "string", "description": "虚拟路径"},
                "oldString": {"type": "string", "description": "要被替换的原文，必须唯一命中"},
                "newString": {"type": "string", "description": "替换后的文本；可包含追加内容"},
                "replaceAll": {"type": "boolean", "description": "是否替换全部命中，默认 false"},
                "expectRev": {"type": "number", "description": "乐观锁：read 到的 rev；不一致返回 conflict"}
            }),
            &["path", "oldString", "newString"],
        ),
        spec(
            "fs_glob",
            "按路径模式查找文件或目录，最多 200 条。默认只能看到自己的工作目录 /life/agent；其它目录需用户授权。",
            json!({
                "pattern": {"type": "string", "description": "GLOB 模式：绝对路径（如 /life/agent/*.md）或相对模式（配合 root）"},
                "root": {"type": "string", "description": "相对模式的根目录，默认 /life（结果按授权过滤）"},
                "caseSensitive": {"type": "boolean", "description": "是否区分大小写"}
            }),
            &["pattern"],
        ),
        spec(
            "fs_grep",
            "按内容搜索，返回 path:line 与上下文片段。默认最多 50 条；默认只能搜到已授权目录（/life/agent），其它目录需用户授权。",
            json!({
                "pattern": {"type": "string", "description": "要搜索的文字"},
                "path": {"type": "string", "description": "限定路径或目录，默认全库（结果按授权过滤）"},
                "type": {"type": "string", "enum": GREP_TYPES, "description": "限定文档类型：note/todo/event/contact/diary"},
                "maxResults": {"type": "number", "description": "最多返回条数，上限 200"},
                "contextLines": {"type": "number", "description": "上下文行数，上限 3"}
            }),
            &["pattern"],
        ),
        spec(
            "load_skill",
            "按需读取一个已启用技能的完整指令。参数 name 使用技能索引中的 id 或名称；命中技能触发词后应先调用它，再按正文步骤执行。",
            json!({
                "name": {"type": "string", "description": "技能索引中的 id 或名称，例如 daily-review"}
            }),
            &["name"],
        ),
    ]
}

fn spec(name: &str, description: &str, properties: Value, required: &[&str]) -> ToolSpec {
    ToolSpec {
        name: name.to_string(),
        description: description.to_string(),
        parameters: json!({
            "type": "object",
            "properties": properties,
            "required": required,
        }),
    }
}

/// Execute one call against the VFS. Errors become `isError` results, never `Err`.
///
/// Every filesystem call uses `Principal::Agent` / `WriteSource::Agent`, so the
/// existing path ACL applies: by default the model can only touch `/life/agent`.
pub fn execute(vfs: &mut VirtualFs, call: &ToolCall) -> ToolResult {
    if let Some(detail) = &call.argument_error {
        return ToolResult::fail_with(format!("工具参数不可用：{detail}"), "invalid_arguments");
    }
    if call.name.starts_with("mcp_") {
        return ToolResult::fail_with(
            format!(
                "工具 {} 在当前版本不可用：Rust 编排器尚未接入 MCP 远程工具。请改用本地工具（fs_read/fs_glob/fs_grep/fs_write/fs_edit/load_skill）或直接回复用户。",
                call.name
            ),
            "tool_not_supported",
        );
    }
    let outcome = match call.name.as_str() {
        "fs_read" => read(vfs, &call.arguments),
        "fs_write" => write(vfs, &call.arguments),
        "fs_edit" => edit(vfs, &call.arguments),
        "fs_glob" => glob(vfs, &call.arguments),
        "fs_grep" => grep(vfs, &call.arguments),
        "load_skill" => load_skill(vfs, &call.arguments),
        other => Err(ToolError::invalid(format!(
            "未知工具：{other}；可用工具为 fs_read/fs_write/fs_edit/fs_glob/fs_grep/load_skill"
        ))),
    };
    match outcome {
        Ok(text) => ToolResult::ok(text),
        Err(error) => ToolResult::fail(error.to_string()),
    }
}

fn read(vfs: &mut VirtualFs, args: &Value) -> Result<String, ToolError> {
    let path = require_text(args, "path")?;
    let result = vfs.read(ReadRequest {
        path,
        rev: int_arg(args, "rev"),
        start_line: uint_arg(args, "startLine"),
        end_line: uint_arg(args, "endLine"),
        include_meta: bool_arg(args, "includeMeta"),
        principal: Principal::Agent,
    })?;
    Ok(render_read(&result))
}

fn write(vfs: &mut VirtualFs, args: &Value) -> Result<String, ToolError> {
    let path = require_text(args, "path")?;
    let content = require_raw(args, "content")?;
    let receipt = vfs.write(WriteRequest {
        path,
        content,
        create_parents: Some(bool_arg(args, "createParents").unwrap_or(true)),
        auto_frontmatter: Some(bool_arg(args, "autoFrontmatter").unwrap_or(true)),
        source: WriteSource::Agent,
    })?;
    Ok(format!(
        "已新建 {}（rev={}，{} 字节）",
        receipt.path, receipt.rev, receipt.bytes
    ))
}

fn edit(vfs: &mut VirtualFs, args: &Value) -> Result<String, ToolError> {
    let path = require_text(args, "path")?;
    let old_string = require_raw(args, "oldString")?;
    let new_string = require_raw(args, "newString")?;
    let receipt = vfs.edit(EditRequest {
        path,
        old_string,
        new_string,
        replace_all: bool_arg(args, "replaceAll"),
        expect_rev: int_arg(args, "expectRev"),
        source: WriteSource::Agent,
    })?;
    Ok(format!("已更新 {}（rev={}）", receipt.path, receipt.rev))
}

fn glob(vfs: &mut VirtualFs, args: &Value) -> Result<String, ToolError> {
    let pattern = require_text(args, "pattern")?;
    let entries = vfs.glob(GlobRequest {
        pattern,
        root: text_arg(args, "root"),
        case_sensitive: bool_arg(args, "caseSensitive"),
        principal: Principal::Agent,
    })?;
    if entries.is_empty() {
        return Ok("没有命中任何路径".to_string());
    }
    Ok(entries
        .iter()
        .map(|entry| {
            let kind = if entry.kind == "directory" { "d" } else { "f" };
            format!("{kind} {}", entry.path)
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

fn grep(vfs: &mut VirtualFs, args: &Value) -> Result<String, ToolError> {
    let pattern = require_text(args, "pattern")?;
    let doc_type = text_arg(args, "type").filter(|value| GREP_TYPES.contains(&value.as_str()));
    let response = vfs.grep(GrepRequest {
        pattern,
        path: text_arg(args, "path"),
        max_results: uint_arg(args, "maxResults"),
        context_lines: uint_arg(args, "contextLines"),
        doc_type,
        principal: Principal::Agent,
    })?;
    if response.hits.is_empty() {
        return Ok("没有命中；可换一个更短的关键词再试".to_string());
    }
    let mut lines: Vec<String> = response
        .hits
        .iter()
        .map(|hit| format!("{}:{}: {}", hit.path, hit.line, hit.preview))
        .collect();
    if response.fallback {
        lines.push("（本次为 LIKE 回退检索）".to_string());
    }
    Ok(format!("共 {} 条\n{}", response.total, lines.join("\n")))
}

fn load_skill(vfs: &mut VirtualFs, args: &Value) -> Result<String, ToolError> {
    let wanted = require_raw(args, "name")?;
    let skills = skills::list(vfs)?;
    let target = skills
        .iter()
        .find(|skill| skill.enabled && (skill.id == wanted || skill.name == wanted))
        .ok_or_else(|| {
            ToolError::invalid(format!(
                "未找到已启用的技能「{wanted}」；请只使用系统提示【技能索引】里的 id 或名称"
            ))
        })?;
    let detail = skills::read(vfs, &target.id)?;
    Ok(format!("技能：{}\n\n{}", detail.summary.name, detail.body))
}

fn render_read(result: &crate::vfs::types::ReadResult) -> String {
    use crate::vfs::types::ReadResult;
    match result {
        ReadResult::Dir { entries } => {
            if entries.is_empty() {
                return "（空目录）".to_string();
            }
            entries
                .iter()
                .map(|entry| {
                    let kind = if entry.kind == "directory" { "d" } else { "f" };
                    format!("{kind} {}", entry.path)
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        ReadResult::File {
            path,
            rev,
            content,
            total_lines,
            meta,
        } => {
            let mut head = vec![
                format!("path: {path}"),
                format!("rev: {rev}"),
                format!("totalLines: {total_lines}"),
            ];
            if let Some(meta) = meta {
                if let Ok(value) = serde_json::to_string(meta) {
                    head.push(format!("meta: {value}"));
                }
            }
            format!("{}\n\n{}", head.join("\n"), content)
        }
    }
}

/// Trimmed string argument.
fn text_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// String argument kept verbatim (content must never be trimmed).
fn raw_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

fn require_text(args: &Value, key: &str) -> Result<String, ToolError> {
    text_arg(args, key).ok_or_else(|| ToolError::invalid(format!("缺少参数 {key}")))
}

fn require_raw(args: &Value, key: &str) -> Result<String, ToolError> {
    raw_arg(args, key).ok_or_else(|| ToolError::invalid(format!("缺少参数 {key}")))
}

fn bool_arg(args: &Value, key: &str) -> Option<bool> {
    match args.get(key) {
        Some(Value::Bool(value)) => Some(*value),
        Some(Value::String(value)) => match value.trim().to_lowercase().as_str() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn int_arg(args: &Value, key: &str) -> Option<i64> {
    let value = args.get(key)?;
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn uint_arg(args: &Value, key: &str) -> Option<usize> {
    int_arg(args, key).and_then(|value| usize::try_from(value).ok())
}
