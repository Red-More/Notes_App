//! VirtualFs：用 SQLite 模拟的文件系统，是本次重构的能力层核心。
//!
//! 职责边界：
//! - 只认规范化后的 `/life/...` 路径，不感知真实文件系统；
//! - 读写全部走 `inodes` + `blobs`，写操作追加 rev、永不覆盖；
//! - write/edit 在单事务内同时维护 `meta` 镜像；
//! - 不感知模型/Agent，5 个 Tauri command 只是薄封装。
//!
//! 并发模型：`VfsState` 用 `Mutex<VirtualFs>` 串行化所有操作，write/edit
//! 天然不会被并发插入；`edit` 仍保留 expect_rev 乐观锁，用于检测“读旧版本后
//! 再提交”的冲突。

pub mod acl;
pub mod cap_gate;
pub mod error;
pub mod index;
pub mod meta;
pub mod types;

use std::path::Path;
use std::sync::Mutex;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OptionalExtension};

use cap_gate::ROOT;
use error::ToolError;
use types::*;

/// 单文件内容上限，与 PRD 保持一致。
const MAX_FILE_BYTES: usize = 1024 * 1024;
/// 单次目录列举上限，防止异常目录拖垮响应。
const MAX_DIR_ENTRIES: i64 = 1000;
/// 单次 glob 命中上限。
const MAX_GLOB_RESULTS: i64 = 200;
/// grep 默认/最大命中数。
const DEFAULT_GREP_RESULTS: usize = 50;
const MAX_GREP_RESULTS: usize = 200;
/// grep 上下文行数上限。
const MAX_CONTEXT_LINES: usize = 3;
/// 单条 preview 的字符上限。
const MAX_PREVIEW_CHARS: usize = 240;
/// `.agents` 只读技能区：模型工具一律不得列出/检索其中的内容（M3 才按需注入）。
const AGENTS_DIR: &str = "/.agents";

/// VirtualFs 持有唯一数据库连接；所有方法都在这条连接上执行。
pub struct VirtualFs {
    conn: Connection,
}

/// Tauri 管理的共享状态。锁的粒度是整库，符合“日记和待办同时改会脏”的约束。
pub struct VfsState(pub Mutex<VirtualFs>);

impl VirtualFs {
    pub fn new(conn: Connection) -> Self {
        Self { conn }
    }

    /// 供 docs 层复用同一连接（只在 crate 内可见）。
    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    pub(crate) fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// 读文件或列目录。
    pub fn read(&self, req: ReadRequest) -> Result<ReadResult, ToolError> {
        let path = cap_gate::normalize_path(&req.path)?;
        acl::ensure_allowed(&path, acl::AclPermission::Read)?;
        let row: Option<(i64, String, i64)> = self
            .conn
            .query_row(
                "SELECT inode, kind, head_rev FROM inodes
                 WHERE path = ?1 AND deleted = 0",
                params![path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((inode, kind, head_rev)) = row else {
            return Err(ToolError::NotFound { path });
        };

        if kind == "directory" {
            let entries = self.list_dir(&path)?;
            return Ok(ReadResult::Dir { entries });
        }

        let rev = req.rev.unwrap_or(head_rev);
        if rev < 1 || rev > head_rev {
            return Err(ToolError::NotFound {
                path: format!("{path}@rev{rev}"),
            });
        }
        let content: Option<String> = self
            .conn
            .query_row(
                "SELECT content FROM blobs WHERE inode = ?1 AND rev = ?2",
                params![inode, rev],
                |r| r.get(0),
            )
            .optional()?;
        let Some(content) = content else {
            return Err(ToolError::NotFound {
                path: format!("{path}@rev{rev}"),
            });
        };

        let total_lines = content.lines().count();
        let selected = slice_lines(&content, req.start_line, req.end_line);
        let snapshot = if req.include_meta.unwrap_or(false) {
            self.read_meta(inode)?
        } else {
            None
        };

        Ok(ReadResult::File {
            path,
            rev,
            content: selected,
            total_lines,
            meta: snapshot,
        })
    }

    /// 新建文档。已存在即 Conflict（修改走 edit），父目录按需补齐。
    pub fn write(&mut self, req: WriteRequest) -> Result<WriteReceipt, ToolError> {
        let path = cap_gate::normalize_path(&req.path)?;
        let path = with_md_extension(path);
        cap_gate::ensure_writable(&path)?;
        acl::ensure_allowed(&path, acl::AclPermission::Write)?;

        let raw = req.content;
        if raw.len() > MAX_FILE_BYTES {
            return Err(ToolError::ContentTooLarge {
                limit: MAX_FILE_BYTES,
                actual: raw.len(),
            });
        }

        let tx = self.conn.transaction()?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT kind FROM inodes WHERE path = ?1",
                params![path],
                |r| r.get(0),
            )
            .optional()?;
        if existing.is_some() {
            return Err(ToolError::AlreadyExists { path });
        }

        let now_str = now(&tx)?;
        if req.create_parents.unwrap_or(true) {
            ensure_parents(&tx, &path, &now_str)?;
        } else {
            let parent = parent_path(&path);
            let kind: Option<String> = tx
                .query_row(
                    "SELECT kind FROM inodes WHERE path = ?1 AND deleted = 0",
                    params![parent],
                    |r| r.get(0),
                )
                .optional()?;
            if kind.as_deref() != Some("directory") {
                return Err(ToolError::ParentMissing { path: parent });
            }
        }

        let content = if req.auto_frontmatter.unwrap_or(true) && !meta::has_frontmatter(&raw) {
            meta::prepend(&path, &raw, &now_str)
        } else {
            raw
        };
        let size = content.len();
        if size > MAX_FILE_BYTES {
            return Err(ToolError::ContentTooLarge {
                limit: MAX_FILE_BYTES,
                actual: size,
            });
        }

        tx.execute(
            "INSERT INTO inodes (path, kind, head_rev, size, ctime, mtime)
             VALUES (?1, 'file', 1, ?2, ?3, ?3)",
            params![path, size as i64, now_str],
        )?;
        let inode = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO blobs (inode, rev, content, source, created_at)
             VALUES (?1, 1, ?2, ?3, ?4)",
            params![inode, content, req.source.as_str(), now_str],
        )?;
        meta::upsert(&tx, inode, &path, &content)?;
        index::refresh(&tx, inode, &path, &content)?;
        record_version(&tx, inode, 1, &now_str)?;
        tx.commit()?;

        Ok(WriteReceipt {
            path,
            rev: 1,
            bytes: size,
        })
    }

    /// 字符串替换式编辑，追加新 rev；expect_rev 是乐观锁。
    pub fn edit(&mut self, req: EditRequest) -> Result<EditReceipt, ToolError> {
        let path = cap_gate::normalize_path(&req.path)?;
        cap_gate::ensure_writable(&path)?;
        acl::ensure_allowed(&path, acl::AclPermission::Write)?;
        if req.old_string.is_empty() {
            return Err(ToolError::invalid("old_string 不能为空"));
        }
        let new_string = req.new_string;

        let tx = self.conn.transaction()?;
        let row: Option<(i64, String, i64)> = tx
            .query_row(
                "SELECT inode, kind, head_rev FROM inodes
                 WHERE path = ?1 AND deleted = 0",
                params![path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((inode, kind, current)) = row else {
            return Err(ToolError::NotFound { path });
        };
        if kind != "file" {
            return Err(ToolError::IsDirectory { path });
        }
        if let Some(expect) = req.expect_rev {
            if expect != current {
                return Err(ToolError::Conflict { current, expect });
            }
        }

        let content: Option<String> = tx
            .query_row(
                "SELECT content FROM blobs WHERE inode = ?1 AND rev = ?2",
                params![inode, current],
                |r| r.get(0),
            )
            .optional()?;
        let Some(content) = content else {
            return Err(ToolError::Storage {
                message: format!("inode {inode} 缺少 rev={current} 的内容"),
            });
        };

        let replaced = if req.replace_all.unwrap_or(false) {
            content.replace(req.old_string.as_str(), new_string.as_str())
        } else {
            content.replacen(req.old_string.as_str(), new_string.as_str(), 1)
        };
        if replaced == content {
            return Err(ToolError::NoMatch {
                hint: "建议先 read 对齐最新内容，再检查 old_string 的空白与换行".into(),
            });
        }
        if replaced.len() > MAX_FILE_BYTES {
            return Err(ToolError::ContentTooLarge {
                limit: MAX_FILE_BYTES,
                actual: replaced.len(),
            });
        }

        let next = current + 1;
        let now_str = now(&tx)?;
        tx.execute(
            "INSERT INTO blobs (inode, rev, content, source, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![inode, next, replaced, req.source.as_str(), now_str],
        )?;
        tx.execute(
            "UPDATE inodes SET head_rev = ?1, size = ?2, mtime = ?3 WHERE inode = ?4",
            params![next, replaced.len() as i64, now_str, inode],
        )?;
        meta::upsert(&tx, inode, &path, &replaced)?;
        index::refresh(&tx, inode, &path, &replaced)?;
        record_version(&tx, inode, next, &now_str)?;
        tx.commit()?;

        Ok(EditReceipt {
            path,
            rev: next,
            bytes: replaced.len(),
        })
    }

    /// 路径模式匹配，返回最多 200 条。
    pub fn glob(&self, req: GlobRequest) -> Result<Vec<GlobEntry>, ToolError> {
        let root = cap_gate::normalize_path(req.root.as_deref().unwrap_or(ROOT))?;
        let pattern = cap_gate::validate_glob_pattern(&req.pattern)?;
        let full_pattern = format!("{root}/{pattern}");
        let case_sensitive = req.case_sensitive.unwrap_or(true);
        // `.agents` 只读区排除：相对 pattern（如 .agents/*.md）一样到不了这里。
        let agents_pattern = format!("{ROOT}{AGENTS_DIR}/*");
        let agents_exact = format!("{ROOT}{AGENTS_DIR}");

        let sql = if case_sensitive {
            format!(
                "SELECT path, kind, mtime, head_rev FROM inodes
                 WHERE deleted = 0 AND path GLOB ?1
                   AND path NOT GLOB ?2 AND path != ?3
                 ORDER BY path ASC LIMIT ?4"
            )
        } else {
            format!(
                "SELECT path, kind, mtime, head_rev FROM inodes
                 WHERE deleted = 0 AND LOWER(path) GLOB LOWER(?1)
                   AND path NOT GLOB ?2 AND path != ?3
                 ORDER BY path ASC LIMIT ?4"
            )
        };
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![full_pattern, agents_pattern, agents_exact, MAX_GLOB_RESULTS],
            |r| {
                Ok(GlobEntry {
                    path: r.get(0)?,
                    kind: r.get(1)?,
                    mtime: r.get(2)?,
                    head_rev: r.get(3)?,
                })
            },
        )?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }
        Ok(entries)
    }

    /// 内容搜索。P1 尚未维护 FTS5 索引，因此统一走 LIKE/instr 回退，
    /// 响应中 `fallback=true`；P2 接入触发器后可改为 FTS5 MATCH。
    pub fn grep(&self, req: GrepRequest) -> Result<GrepResponse, ToolError> {
        let target = cap_gate::normalize_path(req.path.as_deref().unwrap_or(ROOT))?;
        let pattern = req.pattern.trim().to_string();
        if pattern.is_empty() {
            return Err(ToolError::invalid("grep pattern 不能为空"));
        }
        let max_results = req
            .max_results
            .unwrap_or(DEFAULT_GREP_RESULTS)
            .clamp(1, MAX_GREP_RESULTS);
        let context = req.context_lines.unwrap_or(0).min(MAX_CONTEXT_LINES);

        // `.agents` 只读区排除：即便调用方省略 path（默认全库检索）也到不了这里。
        let agents_pattern = format!("{ROOT}{AGENTS_DIR}/*");
        let agents_exact = format!("{ROOT}{AGENTS_DIR}");
        let mut sql = String::from(
            "SELECT i.path, i.head_rev, b.content
             FROM inodes i
             JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
             WHERE i.deleted = 0 AND i.kind = 'file'
               AND instr(lower(b.content), lower(?1)) > 0
               AND i.path NOT GLOB ?2 AND i.path != ?3",
        );
        let mut args: Vec<SqlValue> = vec![
            SqlValue::Text(pattern.clone()),
            SqlValue::Text(agents_pattern),
            SqlValue::Text(agents_exact),
        ];

        if target != ROOT {
            let kind: Option<String> = self
                .conn
                .query_row(
                    "SELECT kind FROM inodes WHERE path = ?1 AND deleted = 0",
                    params![target],
                    |r| r.get(0),
                )
                .optional()?;
            match kind.as_deref() {
                Some("file") => {
                    sql.push_str(" AND i.path = ?4");
                    args.push(SqlValue::Text(target));
                }
                Some(_) => {
                    sql.push_str(" AND i.path LIKE ?4 ESCAPE '\\'");
                    let prefix = format!("{}%", cap_gate::escape_like(&format!("{target}/")));
                    args.push(SqlValue::Text(prefix));
                }
                None => return Err(ToolError::NotFound { path: target }),
            }
        }
        sql.push_str(" ORDER BY i.path ASC");

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;

        let needle = pattern.to_lowercase();
        let mut hits = Vec::new();
        for row in rows {
            let (path, rev, content) = row?;
            let lines: Vec<&str> = content.lines().collect();
            for (index, line) in lines.iter().enumerate() {
                if !line.to_lowercase().contains(needle.as_str()) {
                    continue;
                }
                hits.push(GrepHit {
                    path: path.clone(),
                    rev,
                    line: index + 1,
                    preview: preview(&lines, index, context),
                });
                if hits.len() >= max_results {
                    break;
                }
            }
            if hits.len() >= max_results {
                break;
            }
        }

        Ok(GrepResponse {
            total: hits.len(),
            hits,
            fallback: true,
        })
    }

    /// 列举目录的直接子项；结果的 kind 区分 directory/file。
    fn list_dir(&self, dir: &str) -> Result<Vec<DirEntry>, ToolError> {
        let prefix = format!("{dir}/");
        let like_pattern = format!("{}%", cap_gate::escape_like(&prefix));
        let mut stmt = self.conn.prepare(
            "SELECT path, kind, mtime, head_rev FROM inodes
             WHERE deleted = 0
               AND path LIKE ?1 ESCAPE '\\'
               AND instr(substr(path, length(?2) + 1), '/') = 0
             ORDER BY (kind = 'directory') DESC, path ASC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![like_pattern, prefix, MAX_DIR_ENTRIES], |r| {
            Ok(DirEntry {
                path: r.get(0)?,
                kind: r.get(1)?,
                mtime: r.get(2)?,
                head_rev: r.get(3)?,
            })
        })?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }
        Ok(entries)
    }

    fn read_meta(&self, inode: i64) -> Result<Option<MetaSnapshot>, ToolError> {
        self.conn
            .query_row(
                "SELECT kind, title, status, due, tags, extra FROM meta WHERE inode = ?1",
                params![inode],
                |r| {
                    Ok(MetaSnapshot {
                        kind: r.get(0)?,
                        title: r.get(1)?,
                        status: r.get(2)?,
                        due: r.get(3)?,
                        tags: r.get(4)?,
                        extra: r.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(ToolError::from)
    }
}

/// Track a revision in `version_meta` so the UI can address (inode, rev).
/// Automatic writes are always `is_manual=0`; only an explicit
/// `version_create` snapshot sets `is_manual=1`.
fn record_version(
    conn: &Connection,
    inode: i64,
    rev: i64,
    created_at: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO version_meta
             (inode, rev, label, label_description, is_manual, created_at)
         VALUES (?1, ?2, NULL, NULL, 0, ?3)",
        params![inode, rev, created_at],
    )?;
    Ok(())
}

/// SQLite 本地时间（`YYYY-MM-DD HH:MM:SS`），与现有导出格式一致。
fn now(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row("SELECT datetime('now','localtime')", [], |r| r.get(0))
}

/// 文件名没有扩展名时补 `.md`（虚拟路径，不接触真实 FS）。
fn with_md_extension(path: String) -> String {
    if Path::new(&path).extension().is_some() {
        path
    } else {
        format!("{path}.md")
    }
}

/// 取父目录的虚拟路径；顶层文件回退到 `/life`。
fn parent_path(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|parent| parent.to_string_lossy().to_string())
        .unwrap_or_else(|| ROOT.to_string())
}

/// 按需创建父目录（从根向下），已存在的目录会把软删标记恢复。
fn ensure_parents(conn: &Connection, path: &str, now: &str) -> Result<(), ToolError> {
    let mut ancestors: Vec<String> = Vec::new();
    let mut cursor = Path::new(path).parent();
    while let Some(parent) = cursor {
        let dir = parent.to_string_lossy().to_string();
        // 只补 /life 命名空间内的目录；根之上（如 "/"）永远不落库。
        if dir != ROOT && !dir.starts_with("/life/") {
            break;
        }
        ancestors.push(dir.clone());
        if dir == ROOT {
            break;
        }
        cursor = parent.parent();
    }

    for dir in ancestors.into_iter().rev() {
        let kind: Option<String> = conn
            .query_row(
                "SELECT kind FROM inodes WHERE path = ?1",
                params![dir],
                |r| r.get(0),
            )
            .optional()?;
        match kind.as_deref() {
            Some("directory") => {
                conn.execute(
                    "UPDATE inodes SET deleted = 0 WHERE path = ?1 AND deleted = 1",
                    params![dir],
                )?;
            }
            Some(_) => return Err(ToolError::NotADirectory { path: dir }),
            None => {
                conn.execute(
                    "INSERT INTO inodes (path, kind, head_rev, size, ctime, mtime)
                     VALUES (?1, 'directory', 0, 0, ?2, ?2)",
                    params![dir, now],
                )?;
            }
        }
    }
    Ok(())
}

/// 按 1-based 行号裁剪正文；越界范围返回空串。
fn slice_lines(content: &str, start_line: Option<usize>, end_line: Option<usize>) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let start = start_line.unwrap_or(1).max(1);
    let end = end_line.unwrap_or(total).min(total);
    if start > end || start > total {
        return String::new();
    }
    lines[start - 1..end].join("\n")
}

/// 生成带上下文的命中预览，并按字符数截断。
fn preview(lines: &[&str], index: usize, context: usize) -> String {
    let start = index.saturating_sub(context);
    let end = (index + context + 1).min(lines.len());
    truncate_chars(&lines[start..end].join("\n"), MAX_PREVIEW_CHARS)
}

fn truncate_chars(text: &str, max: usize) -> String {
    let mut out = String::new();
    for (index, c) in text.chars().enumerate() {
        if index >= max {
            out.push('…');
            break;
        }
        out.push(c);
    }
    out
}
