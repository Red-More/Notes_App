//! M0 regression tests: CapGate, read/write chain, rev conflicts, trash,
//! version restore, cross index refresh, and write-source semantics.
//! Every case runs against an in-memory database, never the real `life.db`.

use rusqlite::params;
use serde_json::Value;

use crate::db;
use crate::docs::{self, types::DocFields, versions};
use crate::vfs::cap_gate;
use crate::vfs::error::ToolError;
use crate::vfs::types::*;
use crate::vfs::VirtualFs;

fn test_vfs() -> VirtualFs {
    let mut conn = rusqlite::Connection::open_in_memory().expect("open in-memory life.db");
    db::wal::configure(&conn).expect("apply wal pragmas");
    db::schema::migrate(&mut conn).expect("run schema migrations");
    VirtualFs::new(conn)
}

fn write_file(vfs: &mut VirtualFs, path: &str, content: &str, source: WriteSource) -> WriteReceipt {
    vfs.write(WriteRequest {
        path: path.to_string(),
        content: content.to_string(),
        create_parents: Some(true),
        auto_frontmatter: Some(true),
        source,
    })
    .expect("write should succeed")
}

fn edit_file(
    vfs: &mut VirtualFs,
    path: &str,
    old_string: &str,
    new_string: &str,
    expect_rev: Option<i64>,
    source: WriteSource,
) -> Result<EditReceipt, ToolError> {
    vfs.edit(EditRequest {
        path: path.to_string(),
        old_string: old_string.to_string(),
        new_string: new_string.to_string(),
        replace_all: None,
        expect_rev,
        source,
    })
}

fn read_file(vfs: &VirtualFs, path: &str) -> ReadResult {
    vfs.read(ReadRequest {
        path: path.to_string(),
        rev: None,
        start_line: None,
        end_line: None,
        include_meta: Some(true),
    })
    .expect("read should succeed")
}

fn inode_of(vfs: &VirtualFs, path: &str) -> i64 {
    vfs.conn()
        .query_row(
            "SELECT inode FROM inodes WHERE path = ?1",
            params![path],
            |row| row.get(0),
        )
        .expect("path should exist")
}

/// Returns `(blobs.source, version_meta.is_manual)` for one revision.
fn write_meta(vfs: &VirtualFs, inode: i64, rev: i64) -> (String, i64) {
    vfs.conn()
        .query_row(
            "SELECT b.source, COALESCE(v.is_manual, -1)
             FROM blobs b
             LEFT JOIN version_meta v ON v.inode = b.inode AND v.rev = b.rev
             WHERE b.inode = ?1 AND b.rev = ?2",
            params![inode, rev],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("blob should exist")
}

fn fields(pairs: &[(&str, Value)]) -> DocFields {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect()
}

#[test]
fn cap_gate_rejects_unsafe_paths() {
    let invalid = [
        "",
        "   ",
        "life/../etc",
        "a\\b",
        "/etc/passwd",
        "/life/../etc",
        "/life/\u{0}name",
    ];
    for raw in invalid {
        match cap_gate::normalize_path(raw) {
            Err(ToolError::PathEscape { .. }) | Err(ToolError::InvalidPath { .. }) => {}
            other => panic!("{raw:?} should be rejected, got {other:?}"),
        }
    }

    let long_segment = format!("/life/{}", "a".repeat(256));
    assert!(matches!(
        cap_gate::normalize_path(&long_segment),
        Err(ToolError::InvalidPath { .. })
    ));
    let long_path = format!("/life/{}", "a/".repeat(600));
    assert!(matches!(
        cap_gate::normalize_path(&long_path),
        Err(ToolError::InvalidPath { .. })
    ));

    assert_eq!(
        cap_gate::normalize_path("diary/x.md").unwrap(),
        "/life/diary/x.md"
    );
    assert_eq!(
        cap_gate::normalize_path("/life//diary/./x.md").unwrap(),
        "/life/diary/x.md"
    );

    assert!(matches!(
        cap_gate::ensure_writable("/life/.agents/skills/a.md"),
        Err(ToolError::ReadOnlyArea { .. })
    ));
    assert!(cap_gate::ensure_writable("/life/notes/a.md").is_ok());
}

#[test]
fn write_edit_read_grep_roundtrip() {
    let mut vfs = test_vfs();
    let receipt = write_file(
        &mut vfs,
        "diary/today",
        "# 今天\n吃了拉面",
        WriteSource::Agent,
    );
    assert_eq!(receipt.path, "/life/diary/today.md");
    assert_eq!(receipt.rev, 1);

    let ReadResult::File {
        rev,
        content,
        total_lines,
        meta,
        ..
    } = read_file(&vfs, &receipt.path)
    else {
        panic!("file path should not read as a directory");
    };
    assert_eq!(rev, 1);
    assert!(content.contains("吃了拉面"));
    assert!(total_lines >= 3, "frontmatter should add lines");
    assert_eq!(meta.unwrap().kind.as_deref(), Some("diary"));

    let edited = edit_file(
        &mut vfs,
        &receipt.path,
        "拉面",
        "寿司",
        Some(1),
        WriteSource::Agent,
    )
    .expect("edit with current rev should succeed");
    assert_eq!(edited.rev, 2);

    let grep = vfs
        .grep(GrepRequest {
            pattern: "寿司".into(),
            path: Some("/life/diary".into()),
            max_results: None,
            context_lines: None,
        })
        .expect("grep should succeed");
    assert_eq!(grep.total, 1);
    assert!(grep.fallback, "P1 grep must report LIKE fallback");
    assert_eq!(grep.hits[0].rev, 2);
    assert_eq!(grep.hits[0].path, "/life/diary/today.md");
}

#[test]
fn edit_expect_rev_rejects_stale_revision() {
    let mut vfs = test_vfs();
    let receipt = write_file(&mut vfs, "notes/conflict", "第一行", WriteSource::User);
    let path = receipt.path;

    let first = edit_file(
        &mut vfs,
        &path,
        "第一行",
        "第二行",
        Some(1),
        WriteSource::User,
    )
    .expect("first edit should pass");
    assert_eq!(first.rev, 2);

    let stale = edit_file(
        &mut vfs,
        &path,
        "第二行",
        "第三行",
        Some(1),
        WriteSource::User,
    );
    assert!(matches!(
        stale,
        Err(ToolError::Conflict {
            current: 2,
            expect: 1
        })
    ));
}

#[test]
fn soft_delete_restore_and_purge() {
    let mut vfs = test_vfs();
    let doc = docs::create(&mut vfs, "note", "回收站测试", "正文", None, None).unwrap();

    docs::delete_many(&mut vfs, &[doc.id]).unwrap();
    assert!(vfs
        .read(ReadRequest {
            path: doc.path.clone(),
            rev: None,
            start_line: None,
            end_line: None,
            include_meta: None,
        })
        .is_err());

    let trashed = docs::list(
        &vfs,
        docs::types::ListQuery {
            deleted: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(trashed.iter().any(|item| item.id == doc.id));

    docs::restore_many(&mut vfs, &[doc.id]).unwrap();
    assert!(matches!(
        read_file(&vfs, &doc.path),
        ReadResult::File { .. }
    ));

    docs::delete_many(&mut vfs, &[doc.id]).unwrap();
    docs::purge_many(&mut vfs, &[doc.id]).unwrap();
    let inodes: i64 = vfs
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM inodes WHERE inode = ?1",
            params![doc.id],
            |row| row.get(0),
        )
        .unwrap();
    let blobs: i64 = vfs
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM blobs WHERE inode = ?1",
            params![doc.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!((inodes, blobs), (0, 0), "purge must cascade to blobs");
}

#[test]
fn version_restore_appends_new_revision() {
    let mut vfs = test_vfs();
    let doc = docs::create(&mut vfs, "note", "版本测试", "第一版", None, None).unwrap();
    let saved = docs::save(
        &mut vfs,
        doc.id,
        None,
        Some("第二版".into()),
        None,
        None,
        None,
    )
    .expect("save should succeed");
    assert_eq!(saved.rev, 2);

    let history = versions::list(&vfs, doc.id, true).unwrap();
    let first = history
        .iter()
        .find(|version| version.version_number == 1)
        .expect("rev 1 should be tracked");

    let restored = versions::restore(&mut vfs, first.id).expect("restore should succeed");
    assert_eq!(restored.rev, 3);
    assert!(restored.content.contains("第一版"));

    let history_after = versions::list(&vfs, doc.id, true).unwrap();
    assert_eq!(history_after.len(), 3, "restore must append, not overwrite");
    let latest = history_after
        .iter()
        .find(|version| version.version_number == 3)
        .expect("restored rev should be tracked");
    assert_eq!(latest.is_manual, 1);
}

#[test]
fn cross_index_refreshes_on_write_and_save() {
    let mut vfs = test_vfs();
    let initial = fields(&[
        ("dueDate", Value::String("2026-10-30".into())),
        ("personId", Value::String("zhang-san".into())),
        ("tags", Value::Array(vec![Value::String("日语".into())])),
    ]);
    let doc = docs::create(&mut vfs, "todo", "买牛奶", "", None, Some(initial)).unwrap();

    assert_eq!(
        docs::index::query(&vfs, "person", "zhang-san", None, None)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        docs::index::query(&vfs, "tag", "日语", None, None)
            .unwrap()
            .len(),
        1
    );

    let update = fields(&[
        ("personId", Value::Null),
        ("tags", Value::Array(vec![Value::String("生活".into())])),
    ]);
    let saved = docs::save(
        &mut vfs,
        doc.id,
        None,
        Some("已完成".into()),
        Some(update),
        None,
        None,
    )
    .expect("save should refresh index");
    assert_eq!(saved.rev, 2);

    assert!(
        docs::index::query(&vfs, "person", "zhang-san", None, None)
            .unwrap()
            .is_empty(),
        "removed personId must drop its index row"
    );
    assert_eq!(
        docs::index::query(&vfs, "tag", "生活", None, None)
            .unwrap()
            .len(),
        1
    );
    assert!(docs::index::query(&vfs, "tag", "日语", None, None)
        .unwrap()
        .is_empty());
}

#[test]
fn export_markdown_and_zip_regression() {
    let mut vfs = test_vfs();
    let first = docs::create(&mut vfs, "note", "导出测试", "导出正文", None, None).unwrap();
    let second = docs::create(&mut vfs, "note", "第二篇", "正文二", None, None).unwrap();

    let markdown = docs::export::markdown(&vfs, first.id).unwrap();
    assert!(markdown.starts_with("---"));
    assert!(markdown.contains("导出正文"));

    let entries = docs::export::collect(&vfs, &[first.id, second.id]).unwrap();
    assert_eq!(entries.len(), 2);
    let bytes = docs::export::zip_entries(&entries).unwrap();
    let archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    assert_eq!(archive.len(), 2, "multi-doc export must contain both files");

    let folder_entries = docs::export::collect_folder(&vfs, -1).unwrap();
    assert_eq!(folder_entries.len(), 2);
    assert!(docs::export::zip_entries(&folder_entries).is_ok());
}

#[test]
fn write_source_semantics() {
    let mut vfs = test_vfs();

    let receipt = write_file(&mut vfs, "notes/agent", "agent body", WriteSource::Agent);
    let inode = inode_of(&vfs, &receipt.path);
    assert_eq!(
        write_meta(&vfs, inode, 1),
        ("agent".to_string(), 0),
        "fs_write must record agent source without a manual snapshot"
    );

    let doc = docs::create(&mut vfs, "note", "用户写入", "正文", None, None).unwrap();
    assert_eq!(
        write_meta(&vfs, doc.id, 1),
        ("user".to_string(), 0),
        "doc_create must record user source without a manual snapshot"
    );

    let saved = docs::save(
        &mut vfs,
        doc.id,
        None,
        Some("自动保存".into()),
        None,
        None,
        None,
    )
    .unwrap();
    assert_eq!(write_meta(&vfs, doc.id, saved.rev), ("user".to_string(), 0));

    let snapshot = versions::create(&mut vfs, doc.id).unwrap();
    assert_eq!(
        write_meta(&vfs, doc.id, snapshot.version_number),
        ("user".to_string(), 1),
        "version_create must mark the snapshot as manual"
    );
}
