//! VirtualFs 的库表结构与迁移。
//!
//! 设计原则是“文档即数据”：待办、联系人、行程全部是 `/life/` 下的 Markdown，
//! SQLite 只负责命名空间、版本（rev）与可检索性。`user_version` 记录 schema 版本。
//!
//! P1 只建表与默认目录；FTS5 触发器与索引维护按设计文档留到 P2。

use rusqlite::{params, Connection};

/// 当前 life.db schema 版本。
pub const SCHEMA_VERSION: i64 = 1;

/// 虚拟文件系统的根路径，与 `vfs::cap_gate::ROOT` 保持一致。
const ROOT: &str = "/life";

/// 默认目录：启动即可被 `read` 列出的空命名空间。
const DEFAULT_DIRS: &[&str] = &[
    ROOT,
    "/life/diary",
    "/life/notes",
    "/life/todos",
    "/life/contacts",
    "/life/schedule",
    "/life/.agents",
    "/life/.agents/skills",
];

const VFS_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS inodes (
    inode      INTEGER PRIMARY KEY,
    path       TEXT NOT NULL UNIQUE,          -- 规范化的 /life/... 路径
    kind       TEXT NOT NULL CHECK (kind IN ('directory', 'file')),
    head_rev   INTEGER NOT NULL DEFAULT 0,    -- 当前版本指针
    size       INTEGER NOT NULL DEFAULT 0,
    ctime      TEXT NOT NULL,
    mtime      TEXT NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0     -- 软删，可恢复
);
CREATE INDEX IF NOT EXISTS idx_inode_path ON inodes(path);
CREATE INDEX IF NOT EXISTS idx_inode_kind ON inodes(kind, deleted);

-- 版本化内容：同一 inode 的每个 rev 一行，写即追加、永不覆盖。
CREATE TABLE IF NOT EXISTS blobs (
    inode      INTEGER NOT NULL,
    rev        INTEGER NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT 'user',  -- user | agent | import
    created_at TEXT NOT NULL,
    PRIMARY KEY (inode, rev),
    FOREIGN KEY (inode) REFERENCES inodes(inode) ON DELETE CASCADE
);

-- frontmatter 镜像：结构化查询用，写时与 blobs 同事务维护。
CREATE TABLE IF NOT EXISTS meta (
    inode      INTEGER PRIMARY KEY,
    kind       TEXT,
    title      TEXT,
    status     TEXT,
    due        TEXT,
    tags       TEXT,                          -- 规范化逗号分隔
    extra      TEXT,                          -- JSON，各类型自留地
    FOREIGN KEY (inode) REFERENCES inodes(inode) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_meta_kind_status ON meta(kind, status);
CREATE INDEX IF NOT EXISTS idx_meta_due ON meta(due) WHERE due IS NOT NULL;

-- FTS5：P1 只建表，触发器与索引维护留到 P2；grep 先走 LIKE 回退。
CREATE VIRTUAL TABLE IF NOT EXISTS fts_docs USING fts5(
    title,
    content,
    content_rowid=inode,
    tokenize='unicode61 remove_diacritics 2'
);
";

/// 按 `user_version` 执行迁移。fresh DB 一次到最新，已是最新则 no-op。
pub fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version >= SCHEMA_VERSION {
        if version > SCHEMA_VERSION {
            log::warn!(
                "life.db schema v{version} is newer than supported v{SCHEMA_VERSION}"
            );
        }
        return Ok(());
    }

    let tx = conn.transaction()?;
    tx.execute_batch(VFS_SCHEMA)?;
    for path in DEFAULT_DIRS {
        tx.execute(
            "INSERT OR IGNORE INTO inodes (path, kind, head_rev, size, ctime, mtime)
             VALUES (?1, 'directory', 0, 0, datetime('now','localtime'), datetime('now','localtime'))",
            params![*path],
        )?;
    }
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()?;
    Ok(())
}
