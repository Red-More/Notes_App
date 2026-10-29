//! CapGate：VirtualFs 的路径与参数守门层。
//!
//! 所有 5 个工具入口都会先走这里：把用户/模型给的路径规范化为 `/life/...`，
//! 拒绝 `..`、绝对路径越界、控制字符与超长路径；写入时额外拒绝只读区
//! `/life/.agents/`。真正的数据库操作永远只拿到规范化后的路径。

use super::error::ToolError;

/// 虚拟文件系统根路径。
pub const ROOT: &str = "/life";

const MAX_PATH_CHARS: usize = 1024;
const MAX_SEGMENT_CHARS: usize = 255;
const READ_ONLY_PREFIX: &str = "/life/.agents";

/// 把任意输入路径规范化成 `/life/...`。
///
/// 规则：
/// - 相对路径视为根下路径（`diary/x.md` → `/life/diary/x.md`）；
/// - 绝对路径必须以 `/life` 开头，否则判为逃逸；
/// - 任意位置的 `..` 一律拒绝（即使最终仍落在根内）；
/// - 折叠 `/./` 与重复斜杠。
pub fn normalize_path(raw: &str) -> Result<String, ToolError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(ToolError::InvalidPath {
            message: "路径不能为空".into(),
        });
    }
    if raw.chars().count() > MAX_PATH_CHARS {
        return Err(ToolError::InvalidPath {
            message: format!("路径超过 {MAX_PATH_CHARS} 个字符"),
        });
    }
    if raw
        .chars()
        .any(|c| c == '\0' || c == '\\' || c.is_control())
    {
        return Err(ToolError::InvalidPath {
            message: "路径不能包含反斜杠、控制字符或空字符".into(),
        });
    }

    let is_absolute = raw.starts_with('/');
    let mut segments: Vec<&str> = Vec::new();
    for segment in raw.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(ToolError::PathEscape {
                root: ROOT.into(),
                got: raw.into(),
            });
        }
        if segment.chars().count() > MAX_SEGMENT_CHARS {
            return Err(ToolError::InvalidPath {
                message: format!("路径段超过 {MAX_SEGMENT_CHARS} 个字符"),
            });
        }
        segments.push(segment);
    }

    if segments.is_empty() {
        return Err(ToolError::InvalidPath {
            message: "缺少具体路径".into(),
        });
    }

    if is_absolute {
        if segments[0] != "life" {
            return Err(ToolError::PathEscape {
                root: ROOT.into(),
                got: raw.into(),
            });
        }
    } else if segments[0] != "life" {
        // 相对路径统一挂到 /life 下。
        segments.insert(0, "life");
    }

    let path = format!("/{}", segments.join("/"));
    // 防御性兜底：上面的构造已经保证，但 schema 的路径白名单不能只靠推理。
    if path != ROOT && !path.starts_with("/life/") {
        return Err(ToolError::PathEscape {
            root: ROOT.into(),
            got: raw.into(),
        });
    }
    Ok(path)
}

/// 判断路径是否允许被 write/edit 修改。
/// `.agents` 只允许用户经 UI 管理，模型工具不能写技能目录。
pub fn ensure_writable(path: &str) -> Result<(), ToolError> {
    if path == READ_ONLY_PREFIX || path.starts_with("/life/.agents/") {
        return Err(ToolError::ReadOnlyArea {
            path: path.to_string(),
        });
    }
    Ok(())
}

/// 校验 glob 的 pattern：必须是相对模式，禁止 `..` 与反斜杠。
/// `*` / `?` / `[...]` 由 SQLite GLOB 解释，这里只做逃逸检查。
pub fn validate_glob_pattern(pattern: &str) -> Result<String, ToolError> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err(ToolError::invalid("glob pattern 不能为空"));
    }
    if pattern.starts_with('/') {
        return Err(ToolError::invalid(
            "glob pattern 必须是相对路径，目录请用 root 参数",
        ));
    }
    if pattern.chars().count() > MAX_PATH_CHARS {
        return Err(ToolError::invalid(format!(
            "glob pattern 超过 {MAX_PATH_CHARS} 个字符"
        )));
    }
    if pattern
        .chars()
        .any(|c| c == '\0' || c == '\\' || c.is_control())
    {
        return Err(ToolError::invalid(
            "glob pattern 不能包含反斜杠或控制字符",
        ));
    }
    if pattern.split('/').any(|segment| segment == "..") {
        return Err(ToolError::PathEscape {
            root: ROOT.into(),
            got: pattern.into(),
        });
    }
    Ok(pattern.to_string())
}

/// 转义 LIKE 通配符，配合 `ESCAPE '\'` 使用。
/// 注意先转反斜杠，再转 `%` / `_`。
pub fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
