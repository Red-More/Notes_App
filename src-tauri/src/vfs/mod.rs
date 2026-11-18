//! VirtualFs：用 SQLite 模拟的文件系统，是本次重构的能力层核心。
//!
//! 职责边界：
//! - 只认规范化后的 `/life/...` 路径，不感知真实文件系统；
//! - 读写全部走 `inodes` + `blobs`，写操作追加 rev、永不覆盖；
//! - write/edit 在单事务内同时维护 `meta` 镜像；
//! - 不感知模型/Agent，Tauri command 只是薄封装（身份由命令面传入）。
//!
//! 并发模型：`VfsState` 用 `Mutex<VirtualFs>` 串行化所有操作，write/edit
//! 天然不会被并发插入；`edit` 仍保留 expect_rev 乐观锁，用于检测“读旧版本后
//! 再提交”的冲突。

pub mod acl;
pub mod agent_config;
pub mod cap_gate;
pub mod error;
pub mod fts;
pub mod lifeos;
pub mod meta;
pub mod patch;
pub mod reserved;
pub mod types;
pub mod version_store;

use std::collections::BTreeMap;
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

/// SQL predicate excluding reserved visibility config from model queries.
/// `.agent` visibility is evaluated per row because it is configurable.
fn reserved_glob_filter(column: &str) -> String {
    format!(
        "{column} NOT GLOB '*/.lifeos' AND {column} NOT GLOB '*/.lifeos/*' \
         AND {column} NOT GLOB '*/ai.policy'"
    )
}

/// Reserved-path gate: `.lifeos` and `ai.policy` are permanently hidden;
/// `.agent` follows its own `visible` setting. None is writable by the model.
fn ensure_reserved_readable(
    agent_configs: &BTreeMap<String, agent_config::AgentConfig>,
    path: &str,
) -> Result<(), ToolError> {
    if reserved::has_segment(path, reserved::LIFEOS_DIR) || reserved::is_policy_file(path) {
        return Err(ToolError::ReadOnlyArea {
            path: path.to_string(),
        });
    }
    if reserved::has_segment(path, reserved::AGENT_DIR)
        && !agent_config::effective_visible(agent_configs, path)
    {
        return Err(ToolError::ReadOnlyArea {
            path: path.to_string(),
        });
    }
    Ok(())
}

/// Whether one reserved entry should appear in a model-facing result.
fn reserved_entry_visible(
    agent_configs: &BTreeMap<String, agent_config::AgentConfig>,
    path: &str,
    principal: acl::Principal,
) -> bool {
    if reserved::has_segment(path, reserved::LIFEOS_DIR) || reserved::is_policy_file(path) {
        return false;
    }
    if reserved::has_segment(path, reserved::AGENT_DIR) {
        return principal == acl::Principal::Agent
            && agent_config::effective_visible(agent_configs, path);
    }
    true
}

/// Writes carry their origin; only Agent writes are constrained by ACL.
fn principal_from_source(source: WriteSource) -> acl::Principal {
    match source {
        WriteSource::User => acl::Principal::User,
        WriteSource::Agent => acl::Principal::Agent,
    }
}

/// Bundled grep inputs so both search helpers keep a small signature.
struct GrepOptions<'a> {
    scope: &'a GrepScope,
    /// Base-layer extension filter (no dot); `None` searches every type.
    extension: Option<&'a str>,
    needle: &'a str,
    max_results: usize,
    context: usize,
    principal: acl::Principal,
    policies: &'a acl::PolicySet,
    agent_configs: &'a BTreeMap<String, agent_config::AgentConfig>,
}

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
        let policies = acl::PolicySet::for_principal(&self.conn, req.principal)?;
        let agent_configs = if req.principal == acl::Principal::Agent {
            let configs = agent_config::load_all(&self.conn)?;
            ensure_reserved_readable(&configs, &path)?;
            configs
        } else {
            BTreeMap::new()
        };
        let row: Option<(i64, String, i64)> = self
            .conn
            .query_row(
                "SELECT inode, kind, head_rev
                 FROM inodes
                 WHERE path = ?1 AND status = 'active'",
                params![path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((inode, kind, head_rev)) = row else {
            // Keep "exists but denied" and "does not exist" indistinguishable.
            policies.ensure(&path, false, acl::AclPermission::Read, req.principal)?;
            return Err(ToolError::NotFound { path });
        };
        let is_dir = kind == "directory";
        policies.ensure(&path, is_dir, acl::AclPermission::Read, req.principal)?;

        if is_dir {
            let entries = self.list_dir(&path, &policies, &agent_configs, req.principal)?;
            return Ok(ReadResult::Dir { entries });
        }

        let rev = req.rev.unwrap_or(head_rev);
        if rev < 1 || rev > head_rev {
            return Err(ToolError::NotFound {
                path: format!("{path}@rev{rev}"),
            });
        }
        // Non-versioned documents only keep the head blob, so old revs are gone.
        // Derive the kind from the current head body (frontmatter may override
        // the path root) instead of inferring from the path alone.
        if rev != head_rev {
            let head_body: Option<String> = self
                .conn
                .query_row(
                    "SELECT content FROM blobs WHERE inode = ?1 AND rev = ?2",
                    params![inode, head_rev],
                    |r| r.get(0),
                )
                .optional()?;
            let doc_kind = head_body
                .map(|body| meta::doc_kind(&meta::parse_document(&body), &path))
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
        self.write_inner(req, true, None)
    }

    /// Create a document whose extension the caller already resolved.
    ///
    /// The document API builds `{base}.{ext}` itself, and a base name may contain
    /// dots ("Dr. Smith-c_ab12"), so splitting the path at its first dot would
    /// read the wrong extension. Passing it explicitly keeps `inodes.ext`, the
    /// Markdown/raw decision and the displayed title consistent.
    pub(crate) fn write_with_ext(
        &mut self,
        req: WriteRequest,
        ext: &str,
    ) -> Result<WriteReceipt, ToolError> {
        self.write_inner(req, true, Some(ext))
    }

    /// 技能安装专用写入口：仍走同一套事务/版本维护，但允许写 `.agent`。
    /// 调用方（`skills` 模块）负责把目标路径限制在技能目录内。
    pub(crate) fn write_skill(&mut self, req: WriteRequest) -> Result<WriteReceipt, ToolError> {
        self.write_inner(req, false, None)
    }

    /// 保留配置区专用写入口（用户侧）：只写 `inodes` + `blobs`。
    ///
    /// 配置不是文档：不写 `meta`、不建版本链、不进 FTS，避免出现在笔记列表
    /// 与搜索结果里。调用方（`directory_config`）负责校验 JSON 与权限字段。
    pub(crate) fn write_config(
        &mut self,
        path: &str,
        content: String,
    ) -> Result<WriteReceipt, ToolError> {
        let path = cap_gate::normalize_path(path)?;
        let owner = reserved::owner_of_config(&path, reserved::AGENT_DIR, reserved::CONFIG_FILE)
            .or_else(|| {
                reserved::owner_of_config(&path, reserved::LIFEOS_DIR, reserved::POLICY_FILE)
            })
            .ok_or_else(|| {
                ToolError::invalid("配置写入仅限 .agent/.meta.json 与 .lifeos/ai.policy")
            })?;
        if content.len() > MAX_FILE_BYTES {
            return Err(ToolError::ContentTooLarge {
                limit: MAX_FILE_BYTES,
                actual: content.len(),
            });
        }

        let tx = self.conn.transaction()?;
        let kind: Option<String> = tx
            .query_row(
                "SELECT kind FROM inodes WHERE path = ?1 AND status = 'active'",
                params![owner],
                |row| row.get(0),
            )
            .optional()?;
        if kind.as_deref() != Some("directory") {
            return Err(ToolError::NotFound { path: owner });
        }

        let now_str = now(&tx)?;
        let existing: Option<(i64, i64)> = tx
            .query_row(
                "SELECT inode, head_rev FROM inodes
                 WHERE lower(path) = lower(?1) AND kind = 'file'",
                params![path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (bytes, rev) = match existing {
            Some((inode, head)) => {
                let next = head + 1;
                tx.execute(
                    "INSERT INTO blobs (inode, rev, content, source, created_at)
                     VALUES (?1, ?2, ?3, 'user', ?4)",
                    params![inode, next, content, now_str],
                )?;
                tx.execute(
                    "UPDATE inodes SET head_rev = ?1, size = ?2, mtime = ?3,
                            hash = ?4, status = 'active', deleted_at = NULL
                     WHERE inode = ?5",
                    params![
                        next,
                        content.len() as i64,
                        now_str,
                        content_hash(&content),
                        inode
                    ],
                )?;
                (content.len(), next)
            }
            None => {
                ensure_parents(&tx, &path, &now_str)?;
                tx.execute(
                    "INSERT INTO inodes (path, kind, head_rev, size, ctime, mtime, ext, hash)
                     VALUES (?1, 'file', 1, ?2, ?3, ?3, ?4, ?5)",
                    params![
                        path,
                        content.len() as i64,
                        now_str,
                        path_extension(&path),
                        content_hash(&content)
                    ],
                )?;
                let inode = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO blobs (inode, rev, content, source, created_at)
                     VALUES (?1, 1, ?2, 'user', ?3)",
                    params![inode, content, now_str],
                )?;
                (content.len(), 1)
            }
        };
        tx.commit()?;

        Ok(WriteReceipt { path, rev, bytes })
    }

    fn write_inner(
        &mut self,
        req: WriteRequest,
        enforce_agents: bool,
        explicit_ext: Option<&str>,
    ) -> Result<WriteReceipt, ToolError> {
        let path = cap_gate::normalize_path(&req.path)?;
        if enforce_agents {
            cap_gate::ensure_writable(&path)?;
        }
        let principal = principal_from_source(req.source);
        let policies = acl::PolicySet::for_principal(&self.conn, principal)?;
        policies.ensure(&path, false, acl::AclPermission::Write, principal)?;

        let raw = req.content;
        if raw.len() > MAX_FILE_BYTES {
            return Err(ToolError::ContentTooLarge {
                limit: MAX_FILE_BYTES,
                actual: raw.len(),
            });
        }

        let tx = self.conn.transaction()?;
        // Case-insensitive: the namespace mirrors a Windows/macOS host, where
        // `A.md` and `a.md` are the same file, so `write` must not create both.
        let existing: Option<String> = tx
            .query_row(
                "SELECT kind FROM inodes WHERE lower(path) = lower(?1)",
                params![path],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(kind) = existing {
            // Re-authorize with the detected scope so a denied directory cannot
            // be probed through an `alreadyExists` response.
            policies.ensure(
                &path,
                kind == "directory",
                acl::AclPermission::Write,
                principal,
            )?;
            return Err(ToolError::AlreadyExists { path });
        }

        let now_str = now(&tx)?;
        if req.create_parents.unwrap_or(true) {
            ensure_parents(&tx, &path, &now_str)?;
        } else {
            let parent = parent_path(&path);
            let kind: Option<String> = tx
                .query_row(
                    "SELECT kind FROM inodes WHERE path = ?1 AND status = 'active'",
                    params![parent],
                    |r| r.get(0),
                )
                .optional()?;
            if kind.as_deref() != Some("directory") {
                return Err(ToolError::ParentMissing { path: parent });
            }
        }

        // Frontmatter is a Markdown convention: raw documents keep the caller's
        // bytes untouched (a shebang or leading `---` must survive verbatim).
        // Reserved config documents (skills) are authored by their own schema.
        // The system owns only the two dates; every other key stays as written.
        // A caller-resolved extension wins: it is the only reliable answer when
        // the base name itself contains dots.
        let ext = match explicit_ext {
            Some(value) => value.trim().trim_start_matches('.').to_string(),
            None => path_extension(&path),
        };
        let is_markdown = meta::is_markdown_ext(&ext);
        let is_reserved = reserved::is_reserved_path(&path);
        let content = if is_markdown && !is_reserved {
            meta::sync_system_dates(&raw, &now_str, &now_str)
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
            "INSERT INTO inodes (path, kind, head_rev, size, ctime, mtime, ext, hash)
             VALUES (?1, 'file', 1, ?2, ?3, ?3, ?4, ?5)",
            params![path, size as i64, now_str, ext, content_hash(&content)],
        )?;
        let inode = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO blobs (inode, rev, content, source, created_at)
             VALUES (?1, 1, ?2, ?3, ?4)",
            params![inode, content, req.source.as_str(), now_str],
        )?;
        // Reserved config documents (skills) stay out of search. Their version
        // chain is kept. Raw bodies are never scanned for frontmatter.
        let parts = if is_markdown {
            meta::parse_document(&content)
        } else {
            meta::DocumentParts::default()
        };
        if !is_reserved {
            // Frontmatter stays in the Markdown body; only search needs a row.
            fts::index_document(&tx, inode, &content)?;
        }
        let title = if is_markdown {
            meta::doc_title(&parts, &path, &ext)
        } else {
            file_stem_title(&path, &ext)
        };
        // Only notes (diary included) keep a version history; other kinds
        // store nothing in the version tables.
        let doc_kind = if is_markdown {
            meta::doc_kind(&parts, &path)
        } else {
            meta::infer_kind(&path).to_string()
        };
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

    /// 技能更新专用编辑入口：允许写 `.agent`，其余校验不变。
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
        let principal = principal_from_source(req.source);
        let policies = acl::PolicySet::for_principal(&self.conn, principal)?;
        policies.ensure(&path, false, acl::AclPermission::Write, principal)?;
        if req.old_string.is_empty() {
            return Err(ToolError::invalid("old_string 不能为空"));
        }
        let new_string = req.new_string;

        let tx = self.conn.transaction()?;
        let row: Option<(i64, String, i64, String, String)> = tx
            .query_row(
                "SELECT inode, kind, head_rev, ctime, ext
                 FROM inodes
                 WHERE path = ?1 AND status = 'active'",
                params![path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let Some((inode, file_kind, current, created_at, ext)) = row else {
            return Err(ToolError::NotFound { path });
        };
        if file_kind != "file" {
            // Re-authorize the directory itself so a denied folder cannot be
            // confirmed through an `isDirectory` response.
            policies.ensure(&path, true, acl::AclPermission::Write, principal)?;
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
        let now_str = now(&tx)?;
        // Raw documents are plain text: parsing the body as Markdown would turn a
        // leading `#` comment or `---` into a title/frontmatter.
        let is_markdown = meta::is_markdown_ext(&ext);
        let replaced = if is_markdown && !reserved::is_reserved_path(&path) {
            // created_at comes from the base layer, updated_at from the clock:
            // a caller edit to either date is discarded here.
            meta::sync_system_dates(&replaced, &created_at, &now_str)
        } else {
            replaced
        };
        if replaced == content {
            return Err(ToolError::NoMatch {
                hint: "created_at / updated_at 由系统维护，修改不会生效".into(),
            });
        }
        if replaced.len() > MAX_FILE_BYTES {
            return Err(ToolError::ContentTooLarge {
                limit: MAX_FILE_BYTES,
                actual: replaced.len(),
            });
        }

        let parts = meta::parse_document(&replaced);
        let title = if is_markdown {
            meta::doc_title(&parts, &path, &ext)
        } else {
            file_stem_title(&path, &ext)
        };
        let doc_kind = if is_markdown {
            meta::doc_kind(&parts, &path)
        } else {
            meta::infer_kind(&path).to_string()
        };
        let next = if meta::is_versioned(&doc_kind) {
            // A kind switch can leave a document without a baseline; capture the
            // pre-edit body once so the diff chain stays replayable.
            if version_store::latest_rev(&tx, inode)?.is_none() {
                let before_title = if is_markdown {
                    meta::parse_document(&content)
                        .title
                        .clone()
                        .unwrap_or_else(|| file_stem_title(&path, &ext))
                } else {
                    file_stem_title(&path, &ext)
                };
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
            advance_head(&tx, inode, current, &replaced, req.source, &now_str)?
        };
        // Reserved config documents (skills) skip search indexing but keep
        // their version chain so skill edits remain auditable.
        if !reserved::is_reserved_path(&path) {
            fts::index_document(&tx, inode, &replaced)?;
        }
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
        let principal = req.principal;
        let policies = acl::PolicySet::for_principal(&self.conn, principal)?;
        // 显式指定的根目录必须整体可见；省略 root 时按全库扫描，由结果逐条过滤。
        if req.root.is_some() {
            policies.ensure(&root, true, acl::AclPermission::Read, principal)?;
        }
        let raw_pattern = req.pattern.trim();
        let full_pattern = if raw_pattern.starts_with('/') {
            cap_gate::normalize_path(raw_pattern)?
        } else {
            let pattern = cap_gate::validate_glob_pattern(raw_pattern)?;
            format!("{root}/{pattern}")
        };
        let case_sensitive = req.case_sensitive.unwrap_or(true);
        // `.lifeos` 与 `ai.policy` 永久隐藏；`.agent` 逐条按内部 visible 过滤。
        let reserved_filter = reserved_glob_filter("path");

        let sql = if case_sensitive {
            format!(
                "SELECT path, kind, mtime, head_rev FROM inodes
                 WHERE status = 'active' AND path GLOB ?1
                   AND {reserved_filter}
                 ORDER BY path ASC LIMIT ?2"
            )
        } else {
            format!(
                "SELECT path, kind, mtime, head_rev FROM inodes
                 WHERE status = 'active' AND LOWER(path) GLOB LOWER(?1)
                   AND {reserved_filter}
                 ORDER BY path ASC LIMIT ?2"
            )
        };
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![full_pattern, MAX_GLOB_RESULTS], |r| {
            Ok(GlobEntry {
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
        // 逐条过滤：结果可能跨目录，不能只在入口判一次。
        let agent_configs = if principal == acl::Principal::Agent {
            agent_config::load_all(&self.conn)?
        } else {
            BTreeMap::new()
        };
        entries.retain(|entry| {
            let is_dir = entry.kind == "directory";
            reserved_entry_visible(&agent_configs, &entry.path, principal)
                && policies.allows_as(&entry.path, is_dir, acl::AclPermission::Read, principal)
        });
        Ok(entries)
    }

    /// 内容搜索：优先 FTS5 MATCH，命中后回正文定位行号与上下文；索引无命中
    /// 或不可用时回退到 LIKE 全表扫描，并在响应里如实标记 `fallback`。
    pub fn grep(&self, req: GrepRequest) -> Result<GrepResponse, ToolError> {
        let target = cap_gate::normalize_path(req.path.as_deref().unwrap_or(ROOT))?;
        let principal = req.principal;
        let policies = acl::PolicySet::for_principal(&self.conn, principal)?;
        let agent_configs = if principal == acl::Principal::Agent {
            agent_config::load_all(&self.conn)?
        } else {
            BTreeMap::new()
        };
        let scope = match self.resolve_grep_scope(&target) {
            Ok(scope) => scope,
            Err(error) => {
                // Keep "exists but denied" and "does not exist" indistinguishable.
                if req.path.is_some() {
                    policies.ensure(&target, false, acl::AclPermission::Read, principal)?;
                }
                return Err(error);
            }
        };
        // 显式指定的检索范围必须整体可见；省略 path 时按全库扫描，由命中逐条过滤。
        if req.path.is_some() {
            let is_dir = !matches!(scope, GrepScope::File(_));
            policies.ensure(&target, is_dir, acl::AclPermission::Read, principal)?;
        }
        let pattern = req.pattern.trim().to_string();
        if pattern.is_empty() {
            return Err(ToolError::invalid("grep pattern 不能为空"));
        }
        let max_results = req
            .max_results
            .unwrap_or(DEFAULT_GREP_RESULTS)
            .clamp(1, MAX_GREP_RESULTS);
        let context = req.context_lines.unwrap_or(0).min(MAX_CONTEXT_LINES);
        let needle = pattern.to_lowercase();
        // Extensions are a base-layer attribute, so normalize the leading dot
        // and compare case-insensitively in SQL.
        let extension = req
            .extension
            .as_deref()
            .map(str::trim)
            .map(|value| value.trim_start_matches('.'))
            .filter(|value| !value.is_empty());

        let options = GrepOptions {
            scope: &scope,
            extension,
            needle: &needle,
            max_results,
            context,
            principal,
            policies: &policies,
            agent_configs: &agent_configs,
        };
        if let Some(match_expr) = fts::match_query(&pattern) {
            // 索引缺失/损坏时静默回退，不让一次检索因为 FTS 状态而失败。
            if let Ok(hits) = self.grep_index(&match_expr, &options) {
                if !hits.is_empty() {
                    return Ok(GrepResponse {
                        total: hits.len(),
                        hits,
                        fallback: false,
                    });
                }
            }
        }

        let hits = self.grep_like(&options)?;
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
                "SELECT kind FROM inodes WHERE path = ?1 AND status = 'active'",
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
        options: &GrepOptions<'_>,
    ) -> Result<Vec<GrepHit>, ToolError> {
        let reserved_filter = reserved_glob_filter("i.path");
        let mut sql = format!(
            "SELECT i.path, i.head_rev, b.content
             FROM fts_docs
             JOIN inodes i ON i.inode = fts_docs.rowid
             JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
             WHERE fts_docs MATCH ?
               AND i.status = 'active' AND i.kind = 'file'
               AND {reserved_filter}"
        );
        let mut args: Vec<SqlValue> = vec![SqlValue::Text(match_expr.to_string())];
        push_grep_scope(&mut sql, &mut args, options.scope);
        if let Some(extension) = options.extension {
            sql.push_str(" AND lower(i.ext) = lower(?)");
            args.push(SqlValue::Text(extension.to_string()));
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

        collect_hits(rows, options)
    }

    /// LIKE 回退检索：索引不可用或未命中时仍保证可搜到。
    fn grep_like(&self, options: &GrepOptions<'_>) -> Result<Vec<GrepHit>, ToolError> {
        let reserved_filter = reserved_glob_filter("i.path");
        let mut sql = format!(
            "SELECT i.path, i.head_rev, b.content
             FROM inodes i
             JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
             WHERE i.status = 'active' AND i.kind = 'file'
               AND instr(lower(b.content), lower(?)) > 0
               AND {reserved_filter}"
        );
        let mut args: Vec<SqlValue> = vec![SqlValue::Text(options.needle.to_string())];
        push_grep_scope(&mut sql, &mut args, options.scope);
        if let Some(extension) = options.extension {
            sql.push_str(" AND lower(i.ext) = lower(?)");
            args.push(SqlValue::Text(extension.to_string()));
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

        collect_hits(rows, options)
    }

    /// 列举目录的直接子项；结果的 kind 区分 directory/file。
    fn list_dir(
        &self,
        dir: &str,
        policies: &acl::PolicySet,
        agent_configs: &BTreeMap<String, agent_config::AgentConfig>,
        principal: acl::Principal,
    ) -> Result<Vec<DirEntry>, ToolError> {
        let prefix = format!("{dir}/");
        let like_pattern = format!("{}%", cap_gate::escape_like(&prefix));
        let mut stmt = self.conn.prepare(
            "SELECT path, kind, mtime, head_rev FROM inodes
             WHERE status = 'active'
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
        entries.retain(|entry| {
            let is_dir = entry.kind == "directory";
            reserved_entry_visible(agent_configs, &entry.path, principal)
                && policies.allows_as(&entry.path, is_dir, acl::AclPermission::Read, principal)
        });
        Ok(entries)
    }

    /// Metadata snapshot for `read(include_meta)`. Markdown frontmatter lives
    /// in the body, so the snapshot is derived instead of read from a mirror.
    fn read_meta(&self, inode: i64) -> Result<Option<MetaSnapshot>, ToolError> {
        let row: Option<(String, String, String)> = self
            .conn
            .query_row(
                "SELECT i.path, i.ext, COALESCE(b.content, '')
                 FROM inodes i
                 LEFT JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
                 WHERE i.inode = ?1 AND i.kind = 'file'",
                params![inode],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((path, ext, content)) = row else {
            return Ok(None);
        };
        if !meta::is_markdown_ext(&ext) {
            // Preserve the legacy snapshot shape: raw documents use an empty
            // tag list and an empty field bag, not NULL.
            return Ok(Some(MetaSnapshot {
                kind: Some(meta::infer_kind(&path).to_string()),
                title: Some(file_stem_title(&path, &ext)),
                status: None,
                due: None,
                tags: Some(String::new()),
                extra: Some("{}".to_string()),
            }));
        }
        let parts = meta::parse_document(&content);
        Ok(Some(MetaSnapshot {
            kind: Some(meta::doc_kind(&parts, &path)),
            title: Some(meta::doc_title(&parts, &path, &ext)),
            status: meta::doc_status(&parts),
            due: meta::doc_due(&parts),
            tags: parts.tags.clone(),
            extra: serde_json::to_string(&parts.fields).ok(),
        }))
    }
}

/// grep 的检索范围：全库 / 单文件 / 目录前缀。
enum GrepScope {
    Root,
    File(String),
    Dir(String),
}

/// Consume candidate rows (`path`, `rev`, `content`) shared by both search
/// paths: hidden or denied documents are skipped so the result cap is never
/// spent on them. Stops as soon as the caller's result limit is reached.
fn collect_hits<I>(rows: I, options: &GrepOptions<'_>) -> Result<Vec<GrepHit>, ToolError>
where
    I: Iterator<Item = rusqlite::Result<(String, i64, String)>>,
{
    let mut hits = Vec::new();
    for row in rows {
        let (path, rev, content) = row?;
        // 逐条过滤，避免命中数被未授权或隐藏文档占满。
        if !reserved_entry_visible(options.agent_configs, &path, options.principal) {
            continue;
        }
        if !options
            .policies
            .allows_as(&path, false, acl::AclPermission::Read, options.principal)
        {
            continue;
        }
        // Base-layer extension filter; case-insensitive, dotted input normalized.
        if scan_document(
            &content,
            &path,
            rev,
            options.needle,
            options.context,
            options.max_results,
            &mut hits,
        ) {
            break;
        }
    }
    Ok(hits)
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
///
/// The *persisted* extension is stripped (`archive.tar.gz` -> `archive`), and a
/// document without one keeps every dot of its name (`v1.2` stays `v1.2`).
fn file_stem_title(path: &str, ext: &str) -> String {
    let stem = meta::path_stem(path, ext);
    if stem.is_empty() {
        "untitled".to_string()
    } else {
        stem
    }
}

/// SQLite 本地时间（`YYYY-MM-DD HH:MM:SS`），与现有导出格式一致。
fn now(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row("SELECT datetime('now','localtime')", [], |r| r.get(0))
}

/// 文件名没有扩展名时补 `.md`（虚拟路径，不接触真实 FS）。
///
/// This is the convenience default for path-only callers (`fs_write`, diary
/// creation). The document API writes an explicit extension and restores the
/// extension-less path afterwards when the user chose "no extension".
/// 从路径推断扩展名；没有扩展名时返回空串。
///
/// The first dot is the separator: base names never contain dots, while an
/// extension may contain more than one (`tar.gz`). Case is preserved.
pub(crate) fn path_extension(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.split_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => ext.to_string(),
        _ => String::new(),
    }
}

/// Move a non-versioned head blob forward and update the inode metadata.
///
/// Used by regular non-versioned documents and by reserved config documents
/// (skills), which never build a version chain.
fn advance_head(
    conn: &Connection,
    inode: i64,
    current: i64,
    content: &str,
    source: WriteSource,
    now: &str,
) -> rusqlite::Result<i64> {
    let next = current + 1;
    conn.execute(
        "UPDATE blobs SET rev = ?1, content = ?2, source = ?3, created_at = ?4
         WHERE inode = ?5 AND rev = ?6",
        params![next, content, source.as_str(), now, inode, current],
    )?;
    conn.execute(
        "UPDATE inodes SET head_rev = ?1, size = ?2, mtime = ?3, hash = ?4 WHERE inode = ?5",
        params![
            next,
            content.len() as i64,
            now,
            content_hash(content),
            inode
        ],
    )?;
    Ok(next)
}

/// Content hash stored in the base file layer (`inodes.hash`).
///
/// **Reserved, not yet read by the UI.** It exists so an integrity check / sync
/// pass can compare a document against its recorded body without re-reading
/// every blob. Consequence: no query verifies it, so every write path must keep
/// it current by hand — `write`/`write_inner`, `edit` (via [`advance_head`]),
/// `version_store::append_version`, `docs::save`, `docs::rename_file` and
/// `write_config`. The tests `saving_a_document_refreshes_the_base_layer_hash`
/// and `legacy_v6_database_upgrades_in_place_without_data_loss` are the only
/// current guards against drift.
pub(crate) fn content_hash(content: &str) -> String {
    crate::assets::sha256_hex(content.as_bytes())
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
                    "UPDATE inodes SET status = 'active' WHERE path = ?1 AND status = 'deleted'",
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
