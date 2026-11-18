//! 通用文档层：所有内容都是一条记录一个 Markdown 文件。
//!
//! 路径约定：
//! - 笔记：`/life/notes[/<folder>]/<slug>.md`
//! - 日记：`/life/diary/YYYY-MM-DD.md`
//! - 待办：`/life/todos/<slug>.md`
//! - 联系人：`/life/contacts/<slug>.md`
//!
//! id 使用 inode，移动文件不改变 id；自动保存原地更新 head rev，不追加历史，
//! 历史由 `versions` 的基线 + diff 链提供。文件夹本质是 `/life/notes` 下的目录，
//! 笔记移动即修改 inode.path。

pub mod export;
pub mod folders;
pub mod types;
pub mod util;
pub mod versions;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use crate::db::schema::NOTES_ROOT;
use crate::vfs::cap_gate;
use crate::vfs::{
    error::ToolError,
    meta,
    reserved,
    types::{WriteRequest, WriteSource},
    VirtualFs,
};

use types::{Doc, DocFields, DocSaveReceipt, ListQuery};
use util::{
    doc_date, doc_from_row, ensure_text_extension, fetch_row, folder_map, folder_path,
    folder_path_any, head_content, normalize_extension_or_empty, parent_dir, root_for, safe_segment,
    stem, unique_file_path, validate_file_name,
};

/// 读取单个文档。
pub fn get(vfs: &VirtualFs, id: i64, include_deleted: bool) -> Result<Doc, ToolError> {
    let conn = vfs.conn();
    let folders = folder_map(conn)?;
    let row = fetch_row(conn, id, include_deleted)?;
    Ok(doc_from_row(row, &folders))
}

/// 通用列表查询。SQL 只做粗筛，tag / month / 排序在 Rust 侧完成，
/// 这样字段扩展不需要频繁改 SQL，文档量级（千级）下成本可控。
pub fn list(vfs: &VirtualFs, query: ListQuery) -> Result<Vec<Doc>, ToolError> {
    let conn = vfs.conn();
    let status = if query.deleted.unwrap_or(false) {
        "deleted"
    } else {
        "active"
    };
    let kind_filter = query.kind.clone();
    let mut sql = String::from(
        "SELECT i.inode, i.path, i.head_rev, i.pinned, i.ctime, i.mtime, i.deleted_at,
                COALESCE(b.content, ''), i.ext
         FROM inodes i
         JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
         WHERE i.kind = 'file' AND i.status = ?",
    );
    let mut args: Vec<SqlValue> = vec![SqlValue::Text(status.to_string())];

    // A folder tab shows whatever lives inside it, so kind is ignored when a
    // folder id or an explicit root scope is given.
    if let Some(folder_id) = query.folder_id {
        let dir = folder_path_any(conn, folder_id)?;
        push_direct_child_filter(&mut sql, &mut args, &dir);
    } else if query.unclassified.unwrap_or(false) {
        push_direct_child_filter(&mut sql, &mut args, NOTES_ROOT);
    } else if let Some(root) = query.root.as_deref() {
        push_root_filter(&mut sql, &mut args, root)?;
    } else if let Some(kind) = kind_filter.as_deref() {
        let root = root_for(kind)?;
        sql.push_str(" AND i.path LIKE ? ESCAPE '\\'");
        args.push(SqlValue::Text(format!(
            "{}%",
            cap_gate::escape_like(&format!("{root}/"))
        )));
    }

    if let Some(raw) = query.search.as_deref() {
        let search = raw.trim();
        if !search.is_empty() {
            // Raw documents are titled by their file name, so the path must
            // participate; Markdown titles live in the frontmatter body.
            sql.push_str(
                " AND (instr(lower(b.content), lower(?)) > 0
                       OR instr(lower(i.path), lower(?)) > 0)",
            );
            args.push(SqlValue::Text(search.to_string()));
            args.push(SqlValue::Text(search.to_string()));
        }
    }

    // Restrict to an explicit path set (search reuses the `fs_grep` hits).
    if let Some(paths) = query.paths.as_deref() {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; paths.len()].join(",");
        sql.push_str(&format!(" AND i.path IN ({placeholders})"));
        args.extend(paths.iter().map(|path| SqlValue::Text(path.clone())));
    }
    // A kind-scoped query is already bounded by its root folder, so the row cap
    // is skipped: filtering by frontmatter kind happens after this query and
    // must not lose candidates to the 2000-row window.
    let kind_scoped = kind_filter.is_some()
        && query.folder_id.is_none()
        && query.root.is_none()
        && !query.unclassified.unwrap_or(false);
    if kind_scoped {
        sql.push_str(" ORDER BY i.mtime DESC");
    } else {
        sql.push_str(" ORDER BY i.mtime DESC LIMIT 2000");
    }

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args), util::row_to_doc)?;
    let folders = folder_map(conn)?;
    let mut docs = Vec::new();
    for row in rows {
        docs.push(doc_from_row(row?, &folders));
    }

    // 类型由 SQL 里的根目录过滤决定，不再按 frontmatter 二次筛选：正文写着
    // `kind: note` 的 `todo-*.md` 仍然留在待办里，不会从两个列表同时消失。

    if let Some(raw) = query.tag.as_deref() {
        let tag = raw.trim();
        if !tag.is_empty() {
            docs.retain(|doc| util::doc_has_tag(doc, tag));
        }
    }
    if let Some(raw) = query.month.as_deref() {
        let month = raw.trim();
        if !month.is_empty() {
            docs.retain(|doc| {
                doc_date(doc)
                    .map(|date| date.starts_with(month))
                    .unwrap_or(false)
            });
        }
    }

    sort_docs(&mut docs, query.sort.as_deref().unwrap_or("updated"));
    let limit = query.limit.unwrap_or(1000).clamp(1, 2000);
    docs.truncate(limit);
    apply_content_policy(&mut docs, &query);
    Ok(docs)
}

/// List callers can skip bodies or request a short preview, which keeps large
/// result sets off the IPC payload. Filtering above already used the parsed
/// fields, so clearing content here does not change matching semantics.
fn apply_content_policy(docs: &mut [Doc], query: &ListQuery) {
    let skip_content = query.include_content == Some(false);
    for doc in docs {
        if skip_content {
            doc.content.clear();
        } else if let Some(limit) = query.preview_chars {
            if doc.content.chars().count() > limit {
                doc.content = doc.content.chars().take(limit).collect();
            }
        }
    }
}

/// 新建文档。内容与 fields 由调用方给出，后端负责生成唯一路径与 frontmatter。
/// 新建文档（测试与内部默认扩展名入口）。
#[cfg(test)]
pub fn create(
    vfs: &mut VirtualFs,
    kind: &str,
    title: &str,
    content: &str,
    folder_id: Option<i64>,
    fields: Option<DocFields>,
) -> Result<Doc, ToolError> {
    create_typed(vfs, kind, title, content, folder_id, fields, None)
}

/// Same as [`create`] but lets the UI pick the extension (e.g. `.txt`).
pub fn create_typed(
    vfs: &mut VirtualFs,
    kind: &str,
    title: &str,
    content: &str,
    folder_id: Option<i64>,
    fields: Option<DocFields>,
    ext: Option<&str>,
) -> Result<Doc, ToolError> {
    root_for(kind)?;
    // Notes treat the title as a file name, so dots stay reserved for the
    // extension picker. Todo/Contact titles are free text ("Dr. Smith"), so only
    // path-illegal characters are rejected — and reported, never rewritten.
    let forbid_dots = kind == "note";
    if forbid_dots && title.contains('.') {
        return Err(ToolError::invalid("文件名不能包含点号，扩展名请单独选择"));
    }
    let fields = fields.unwrap_or_default();
    let ext = match ext {
        Some(raw) => normalize_extension_or_empty(raw)?,
        None => "md".to_string(),
    };
    ensure_text_extension(&ext)?;

    let dir = {
        let conn = vfs.conn();
        if kind == "note" {
            match folder_id {
                Some(id) => folder_path(conn, id)?,
                None => NOTES_ROOT.to_string(),
            }
        } else {
            root_for(kind)?.to_string()
        }
    };

    // safe_segment keeps trailing dots/spaces; trim them so a hand-crafted
    // command never stores a stem like "报告." (the UI validates the same rule).
    let raw_stem = if forbid_dots {
        safe_segment(title, kind, true)
    } else {
        // A contact name may contain dots; it must not be silently rewritten,
        // so an illegal character is an error the user can act on.
        validate_file_name(title, true)?
    };
    let trimmed_stem = raw_stem.trim_end_matches(['.', ' ']);
    let stem_name = if trimmed_stem.is_empty() {
        kind.to_string()
    } else {
        trimmed_stem.to_string()
    };

    let path = {
        let conn = vfs.conn();
        unique_file_path(conn, &dir, &stem_name, &ext)?
    };

    let now = util::now(vfs.conn())?;
    // Raw formats store the body verbatim; only Markdown gets frontmatter.
    let is_markdown = meta::is_markdown_ext(&ext);
    let payload = if is_markdown {
        meta::compose(kind, title, &now, &now, &fields, content)
    } else {
        content.to_string()
    };
    // The document API owns the exact path, including extension-less files, and
    // passes the resolved extension so a dotted base name is never re-split.
    vfs.write_with_ext(
        WriteRequest {
            path: path.clone(),
            content: payload,
            create_parents: Some(true),
            source: WriteSource::User,
        },
        &ext,
    )?;

    let conn = vfs.conn();
    let folders = folder_map(conn)?;
    let row = util::fetch_row_by_path(conn, &path, false)?;
    Ok(doc_from_row(row, &folders))
}

/// 保存文档：可选更新标题/正文/字段；笔记可同时移动到另一个文件夹。
/// 自动保存原地更新当前 head，不产生新的历史版本；expect_rev 不一致时返回 Conflict。
///
/// Test-only shorthand for [`save_document`] without a rename: production always
/// goes through `doc_save`, which may carry one.
#[cfg(test)]
pub fn save(
    vfs: &mut VirtualFs,
    id: i64,
    title: Option<String>,
    content: Option<String>,
    fields: Option<DocFields>,
    folder_id: Option<i64>,
    expect_rev: Option<i64>,
) -> Result<DocSaveReceipt, ToolError> {
    save_document(
        vfs,
        id,
        SaveRequest {
            title,
            content,
            fields,
            folder_id,
            expect_rev,
            ..Default::default()
        },
    )
}

/// Everything one save may change; omitted fields keep their stored value.
#[derive(Default)]
pub struct SaveRequest {
    pub title: Option<String>,
    pub content: Option<String>,
    pub fields: Option<DocFields>,
    /// New base name and extension, applied in the same transaction.
    pub rename: Option<(String, String)>,
    /// Only meaningful for notes: `-1` is the default folder, `None` means
    /// "do not move".
    pub folder_id: Option<i64>,
    pub expect_rev: Option<i64>,
}

/// [`save`] plus an optional rename, done in the same transaction.
///
/// A caller that changes both the file name and the fields (a contact edit is
/// the motivating case) must not be able to land the rename and fail the body:
/// two IPC calls would leave the file renamed but the frontmatter stale. Here
/// the path, the extension and the body change together or not at all.
pub fn save_document(
    vfs: &mut VirtualFs,
    id: i64,
    request: SaveRequest,
) -> Result<DocSaveReceipt, ToolError> {
    let SaveRequest {
        title,
        content,
        fields,
        rename,
        folder_id,
        expect_rev,
    } = request;
    let tx = vfs.conn_mut().transaction()?;
    let row = fetch_row(&tx, id, false)?;
    // The row reader falls back to an empty body when the head blob is gone,
    // so refuse to save instead of silently rewriting the document without content.
    let Some(head) = head_content(&tx, id, row.head_rev)? else {
        return Err(ToolError::Storage {
            message: format!("inode {id} has no body for rev={}", row.head_rev),
        });
    };
    // Raw documents keep their bytes verbatim: parsing them as Markdown would
    // strip a leading `---` or treat a shebang as a heading. The persisted
    // extension decides, because a contact-like base name may contain dots.
    let is_markdown = meta::is_markdown_ext(&row.ext);
    let parts = if is_markdown {
        meta::parse_document(&head)
    } else {
        meta::DocumentParts {
            body: head.clone(),
            ..Default::default()
        }
    };
    // 命名与存放规则看文件所在位置，不看 frontmatter：一个自称 `kind: todo` 的
    // 笔记仍然放在 /life/notes 下，就必须遵守笔记的点号规则，也不能借 folder_id
    // 移动文件夹。frontmatter 的 kind 只用于展示与版本历史。
    let location_kind = meta::infer_kind(&row.path);

    // Saving follows the same naming rule as creating: a note's title is its
    // file name, so it must not contain the extension separator. Free-text kinds
    // (todo/contact) keep their dots.
    if location_kind == "note" {
        if let Some(next_title) = title.as_deref() {
            if next_title.contains('.') {
                return Err(ToolError::invalid("文件名不能包含点号，扩展名请单独选择"));
            }
        }
    }

    if let Some(expect) = expect_rev {
        if expect != row.head_rev {
            return Err(ToolError::Conflict {
                current: row.head_rev,
                expect,
            });
        }
    }

    // Where the file ends up: a folder move decides the directory, a rename
    // decides the base name and extension. Both are validated before anything
    // is written so a rejected name leaves the document untouched.
    let mut target_dir = parent_dir(&row.path).to_string();
    if location_kind == "note" {
        if let Some(target_id) = folder_id {
            target_dir = if target_id < 0 {
                NOTES_ROOT.to_string()
            } else {
                folder_path(&tx, target_id)?
            };
        }
    }
    let (mut new_path, mut new_ext, mut new_base) = (
        row.path.clone(),
        row.ext.clone(),
        stem(&row.path, &row.ext).to_string(),
    );
    // A rename also rewrites the frontmatter title below; remember it before the
    // option is consumed by the pattern match.
    let renamed = rename.is_some();
    if let Some((base, ext)) = rename {
        let plan = plan_rename(&tx, &row, &target_dir, &base, &ext)?;
        new_path = plan.target;
        new_ext = plan.ext;
        new_base = plan.base;
    } else if target_dir != parent_dir(&row.path) {
        // A folder move keeps the name; a collision is resolved by suffixing
        // instead of failing, which is what dragging a note into a folder with a
        // same-named note should do.
        new_path = unique_file_path(&tx, &target_dir, &new_base, &new_ext)?;
    }

    let body = content.unwrap_or(parts.body);
    // User-owned frontmatter passes through untouched: only keys the caller
    // explicitly updates are rewritten (`null` removes a key).
    let mut updates = fields.unwrap_or_default();
    if let Some(title) = title {
        updates.insert("title".to_string(), Value::String(title));
    }
    // The file name is the title the editor shows, so a rename rewrites it in
    // the same pass; a stale value would reappear after a reload.
    if renamed {
        updates.insert("title".to_string(), Value::String(new_base));
    }

    let now = util::now(&tx)?;
    // Reserved config documents (`.agent` / `.lifeos`) are ordinary editable
    // files for the user: write the body verbatim instead of adding Markdown
    // frontmatter, and keep them out of the document mirror.
    let is_reserved = reserved::is_reserved_path(&new_path);
    // created_at is owned by the base layer and updated_at by the clock; any
    // date the caller wrote into the frontmatter is discarded.
    let markdown = if is_reserved || !is_markdown {
        body
    } else {
        meta::rewrite_document(&head, Some(&body), &updates, &row.ctime, &now)
    };
    if markdown.len() > 1024 * 1024 {
        return Err(ToolError::ContentTooLarge {
            limit: 1024 * 1024,
            actual: markdown.len(),
        });
    }
    // 内容未变化且未移动时，不追加空 rev，避免自动保存把历史撑爆。
    if new_path == row.path && markdown == head {
        drop(tx);
        return Ok(DocSaveReceipt {
            id,
            path: row.path,
            rev: row.head_rev,
            updated_at: row.mtime,
        });
    }

    // Autosave rewrites the head row in place: it creates no version and keeps
    // the current rev, so history only grows on explicit snapshots/restores
    // and Agent edits.
    tx.execute(
        "UPDATE blobs SET content = ?1, source = 'user', created_at = ?2
         WHERE inode = ?3 AND rev = ?4",
        params![markdown, now, id, row.head_rev],
    )?;
    tx.execute(
        "UPDATE inodes SET path = ?1, ext = ?2, size = ?3, mtime = ?4, hash = ?5
         WHERE inode = ?6",
        params![
            new_path,
            new_ext,
            markdown.len() as i64,
            now,
            crate::vfs::content_hash(&markdown),
            id
        ],
    )?;
    // The body already holds its frontmatter; only search needs refreshing.
    if !is_reserved {
        crate::vfs::fts::index_document(&tx, id, &markdown)?;
    }
    let receipt = DocSaveReceipt {
        id,
        path: new_path,
        rev: row.head_rev,
        updated_at: now,
    };
    tx.commit()?;

    Ok(receipt)
}

/// 文件所在位置决定的文档类型。
///
/// 命名规则只关心"这个文件住在哪个根目录下"，因此这里刻意不看 frontmatter：
/// `/life/notes/x.md` 无论写着 `kind: todo` 还是 `kind: note`，都必须遵守笔记的
/// 点号规则；反之 `/life/todos/todo-*.md` 里写 `kind: note` 也不会变成可移动的笔记。
fn location_kind_of_row(row: &util::DocRow) -> &'static str {
    meta::infer_kind(&row.path)
}

/// A validated rename: the new path plus the normalized parts it was built from.
struct RenamePlan {
    target: String,
    /// Base name after validation (trimmed, dot rule applied).
    base: String,
    /// Normalized extension; empty means "no extension".
    ext: String,
}

/// Where a document should live after an optional rename.
///
/// Both `save` (which may rename as part of a folder move) and `rename_file`
/// must apply the same rules, so the checks live here instead of being copied:
/// the dot rule follows the document kind, Markdown and raw never cross, policy
/// files stay put, and a name already taken by another document is refused.
fn plan_rename(
    conn: &rusqlite::Connection,
    row: &util::DocRow,
    dir: &str,
    base: &str,
    ext: &str,
) -> Result<RenamePlan, ToolError> {
    let ext = normalize_extension_or_empty(ext)?;
    ensure_text_extension(&ext)?;
    let base = validate_file_name(base, location_kind_of_row(row) != "note")?;
    let name = if ext.is_empty() {
        base.clone()
    } else {
        format!("{base}.{ext}")
    };
    let target = format!("{dir}/{name}");
    // Switching between Markdown and raw would need a content conversion, so the
    // two families never cross by rename alone. The stored extension of the row
    // and the requested one decide, not the shape of the name.
    if meta::is_markdown_ext(&row.ext) != meta::is_markdown_ext(&ext) {
        return Err(ToolError::invalid(
            "Markdown 与非 Markdown 文档之间不能直接切换扩展名",
        ));
    }
    // Renaming a policy file (in or out) silently changes visibility ACL
    // enforcement; the file must stay editable in place instead.
    if reserved::is_policy_file(&row.path) || reserved::is_policy_file(&target) {
        return Err(ToolError::invalid("可见性策略文件 ai.policy 不能重命名"));
    }
    if target != row.path {
        let taken: i64 = conn.query_row(
            "SELECT COUNT(*) FROM inodes WHERE lower(path) = lower(?1) AND inode <> ?2",
            params![target, row.inode],
            |r| r.get(0),
        )?;
        if taken > 0 {
            return Err(ToolError::AlreadyExists { path: target });
        }
    }
    Ok(RenamePlan {
        target,
        base,
        ext,
    })
}

/// Rename one document file in place.
///
/// `base` is the whole name without the extension. Notes must not contain dots
/// (the dot separates the extension); free-text names such as a contact
/// ("Dr. Smith-c_ab12") keep theirs. `ext` is stored separately so a multi-part
/// extension is never re-split; an empty `ext` removes the extension.
///
/// Moving the path does not touch FTS: rows are keyed by inode and resolve the
/// current path from `inodes`.
pub fn rename_file(vfs: &mut VirtualFs, id: i64, base: &str, ext: &str) -> Result<Doc, ToolError> {
    let row = fetch_row(vfs.conn(), id, false)?;
    let plan = plan_rename(vfs.conn(), &row, parent_dir(&row.path), base, ext)?;
    if plan.target == row.path {
        return get(vfs, id, false);
    }
    // Path and extension change in one transaction.
    let tx = vfs.conn_mut().transaction()?;
    let now = util::now(&tx)?;
    tx.execute(
        "UPDATE inodes SET path = ?1, ext = ?2, mtime = ?3
         WHERE inode = ?4 AND kind = 'file'",
        params![plan.target, plan.ext, now, id],
    )?;
    // Keep the YAML title in sync with the file name: the editor shows the file
    // name, so a stale frontmatter title would reappear after a reload.
    let row = util::fetch_row(&tx, id, false)?;
    sync_title_to_file_name(&tx, &row, &plan.base, &now)?;
    tx.commit()?;
    get(vfs, id, false)
}

/// Rewrite a Markdown document's frontmatter title to match its new file name.
///
/// The editor shows the file name, so a stale title would reappear after a
/// reload. Auto snapshots carry the title too; manual labels are user-authored
/// and stay untouched.
fn sync_title_to_file_name(
    tx: &rusqlite::Connection,
    row: &util::DocRow,
    base: &str,
    now: &str,
) -> Result<(), ToolError> {
    if !meta::is_markdown_ext(&row.ext) || reserved::is_reserved_path(&row.path) {
        return Ok(());
    }
    let parts = meta::parse_document(&row.content);
    if parts.title.is_none() || parts.title.as_deref() == Some(base) {
        return Ok(());
    }
    let updates = std::collections::BTreeMap::from([(
        "title".to_string(),
        Value::String(base.to_string()),
    )]);
    let rewritten = meta::rewrite_document(&row.content, None, &updates, &row.ctime, now);
    tx.execute(
        "UPDATE blobs SET content = ?1 WHERE inode = ?2 AND rev = ?3",
        params![rewritten, row.inode, row.head_rev],
    )?;
    tx.execute(
        "UPDATE inodes SET size = ?1, hash = ?2 WHERE inode = ?3",
        params![
            rewritten.len() as i64,
            crate::vfs::content_hash(&rewritten),
            row.inode
        ],
    )?;
    crate::vfs::fts::index_document(tx, row.inode, &rewritten)?;
    if let Some(old_title) = parts.title.as_deref() {
        tx.execute(
            "UPDATE version_meta SET title = ?1
             WHERE inode = ?2 AND rev = ?3 AND is_manual = 0 AND title = ?4",
            params![base, row.inode, row.head_rev, old_title],
        )?;
    }
    Ok(())
}

/// 批量软删除（进入回收站）。
pub fn delete_many(vfs: &mut VirtualFs, ids: &[i64]) -> Result<(), ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    let now = util::now(&tx)?;
    for id in ids {
        tx.execute(
            "UPDATE inodes SET status = 'deleted', deleted_at = ?1, mtime = ?1
             WHERE inode = ?2 AND kind = 'file' AND status = 'active'",
            params![now, id],
        )?;
        // 回收站内容不可被检索；恢复时再重建索引行。
        crate::vfs::fts::remove_document(&tx, *id)?;
    }
    tx.commit()?;
    Ok(())
}

/// 从回收站恢复。
pub fn restore_many(vfs: &mut VirtualFs, ids: &[i64]) -> Result<(), ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    for id in ids {
        tx.execute(
            "UPDATE inodes SET status = 'active', deleted_at = NULL
             WHERE inode = ?1 AND kind = 'file'",
            params![id],
        )?;
        // Refresh the search row so a restored document is searchable again.
        let content: Option<String> = tx
            .query_row(
                "SELECT COALESCE(b.content, '')
                 FROM inodes i
                 LEFT JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
                 WHERE i.inode = ?1 AND i.kind = 'file'",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(content) = content {
            crate::vfs::fts::index_document(&tx, *id, &content)?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// 物理删除回收站中的文档（blobs/frontmatter/version 级联删除）。
pub fn purge_many(vfs: &mut VirtualFs, ids: &[i64]) -> Result<(), ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    for id in ids {
        crate::vfs::fts::remove_document(&tx, *id)?;
        tx.execute(
            "DELETE FROM inodes WHERE inode = ?1 AND kind = 'file' AND status = 'deleted'",
            params![id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 清空回收站。
pub fn empty_trash(vfs: &mut VirtualFs) -> Result<(), ToolError> {
    crate::vfs::fts::remove_deleted(vfs.conn_mut())?;
    vfs.conn_mut()
        .execute("DELETE FROM inodes WHERE kind = 'file' AND status = 'deleted'", [])?;
    Ok(())
}

/// 批量置顶/取消置顶。
pub fn set_pinned(vfs: &mut VirtualFs, ids: &[i64], pinned: bool) -> Result<(), ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    for id in ids {
        tx.execute(
            "UPDATE inodes SET pinned = ?1 WHERE inode = ?2 AND kind = 'file'",
            params![pinned as i64, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 批量移动笔记到文件夹；folder_id 为 None 或负数时移动到默认根。
pub fn move_many(
    vfs: &mut VirtualFs,
    ids: &[i64],
    folder_id: Option<i64>,
) -> Result<(), ToolError> {
    let tx = vfs.conn_mut().transaction()?;
    let target_dir = match folder_id {
        Some(id) if id >= 0 => folder_path(&tx, id)?,
        _ => NOTES_ROOT.to_string(),
    };
    for id in ids {
        // 只移动笔记：类型由路径根目录决定，因此不必读取正文。
        let row: Option<(String, String)> = {
            let mut stmt = tx.prepare(
                "SELECT i.path, i.ext
                 FROM inodes i
                 WHERE i.inode = ?1 AND i.kind = 'file' AND i.status = 'active'",
            )?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(r) => Some((r.get(0)?, r.get(1)?)),
                None => None,
            }
        };
        let Some((path, ext)) = row else {
            return Err(ToolError::NotFound {
                path: format!("doc#{id}"),
            });
        };
        let kind = meta::infer_kind(&path);
        if kind != "note" {
            return Err(ToolError::invalid("只有笔记可以移动文件夹"));
        }
        if parent_dir(&path) == target_dir.as_str() {
            continue;
        }
        let base = stem(&path, &ext).to_string();
        let new_path = unique_file_path(&tx, &target_dir, &base, &ext)?;
        tx.execute(
            "UPDATE inodes SET path = ?1, mtime = datetime('now','localtime') WHERE inode = ?2",
            params![new_path, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Move documents to an arbitrary virtual directory, keeping their kind.
///
/// Used by the long-press menu for folders outside the notes namespace, where
/// `folder_id` is not meaningful. Reserved config directories are rejected.
pub fn move_many_to_dir(
    vfs: &mut VirtualFs,
    ids: &[i64],
    target_dir: &str,
) -> Result<(), ToolError> {
    let target_dir = cap_gate::normalize_path(target_dir)?;
    if reserved::is_reserved_path(&target_dir) {
        return Err(ToolError::invalid("不能移动到配置目录"));
    }
    let kind: Option<String> = vfs
        .conn()
        .query_row(
            "SELECT kind FROM inodes WHERE path = ?1 AND status = 'active'",
            params![target_dir],
            |r| r.get(0),
        )
        .optional()?;
    if kind.as_deref() != Some("directory") {
        return Err(ToolError::NotFound { path: target_dir });
    }

    let tx = vfs.conn_mut().transaction()?;
    for id in ids {
        let row: Option<(String, String)> = tx
            .query_row(
                "SELECT path, ext FROM inodes
                 WHERE inode = ?1 AND kind = 'file' AND status = 'active'",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((path, ext)) = row else {
            return Err(ToolError::NotFound {
                path: format!("doc#{id}"),
            });
        };
        if parent_dir(&path) == target_dir {
            continue;
        }
        let base = stem(&path, &ext).to_string();
        let new_path = unique_file_path(&tx, &target_dir, &base, &ext)?;
        tx.execute(
            "UPDATE inodes SET path = ?1, mtime = datetime('now','localtime') WHERE inode = ?2",
            params![new_path, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Restrict to a recursive virtual-directory scope such as `/life/ai_default`.
/// The prefix is validated so a caller cannot widen the query to arbitrary paths.
fn push_root_filter(
    sql: &mut String,
    args: &mut Vec<SqlValue>,
    raw_root: &str,
) -> Result<(), ToolError> {
    let root = raw_root.trim().trim_end_matches('/');
    let life_prefix = format!("{}/", cap_gate::ROOT);
    if !root.starts_with(&life_prefix) || root.contains("..") {
        return Err(ToolError::invalid(format!("未知目录范围: {raw_root}")));
    }
    sql.push_str(" AND i.path LIKE ? ESCAPE '\\'");
    args.push(SqlValue::Text(format!(
        "{}%",
        cap_gate::escape_like(&format!("{root}/"))
    )));
    Ok(())
}

fn push_direct_child_filter(sql: &mut String, args: &mut Vec<SqlValue>, dir: &str) {
    let prefix = format!("{dir}/");
    sql.push_str(
        " AND i.path LIKE ? ESCAPE '\\'
          AND instr(substr(i.path, length(?) + 1), '/') = 0",
    );
    args.push(SqlValue::Text(format!(
        "{}%",
        cap_gate::escape_like(&prefix)
    )));
    args.push(SqlValue::Text(prefix));
}

fn sort_docs(docs: &mut [Doc], sort: &str) {
    docs.sort_by(|a, b| {
        let pinned = b.pinned.cmp(&a.pinned);
        if pinned != std::cmp::Ordering::Equal {
            return pinned;
        }
        let order = match sort {
            "created" => b.created_at.cmp(&a.created_at),
            "title" => a.title.to_lowercase().cmp(&b.title.to_lowercase()),
            "date" => doc_date(a)
                .unwrap_or_default()
                .cmp(&doc_date(b).unwrap_or_default())
                .then_with(|| {
                    util::field_str(&a.fields, "startTime")
                        .unwrap_or_default()
                        .cmp(&util::field_str(&b.fields, "startTime").unwrap_or_default())
                }),
            _ => b.updated_at.cmp(&a.updated_at),
        };
        order.then_with(|| b.id.cmp(&a.id))
    });
}
