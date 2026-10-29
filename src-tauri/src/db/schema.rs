//! VirtualFs 的库表结构与迁移。
//!
//! 设计原则是“文档即数据”：待办、联系人、行程全部是 `/life/` 下的 Markdown，
//! SQLite 只负责命名空间、版本（rev）、结构化索引与检索。
//! `user_version` 记录 schema 版本，迁移必须可叠加：fresh DB 从 v0 逐步升级。
//!
//! v1：inodes / blobs / meta / fts_docs + 默认目录。
//! v2：软删时间、置顶位、版本台账、交叉索引、路径 ACL 预留表。
//! FTS5 触发器与索引维护仍留到 P2，grep 暂时走 LIKE 回退。

use rusqlite::{params, Connection};

/// 当前 life.db schema 版本。
pub const SCHEMA_VERSION: i64 = 2;

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

const V1_SCHEMA: &str = "
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

const V2_TABLES: &str = "
CREATE INDEX IF NOT EXISTS idx_inode_pinned ON inodes(kind, deleted, pinned);

-- 版本台账：给 UI 一个全局 version_id，并保存手工标记/标签。
CREATE TABLE IF NOT EXISTS version_meta (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    inode             INTEGER NOT NULL,
    rev               INTEGER NOT NULL,
    label             TEXT,
    label_description TEXT,
    is_manual         INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    UNIQUE (inode, rev),
    FOREIGN KEY (inode) REFERENCES inodes(inode) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_version_inode ON version_meta(inode, rev DESC);

-- 交叉索引：一行一个维度值，支持按人物/日期/地点/标签反向查文档。
CREATE TABLE IF NOT EXISTS index_entries (
    inode     INTEGER NOT NULL,
    dimension TEXT NOT NULL,                 -- type | date | time | location | person | tag | due
    value     TEXT NOT NULL,
    PRIMARY KEY (inode, dimension, value),
    FOREIGN KEY (inode) REFERENCES inodes(inode) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_index_lookup ON index_entries(dimension, value, inode);

-- 路径权限：本期只预留表结构，CapGate 尚未强制读取。
CREATE TABLE IF NOT EXISTS path_acl (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path_prefix TEXT NOT NULL,
    permission  TEXT NOT NULL,               -- allow-read | allow-write | deny
    principal   TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acl_prefix ON path_acl(path_prefix);
";

/// 迁移用的列探测：表/列名均为本模块常量，格式化进 SQL 安全。
fn table_has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let sql = format!(
        "SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"
    );
    let n: i64 = conn.query_row(&sql, [], |r| r.get(0))?;
    Ok(n > 0)
}

/// 按 `user_version` 逐级迁移。fresh DB 从 v1 走到 v2，已是最新则 no-op。
pub fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let mut version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;

    if version < 1 {
        let tx = conn.transaction()?;
        tx.execute_batch(V1_SCHEMA)?;
        for path in DEFAULT_DIRS {
            tx.execute(
                "INSERT OR IGNORE INTO inodes (path, kind, head_rev, size, ctime, mtime)
                 VALUES (?1, 'directory', 0, 0, datetime('now','localtime'), datetime('now','localtime'))",
                params![*path],
            )?;
        }
        tx.pragma_update(None, "user_version", 1)?;
        tx.commit()?;
        version = 1;
    }

    if version < 2 {
        let tx = conn.transaction()?;
        // 分步 ALTER：迁移中断后重跑不会因重复列失败。
        if !table_has_column(&tx, "inodes", "pinned")? {
            tx.execute_batch("ALTER TABLE inodes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;")?;
        }
        if !table_has_column(&tx, "inodes", "deleted_at")? {
            tx.execute_batch("ALTER TABLE inodes ADD COLUMN deleted_at TEXT;")?;
        }
        tx.execute_batch(V2_TABLES)?;
        // 默认文件夹的显示名存在 meta.title；路径本身保持稳定。
        tx.execute(
            "INSERT OR IGNORE INTO meta (inode, kind, title, status, due, tags, extra)
             SELECT inode, 'folder', '默认', NULL, NULL, NULL, '{}'
             FROM inodes WHERE path = ?1",
            params!["/life/notes"],
        )?;
        // 既有 blobs 补版本台账，保证 UI 能回溯全部历史 rev。
        tx.execute(
            "INSERT OR IGNORE INTO version_meta
                 (inode, rev, label, label_description, is_manual, created_at)
             SELECT inode, rev, NULL, NULL, 0, created_at FROM blobs",
            [],
        )?;
        // 每个文档至少保留一个可见的“初始版本”。
        tx.execute(
            "UPDATE version_meta SET is_manual = 1
             WHERE rev = (SELECT MIN(v2.rev) FROM version_meta v2
                          WHERE v2.inode = version_meta.inode)",
            [],
        )?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        tx.commit()?;
        version = SCHEMA_VERSION;
    }

    if version > SCHEMA_VERSION {
        log::warn!("life.db schema v{version} is newer than supported v{SCHEMA_VERSION}");
    }
    Ok(())
}

/// 确保 Notes 根目录存在并带有显示名（默认 `默认`）。
/// 目录被误删或旧库缺 meta 时，folder 命令会调用这里兜底。
pub fn ensure_notes_root(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO inodes (path, kind, head_rev, size, ctime, mtime)
         VALUES ('/life/notes', 'directory', 0, 0, datetime('now','localtime'), datetime('now','localtime'))",
        [],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO meta (inode, kind, title, status, due, tags, extra)
         SELECT inode, 'folder', '默认', NULL, NULL, NULL, '{}'
         FROM inodes WHERE path = '/life/notes'",
        [],
    )?;
    Ok(())
}

/// 根路径常量，供 docs 层校验目录归属。
pub const NOTES_ROOT: &str = "/life/notes";
