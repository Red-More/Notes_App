//! VirtualFs 的库表结构与迁移。
//!
//! 设计原则是“文档即数据”：待办、联系人、行程全部是 `/life/` 下的 Markdown，
//! SQLite 只负责命名空间、版本（rev）、结构化索引与检索。
//! `user_version` 记录 schema 版本，迁移必须可叠加：fresh DB 从 v0 逐步升级。
//!
//! v1：inodes / blobs / meta / fts_docs + 默认目录。
//! v2：软删时间、置顶位、版本台账、交叉索引、路径 ACL 预留表。
//! v3：Agent 会话表（conversations / messages）与非密钥设置表（settings）。
//! v4：媒体作业表（media_jobs）与媒体资产表（media_assets）。
//! v5：媒体作业结果列（media_jobs.result）。
//! v6：媒体作业支持 `asr` 类型（重建 CHECK 约束）。
//! FTS5 索引在应用层与 blobs 同事务维护（无触发器），schema 版本保持不变。

use rusqlite::{params, Connection, OptionalExtension};

/// 当前 life.db schema 版本。
pub const SCHEMA_VERSION: i64 = 6;

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

-- FTS5：检索索引，由应用层在写事务内同步维护（`vfs::fts`）。
-- 索引文本对 CJK 逐字加空格，以支持中文短词；详见 `vfs/fts.rs` 的 ADR 说明。
CREATE VIRTUAL TABLE IF NOT EXISTS fts_docs USING fts5(
    title,
    content,
    content_rowid=rowid,
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

const V3_TABLES: &str = "
-- Agent 会话：只存标题与所用模型；消息单独一张表。
CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL DEFAULT '',
    provider   TEXT NOT NULL DEFAULT '',
    model      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

-- 消息：role 为 user | assistant | tool；assistant 的工具调用以 JSON 存 tool_calls。
CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content         TEXT NOT NULL DEFAULT '',
    tool_calls      TEXT,
    tool_call_id    TEXT,
    tool_name       TEXT,
    is_error        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);

-- 设置：只存非敏感配置（provider/model/偏好）；API Key 走 Rust 私有文件，不入库。
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
";

const V4_TABLES: &str = "
-- 媒体作业：与 Agent run 生命周期解耦，可取消、可在重启后恢复。
CREATE TABLE IF NOT EXISTS media_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL CHECK (kind IN ('image', 'video', 'tts', 'classify')),
    model_entry TEXT NOT NULL,
    params      TEXT NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
    progress    INTEGER NOT NULL DEFAULT 0,
    asset_id    INTEGER,
    error       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status, id);
CREATE INDEX IF NOT EXISTS idx_media_jobs_model ON media_jobs(model_entry);

-- 媒体资产：二进制落盘，库内只存元数据与内容哈希。
CREATE TABLE IF NOT EXISTS media_assets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256      TEXT NOT NULL UNIQUE,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    width       INTEGER,
    height      INTEGER,
    duration_ms INTEGER,
    source_job  INTEGER,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_assets_created ON media_assets(created_at DESC);
";

/// 迁移用的列探测：表/列名均为本模块常量，格式化进 SQL 安全。
fn table_has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let sql = format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'");
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
        tx.pragma_update(None, "user_version", 2)?;
        tx.commit()?;
        version = 2;
    }

    if version < 3 {
        let tx = conn.transaction()?;
        tx.execute_batch(V3_TABLES)?;
        tx.pragma_update(None, "user_version", 3)?;
        tx.commit()?;
        version = 3;
    }

    if version < 4 {
        let tx = conn.transaction()?;
        tx.execute_batch(V4_TABLES)?;
        tx.pragma_update(None, "user_version", 4)?;
        tx.commit()?;
        version = 4;
    }

    if version < 5 {
        let tx = conn.transaction()?;
        // Classification jobs keep their JSON answer in `result`.
        if !table_has_column(&tx, "media_jobs", "result")? {
            tx.execute_batch("ALTER TABLE media_jobs ADD COLUMN result TEXT;")?;
        }
        tx.pragma_update(None, "user_version", 5)?;
        tx.commit()?;
        version = 5;
    }

    if version < 6 {
        let tx = conn.transaction()?;
        // SQLite cannot alter a CHECK constraint: rebuild the jobs table so
        // speech-to-text jobs (`asr`) are accepted alongside the media kinds.
        tx.execute_batch(
            "CREATE TABLE media_jobs_v6 (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                kind        TEXT NOT NULL CHECK (kind IN ('image', 'video', 'tts', 'classify', 'asr')),
                model_entry TEXT NOT NULL,
                params      TEXT NOT NULL DEFAULT '{}',
                status      TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
                progress    INTEGER NOT NULL DEFAULT 0,
                asset_id    INTEGER,
                error       TEXT,
                result      TEXT,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
            INSERT INTO media_jobs_v6
                (id, kind, model_entry, params, status, progress, asset_id, error, result, created_at, updated_at)
            SELECT id, kind, model_entry, params, status, progress, asset_id, error, result, created_at, updated_at
            FROM media_jobs;
            DROP TABLE media_jobs;
            ALTER TABLE media_jobs_v6 RENAME TO media_jobs;
            CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status, id);
            CREATE INDEX IF NOT EXISTS idx_media_jobs_model ON media_jobs(model_entry);",
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

/// 修复旧库的 `fts_docs` 定义：`content_rowid=inode` 在没有外部内容表时
/// 会让 FTS5 的删除路径引用不存在的列。该表是派生索引，直接重建并由启动
/// 巡检回填，不改变 `user_version`。返回是否执行了重建。
pub fn repair_search_index(conn: &Connection) -> rusqlite::Result<bool> {
    let sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fts_docs'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let Some(sql) = sql else {
        return Ok(false);
    };
    if !sql.contains("content_rowid=inode") {
        return Ok(false);
    }
    conn.execute_batch(
        "DROP TABLE fts_docs;
         CREATE VIRTUAL TABLE fts_docs USING fts5(
             title,
             content,
             content_rowid=rowid,
             tokenize='unicode61 remove_diacritics 2'
         );",
    )?;
    Ok(true)
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
