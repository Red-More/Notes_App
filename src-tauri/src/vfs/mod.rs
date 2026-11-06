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
pub mod fts;
pub mod index;
pub mod meta;
pub mod patch;
pub mod types;
pub mod version_store;

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
        cap_gate::ensure_model_readable(&path)?;
        acl::ensure_allowed(&path, acl::AclPermission::Read)?;
        let row: Option<(i64, String, i64, Option<String>)> = self
            .conn
            .query_row(
                "SELECT i.inode, i.kind, i.head_rev, m.kind
                 FROM inodes i
                 LEFT JOIN meta m ON m.inode = i.inode
                 WHERE i.path = ?1 AND i.deleted = 0",
                params![path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((inode, kind, head_rev, doc_kind)) = row else {
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
        // Non-versioned documents only keep the head blob, so old revs are gone.
        if rev != head_rev {
            let doc_kind = doc_kind
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| meta::infer_kind(&path).to_string());
            if !meta::is_versioned(&doc_kind) {
                return Err(ToolError::NotFound {
                    path: format!("{path}@rev{rev}"),
                });
            }
        }
        let content: Option<String> = self
            .conn
            .query_row(
                "SELECT content FROM blobs WHERE inode = ?1 AND rev = ?2",
                params![inode, rev],
                |r| r.get(0),
            )
            .optional()?;
        // Only the head row is materialized; older revs are replayed on demand.
        let content = match content {
            Some(content) => content,
            None => version_store::replay(&self.conn, inode, rev)?,
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
        self.write_inner(req, true)
    }

    /// 技能安装专用写入口：仍走同一套事务/版本维护，但允许写 `.agents`。
    /// 调用方（`skills` 模块）负责把目标路径限制在技能目录内。
    pub(crate) fn write_skill(&mut self, req: WriteRequest) -> Result<WriteReceipt, ToolError> {
        self.write_inner(req, false)
    }

    fn write_inner(
        &mut self,
        req: WriteRequest,
        enforce_agents: bool,
    ) -> Result<WriteReceipt, ToolError> {
        let path = cap_gate::normalize_path(&req.path)?;
        let path = with_md_extension(path);
        if enforce_agents {
            cap_gate::ensure_writable(&path)?;
        }
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
        let parts = meta::parse_document(&content);
        meta::upsert_parts(&tx, inode, &path, &parts)?;
        index::refresh_parts(&tx, inode, &path, &parts)?;
        fts::index_document(&tx, inode, &content)?;
        let title = parts
            .title
            .clone()
            .unwrap_or_else(|| file_stem_title(&path));
        // Only notes (diary included) keep a version history; other kinds
        // store nothing in the version tables.
        let doc_kind = parts
            .kind
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| meta::infer_kind(&path).to_string());
        if meta::is_versioned(&doc_kind) {
            version_store::record_baseline(&tx, inode, &content, &title, &now_str)?;
        }
        tx.commit()?;

        Ok(WriteReceipt {
            path,
            rev: 1,
            bytes: size,
        })
    }

    /// 字符串替换式编辑，追加新 rev；expect_rev 是乐观锁。
    pub fn edit(&mut self, req: EditRequest) -> Result<EditReceipt, ToolError> {
        self.edit_inner(req, true)
    }

    /// 技能更新专用编辑入口：允许写 `.agents`，其余校验不变。
    pub(crate) fn edit_skill(&mut self, req: EditRequest) -> Result<EditReceipt, ToolError> {
        self.edit_inner(req, false)
    }

    fn edit_inner(
        &mut self,
        req: EditRequest,
        enforce_agents: bool,
    ) -> Result<EditReceipt, ToolError> {
        let path = cap_gate::normalize_path(&req.path)?;
        if enforce_agents {
            cap_gate::ensure_writable(&path)?;
        }
        acl::ensure_allowed(&path, acl::AclPermission::Write)?;
        if req.old_string.is_empty() {
            return Err(ToolError::invalid("old_string 不能为空"));
        }
        let new_string = req.new_string;

        let tx = self.conn.transaction()?;
        let row: Option<(i64, String, i64, Option<String>)> = tx
            .query_row(
                "SELECT i.inode, i.kind, i.head_rev, m.kind
                 FROM inodes i
                 LEFT JOIN meta m ON m.inode = i.inode
                 WHERE i.path = ?1 AND i.deleted = 0",
                params![path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((inode, file_kind, current, doc_kind)) = row else {
            return Err(ToolError::NotFound { path });
        };
        if file_kind != "file" {
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

        let now_str = now(&tx)?;
        let parts = meta::parse_document(&replaced);
        let title = parts
            .title
            .clone()
            .unwrap_or_else(|| file_stem_title(&path));
        let doc_kind = doc_kind
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| meta::infer_kind(&path));
        let next = if meta::is_versioned(doc_kind) {
            // A kind switch can leave a document without a baseline; capture the
            // pre-edit body once so the diff chain stays replayable.
            if version_store::latest_rev(&tx, inode)?.is_none() {
                let before = meta::parse_document(&content);
                let before_title = before
                    .title
                    .clone()
                    .unwrap_or_else(|| file_stem_title(&path));
                version_store::record_baseline(&tx, inode, &content, &before_title, &now_str)?;
            }
            // Agent edits are recorded versions: the head row moves to the new rev
            // and only a diff against the previous version is stored.
            version_store::append_version(
                &tx,
                inode,
                &version_store::VersionRecord {
                    content: &replaced,
                    source: req.source.as_str(),
                    title: &title,
                    kind: version_store::KIND_AGENT,
                    is_manual: false,
                    label: None,
                    created_at: &now_str,
                },
            )?
        } else {
            // Non-versioned documents only keep the head blob; advance it in place.
            let next = current + 1;
            tx.execute(
                "UPDATE blobs SET rev = ?1, content = ?2, source = ?3, created_at = ?4
                 WHERE inode = ?5 AND rev = ?6",
                params![next, replaced, req.source.as_str(), now_str, inode, current],
            )?;
            tx.execute(
                "UPDATE inodes SET head_rev = ?1, size = ?2, mtime = ?3 WHERE inode = ?4",
                params![next, replaced.len() as i64, now_str, inode],
            )?;
            next
        };
        meta::upsert_parts(&tx, inode, &path, &parts)?;
        index::refresh_parts(&tx, inode, &path, &parts)?;
        fts::index_document(&tx, inode, &replaced)?;
        tx.commit()?;

        Ok(EditReceipt {
            path,
            rev: next,
            bytes: replaced.len(),
        })
    }

    /// 路径模式匹配，返回最多 200 条。
    ///
    /// `pattern` 支持两种写法：以 `/life` 开头的绝对模式（模型常这么写），
    /// 或相对模式 + `root`（默认 `/life`）。两者最终都会落到同一个 GLOB 查询。
    pub fn glob(&self, req: GlobRequest) -> Result<Vec<GlobEntry>, ToolError> {
        let root = cap_gate::normalize_path(req.root.as_deref().unwrap_or(ROOT))?;
        let raw_pattern = req.pattern.trim();
        let full_pattern = if raw_pattern.starts_with('/') {
            cap_gate::normalize_path(raw_pattern)?
        } else {
            let pattern = cap_gate::validate_glob_pattern(raw_pattern)?;
            format!("{root}/{pattern}")
        };
        let case_sensitive = req.case_sensitive.unwrap_or(true);
        // `.agents` 只读区排除：相对 pattern（如 .agents/*.md）一样到不了这里。
        let agents_pattern = format!("{ROOT}{AGENTS_DIR}/*");
        let agents_exact = format!("{ROOT}{AGENTS_DIR}");

        let sql = if case_sensitive {
            "SELECT path, kind, mtime, head_rev FROM inodes
                 WHERE deleted = 0 AND path GLOB ?1
                   AND path NOT GLOB ?2 AND path != ?3
                 ORDER BY path ASC LIMIT ?4"
        } else {
            "SELECT path, kind, mtime, head_rev FROM inodes
                 WHERE deleted = 0 AND LOWER(path) GLOB LOWER(?1)
                   AND path NOT GLOB ?2 AND path != ?3
                 ORDER BY path ASC LIMIT ?4"
        };
        let mut stmt = self.conn.prepare(sql)?;
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

    /// 内容搜索：优先 FTS5 MATCH，命中后回正文定位行号与上下文；索引无命中
    /// 或不可用时回退到 LIKE 全表扫描，并在响应里如实标记 `fallback`。
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
        let scope = self.resolve_grep_scope(&target)?;
        let needle = pattern.to_lowercase();
        let doc_type = req
            .doc_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        if let Some(match_expr) = fts::match_query(&pattern) {
            // 索引缺失/损坏时静默回退，不让一次检索因为 FTS 状态而失败。
            if let Ok(hits) =
                self.grep_index(&match_expr, &scope, doc_type, &needle, max_results, context)
            {
                if !hits.is_empty() {
                    return Ok(GrepResponse {
                        total: hits.len(),
                        hits,
                        fallback: false,
                    });
                }
            }
        }

        let hits = self.grep_like(&scope, doc_type, &needle, max_results, context)?;
        Ok(GrepResponse {
            total: hits.len(),
            hits,
            fallback: true,
        })
    }

    /// 解析 grep 的检索范围：根目录 / 单文件 / 目录前缀。
    fn resolve_grep_scope(&self, target: &str) -> Result<GrepScope, ToolError> {
        if target == ROOT {
            return Ok(GrepScope::Root);
        }
        let kind: Option<String> = self
            .conn
            .query_row(
                "SELECT kind FROM inodes WHERE path = ?1 AND deleted = 0",
                params![target],
                |r| r.get(0),
            )
            .optional()?;
        match kind.as_deref() {
            Some("file") => Ok(GrepScope::File(target.to_string())),
            Some(_) => Ok(GrepScope::Dir(target.to_string())),
            None => Err(ToolError::NotFound {
                path: target.to_string(),
            }),
        }
    }

    /// FTS 召回候选文档，再回正文逐行定位真实行号与上下文。
    fn grep_index(
        &self,
        match_expr: &str,
        scope: &GrepScope,
        doc_type: Option<&str>,
        needle: &str,
        max_results: usize,
        context: usize,
    ) -> Result<Vec<GrepHit>, ToolError> {
        // `.agents` 只读区排除：即便调用方省略 path（默认全库检索）也到不了这里。
        let agents_pattern = format!("{ROOT}{AGENTS_DIR}/*");
        let agents_exact = format!("{ROOT}{AGENTS_DIR}");
        let mut sql = String::from(
            "SELECT i.path, i.head_rev, b.content
             FROM fts_docs
             JOIN inodes i ON i.inode = fts_docs.rowid
             JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
             LEFT JOIN meta m ON m.inode = i.inode
             WHERE fts_docs MATCH ?
               AND i.deleted = 0 AND i.kind = 'file'
               AND i.path NOT GLOB ? AND i.path != ?",
        );
        let mut args: Vec<SqlValue> = vec![
            SqlValue::Text(match_expr.to_string()),
            SqlValue::Text(agents_pattern),
            SqlValue::Text(agents_exact),
        ];
        push_grep_scope(&mut sql, &mut args, scope);
        if let Some(kind) = doc_type {
            sql.push_str(" AND COALESCE(m.kind, '') = ?");
            args.push(SqlValue::Text(kind.to_string()));
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

        let mut hits = Vec::new();
        for row in rows {
            let (path, rev, content) = row?;
            if scan_document(
                &content,
                &path,
                rev,
                needle,
                context,
                max_results,
                &mut hits,
            ) {
                break;
            }
        }
        Ok(hits)
    }

    /// LIKE 回退检索：索引不可用或未命中时仍保证可搜到。
    fn grep_like(
        &self,
        scope: &GrepScope,
        doc_type: Option<&str>,
        needle: &str,
        max_results: usize,
        context: usize,
    ) -> Result<Vec<GrepHit>, ToolError> {
        let agents_pattern = format!("{ROOT}{AGENTS_DIR}/*");
        let agents_exact = format!("{ROOT}{AGENTS_DIR}");
        let mut sql = String::from(
            "SELECT i.path, i.head_rev, b.content
             FROM inodes i
             JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
             LEFT JOIN meta m ON m.inode = i.inode
             WHERE i.deleted = 0 AND i.kind = 'file'
               AND instr(lower(b.content), lower(?)) > 0
               AND i.path NOT GLOB ? AND i.path != ?",
        );
        let mut args: Vec<SqlValue> = vec![
            SqlValue::Text(needle.to_string()),
            SqlValue::Text(agents_pattern),
            SqlValue::Text(agents_exact),
        ];
        push_grep_scope(&mut sql, &mut args, scope);
        if let Some(kind) = doc_type {
            sql.push_str(" AND COALESCE(m.kind, '') = ?");
            args.push(SqlValue::Text(kind.to_string()));
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

        let mut hits = Vec::new();
        for row in rows {
            let (path, rev, content) = row?;
            if scan_document(
                &content,
                &path,
                rev,
                needle,
                context,
                max_results,
                &mut hits,
            ) {
                break;
            }
        }
        Ok(hits)
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

/// grep 的检索范围：全库 / 单文件 / 目录前缀。
enum GrepScope {
    Root,
    File(String),
    Dir(String),
}

/// 把范围条件追加到 SQL 与参数列表；两个检索路径共用同一套语义。
fn push_grep_scope(sql: &mut String, args: &mut Vec<SqlValue>, scope: &GrepScope) {
    match scope {
        GrepScope::Root => {}
        GrepScope::File(path) => {
            sql.push_str(" AND i.path = ?");
            args.push(SqlValue::Text(path.clone()));
        }
        GrepScope::Dir(dir) => {
            sql.push_str(" AND i.path LIKE ? ESCAPE '\\'");
            let prefix = format!("{}%", cap_gate::escape_like(&format!("{dir}/")));
            args.push(SqlValue::Text(prefix));
        }
    }
}

/// 在正文中定位命中行；达到上限时返回 true，调用方可提前结束扫描。
fn scan_document(
    content: &str,
    path: &str,
    rev: i64,
    needle: &str,
    context: usize,
    max_results: usize,
    hits: &mut Vec<GrepHit>,
) -> bool {
    let lines: Vec<&str> = content.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        if !line.to_lowercase().contains(needle) {
            continue;
        }
        hits.push(GrepHit {
            path: path.to_string(),
            rev,
            line: index + 1,
            preview: preview(&lines, index, context),
        });
        if hits.len() >= max_results {
            return true;
        }
    }
    false
}

/// Fallback display title when the document has no frontmatter title.
fn file_stem_title(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("untitled")
        .to_string()
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
