//! Single source of truth for the `life.db` schema.
//!
//! This module no longer carries incremental migrations. A fresh database is
//! created in one transaction (`create`) and stamped with `user_version =
//! SCHEMA_VERSION`.
//! Opening an older or unexpected database is handled one layer up: `db::init`
//! closes it, deletes the file (plus `-wal` / `-shm`) and lets `create` build
//! the schema again. See `db/mod.rs`.
//!
//! Design principle stays the same: documents are data. Notes, todos, contacts
//! and schedules are Markdown under `/life/`; SQLite only owns the namespace,
//! revision chains, structured mirrors and search indexes. FTS5 is maintained
//! by the application inside the same transaction (there are no triggers).

use rusqlite::{params, Connection};

/// Version stamped on databases created by this module.
pub const SCHEMA_VERSION: i64 = 4;

/// Virtual file system root, kept in sync with `vfs::cap_gate::ROOT`.
const ROOT: &str = "/life";

/// Directories that must exist right after the first launch.
const DEFAULT_DIRS: &[&str] = &[
    ROOT,
    "/life/diary",
    "/life/notes",
    "/life/todos",
    "/life/contacts",
    "/life/schedule",
    "/life/agent",
    "/life/.agents",
    "/life/.agents/skills",
];

/// Chinese display titles seeded into `meta` for the system folders.
const DEFAULT_DIR_TITLES: &[(&str, &str)] = &[
    ("/life/notes", "默认"),
    ("/life/diary", "日记"),
    ("/life/todos", "待办"),
    ("/life/contacts", "联系人"),
    ("/life/schedule", "日程"),
    ("/life/agent", "AI 工作区"),
];

/// Default ACL for the Agent principal. Everything else stays default-deny.
const ACL_SEEDS: &[(&str, &str)] = &[
    ("/life/agent", "allow-read"),
    ("/life/agent", "allow-write"),
    ("/life/.agents", "allow-read"),
    ("/life/.agents", "allow-write"),
];

/// Tables that must exist when `user_version` already matches.
///
/// A stamped file could still be empty or broken, so two representative tables
/// are probed: the namespace and the history baseline. Anything more detailed
/// is unnecessary before the first release; a mismatch is rebuilt anyway.
const REQUIRED_TABLES: &[&str] = &["inodes", "version_bases"];

/// Full DDL for a brand-new database. Every table, index and the FTS5
/// definition lives here exactly once.
const SCHEMA: &str = "
-- Filesystem namespace: one inode per path, directories included.
CREATE TABLE inodes (
    inode      INTEGER PRIMARY KEY,
    path       TEXT NOT NULL UNIQUE,          -- normalized /life/... path
    kind       TEXT NOT NULL CHECK (kind IN ('directory', 'file')),
    head_rev   INTEGER NOT NULL DEFAULT 0,    -- current revision pointer
    size       INTEGER NOT NULL DEFAULT 0,
    ctime      TEXT NOT NULL,
    mtime      TEXT NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,    -- soft delete, restorable
    pinned     INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT                           -- NULL while visible
);
CREATE INDEX idx_inode_path ON inodes(path);
CREATE INDEX idx_inode_kind ON inodes(kind, deleted);
CREATE INDEX idx_inode_pinned ON inodes(kind, deleted, pinned);

-- Live head body. Autosave rewrites this one row in place; history lives
-- below in version_bases / version_diffs.
CREATE TABLE blobs (
    inode      INTEGER NOT NULL,
    rev        INTEGER NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT 'user',  -- user | agent | import
    created_at TEXT NOT NULL,
    PRIMARY KEY (inode, rev),
    FOREIGN KEY (inode) REFERENCES inodes(inode) ON DELETE CASCADE
);

-- Frontmatter mirror, refreshed together with blobs.
CREATE TABLE meta (
    inode  INTEGER PRIMARY KEY,
    kind   TEXT,
    title  TEXT,
    status TEXT,
    due    TEXT,
    tags   TEXT,                              -- normalized comma list
    extra  TEXT,                              -- JSON bag per document type
    FOREIGN KEY (inode) REFERENCES inodes(inode) ON DELETE CASCADE
);
CREATE INDEX idx_meta_kind_status ON meta(kind, status);
CREATE INDEX idx_meta_due ON meta(due) WHERE due IS NOT NULL;

-- Search index: text is CJK-spaced before indexing; see vfs/fts.rs.
CREATE VIRTUAL TABLE fts_docs USING fts5(
    title,
    content,
    content_rowid=rowid,
    tokenize='unicode61 remove_diacritics 2'
);

-- History baseline: exactly one full Markdown copy per document.
CREATE TABLE version_bases (
    inode      INTEGER PRIMARY KEY,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (inode) REFERENCES inodes(inode) ON DELETE CASCADE
);

-- Later recorded revisions, each relative to the previous recorded revision.
CREATE TABLE version_diffs (
    inode      INTEGER NOT NULL,
    rev        INTEGER NOT NULL,
    diff       TEXT NOT NULL,                 -- unified diff
    created_at TEXT NOT NULL,
    PRIMARY KEY (inode, rev),
    FOREIGN KEY (inode) REFERENCES inodes(inode) ON DELETE CASCADE
);

-- Pure ledger: title snapshot for lists, labels and manual flag. No body.
CREATE TABLE version_meta (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    inode             INTEGER NOT NULL,
    rev               INTEGER NOT NULL,
    title             TEXT NOT NULL DEFAULT '',
    kind              TEXT NOT NULL CHECK (kind IN ('baseline', 'snapshot', 'restore', 'agent')),
    label             TEXT,
    label_description TEXT,
    is_manual         INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    UNIQUE (inode, rev),
    FOREIGN KEY (inode) REFERENCES inodes(inode) ON DELETE CASCADE
);
CREATE INDEX idx_version_inode ON version_meta(inode, rev DESC);

-- Cross index: one row per dimension value for reverse lookups.
CREATE TABLE index_entries (
    inode     INTEGER NOT NULL,
    dimension TEXT NOT NULL,                  -- type | date | time | location | person | tag | due
    value     TEXT NOT NULL,
    PRIMARY KEY (inode, dimension, value),
    FOREIGN KEY (inode) REFERENCES inodes(inode) ON DELETE CASCADE
);
CREATE INDEX idx_index_lookup ON index_entries(dimension, value, inode);

-- Reserved for path-level permissions; CapGate does not enforce rules yet.
CREATE TABLE path_acl (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path_prefix TEXT NOT NULL,
    permission  TEXT NOT NULL,                -- allow-read | allow-write | deny
    principal   TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX idx_acl_prefix ON path_acl(path_prefix);

-- Agent conversations.
CREATE TABLE conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL DEFAULT '',
    provider   TEXT NOT NULL DEFAULT '',
    model      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);

-- Chat messages; tool calls are JSON, usage columns are NULL when not recorded.
CREATE TABLE messages (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id    INTEGER NOT NULL,
    role               TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content            TEXT NOT NULL DEFAULT '',
    tool_calls         TEXT,
    tool_call_id       TEXT,
    tool_name          TEXT,
    is_error           INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL,
    usage_input        INTEGER,
    usage_output       INTEGER,
    usage_total        INTEGER,
    usage_cache_read   INTEGER,
    usage_cache_write  INTEGER,
    thinking           TEXT,
    thinking_signature TEXT,
    run_id             INTEGER,               -- agent run that produced/owns this row
    tool_args          TEXT,                  -- JSON arguments for tool rows
    tool_duration_ms   INTEGER,               -- wall-clock tool duration
    is_partial         INTEGER,              -- 1 when the answer was cut short
    stop_reason        TEXT,                  -- stop | aborted | error
    steer_of_run       INTEGER,               -- non-null marks a steering message
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, id);
CREATE INDEX idx_messages_run ON messages(run_id);

-- Agent run ledger: one row per prompt/steer/resume/retry attempt. The unique
-- partial index allows many queued rows but only one executor per conversation.
CREATE TABLE agent_runs (
    run_id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id        INTEGER NOT NULL,
    status                 TEXT NOT NULL
                           CHECK (status IN ('queued', 'running', 'cancelling',
                                             'succeeded', 'failed', 'cancelled', 'interrupted')),
    trigger                TEXT NOT NULL CHECK (trigger IN ('prompt', 'steer', 'resume', 'retry')),
    model_entry            TEXT NOT NULL DEFAULT '',
    step_count             INTEGER NOT NULL DEFAULT 0,
    write_count            INTEGER NOT NULL DEFAULT 0,
    last_seq               INTEGER NOT NULL DEFAULT 0,
    partial                TEXT,              -- JSON {text} snapshot on cancel/failure
    error_code             TEXT,
    resume_from_message_id INTEGER,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    ended_at               TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_agent_runs_executing
    ON agent_runs(conversation_id) WHERE status IN ('running', 'cancelling');
CREATE INDEX idx_agent_runs_conversation ON agent_runs(conversation_id, run_id DESC);

-- Boundary events of one run; token deltas never persist. `seq` is monotonic
-- per run so a reconnecting client can replay everything after its cursor.
CREATE TABLE agent_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    kind       TEXT NOT NULL,                 -- state | assistant | error | end
    payload    TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE (run_id, seq),
    FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_events_run ON agent_events(run_id, seq);

-- Non-secret settings only; API keys live in the Rust secret store.
CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
";

/// True when the database was created by this build.
///
/// The version stamp is the primary check; the table probe only rejects a
/// stamped-but-broken file. Older structures are deleted and rebuilt by
/// `db::open_or_rebuild`, so no per-column compatibility check is needed.
pub fn is_current(conn: &Connection) -> rusqlite::Result<bool> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != SCHEMA_VERSION {
        return Ok(false);
    }
    for table in REQUIRED_TABLES {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![table],
            |row| row.get(0),
        )?;
        if count == 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

/// True when the file already contains application tables.
pub fn has_user_tables(conn: &Connection) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Build the final schema and stamp the version. Assumes an empty database.
pub fn create(conn: &mut Connection) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(SCHEMA)?;
    for path in DEFAULT_DIRS {
        tx.execute(
            "INSERT OR IGNORE INTO inodes (path, kind, head_rev, size, ctime, mtime)
             VALUES (?1, 'directory', 0, 0, datetime('now','localtime'), datetime('now','localtime'))",
            params![*path],
        )?;
    }
    for (path, title) in DEFAULT_DIR_TITLES {
        tx.execute(
            "INSERT OR IGNORE INTO meta (inode, kind, title, status, due, tags, extra)
             SELECT inode, 'folder', ?2, NULL, NULL, NULL, '{}'
             FROM inodes WHERE path = ?1",
            params![*path, *title],
        )?;
    }
    seed_acl(&tx)?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()
}

/// Idempotently ensure the system folders, display titles and default ACL rows.
/// Called on startup so databases created before `/life/agent` existed are healed
/// without any destructive migration.
pub fn ensure_default_dirs(conn: &Connection) -> rusqlite::Result<()> {
    for path in DEFAULT_DIRS {
        conn.execute(
            "INSERT OR IGNORE INTO inodes (path, kind, head_rev, size, ctime, mtime)
             VALUES (?1, 'directory', 0, 0, datetime('now','localtime'), datetime('now','localtime'))",
            params![*path],
        )?;
    }
    for (path, title) in DEFAULT_DIR_TITLES {
        conn.execute(
            "INSERT OR IGNORE INTO meta (inode, kind, title, status, due, tags, extra)
             SELECT inode, 'folder', ?2, NULL, NULL, NULL, '{}'
             FROM inodes WHERE path = ?1",
            params![*path, *title],
        )?;
    }
    seed_acl(conn)
}

/// Insert the default allow rules without duplicating existing ones.
fn seed_acl(conn: &Connection) -> rusqlite::Result<()> {
    for (prefix, permission) in ACL_SEEDS {
        conn.execute(
            "INSERT INTO path_acl (path_prefix, permission, principal, created_at)
             SELECT ?1, ?2, NULL, datetime('now','localtime')
             WHERE NOT EXISTS (
                 SELECT 1 FROM path_acl WHERE path_prefix = ?1 AND permission = ?2
             )",
            params![*prefix, *permission],
        )?;
    }
    Ok(())
}

/// Ensure the notes root exists with its display title.
/// Folder commands call this when a legacy or damaged database lacks them.
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

/// Root path constant used by the docs layer to validate folder ownership.
pub const NOTES_ROOT: &str = "/life/notes";
