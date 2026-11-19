//! Single source of truth for the `life.db` schema.
//!
//! This module no longer carries incremental migrations. A fresh database is
//! created in one transaction (`create`) and stamped with `user_version =
//! SCHEMA_VERSION`.
//! Opening an older or unexpected database is handled one layer up: `db::init`
//! closes it, deletes the file (plus `-wal` / `-shm`) and lets `create` build
//! the schema again. See `db/mod.rs`.
//!
//! Design principle stays the same: documents are data. Notes, diary entries,
//! todos and contacts are Markdown under `/life/`; SQLite only owns the namespace,
//! revision chains, structured mirrors and search indexes. FTS5 is maintained
//! by the application inside the same transaction (there are no triggers).

use rusqlite::{params, Connection, OptionalExtension};

/// Version stamped on databases created by this module.
pub const SCHEMA_VERSION: i64 = 7;

/// Virtual file system root, kept in sync with `vfs::cap_gate::ROOT`.
const ROOT: &str = "/life";

/// Directories that must exist right after the first launch.
const DEFAULT_DIRS: &[&str] = &[
    ROOT,
    "/life/diary",
    "/life/notes",
    "/life/todos",
    "/life/contacts",
    "/life/ai_default",
    "/life/.agent",
    "/life/.agent/skills",
    "/life/.lifeos",
];

/// Chinese display titles seeded into `dir_titles` for the system folders.
const DEFAULT_DIR_TITLES: &[(&str, &str)] = &[
    ("/life/notes", "默认"),
    ("/life/diary", "日记"),
    ("/life/todos", "待办"),
    ("/life/contacts", "联系人"),
    ("/life/ai_default", "AI 工作区"),
];

/// Pre-release path renames applied once per database.
///
/// `.agents` became `.agent` (model config) and the old `agent` workspace
/// became `ai_default`. Both are pure path migrations: inode ids, history and
/// search rows stay attached to the moved nodes.
const LEGACY_RENAMES: &[(&str, &str)] = &[
    ("/life/.agents", "/life/.agent"),
    ("/life/agent", "/life/ai_default"),
];

/// System directories that no longer exist and must not linger in the tree.
///
/// 日程 used to be seeded as a top-level folder; the feature moved to the diary
/// and todo tabs, so the seed is gone. An old database still carries the empty
/// directory row (with its 日程 label), which kept showing up in the notes
/// page's browse list. Cleanup is conservative: the row is only dropped while
/// the folder holds nothing, so anything the user put there survives.
const LEGACY_EMPTY_DIRS: &[&str] = &["/life/schedule"];

/// Tables that must exist when `user_version` already matches.
///
/// A stamped file could still be empty or broken, so two representative tables
/// are probed: the namespace and the history baseline. Anything more detailed
/// is unnecessary before the first release; a mismatch is rebuilt anyway.
const REQUIRED_TABLES: &[&str] = &["inodes", "version_bases"];

/// Full DDL for a brand-new database. Every table, index and the FTS5
/// definition lives here exactly once.
const SCHEMA: &str = "
-- Base file layer: one row per path, files and directories alike.
--
-- This table is system-maintained only: file id, path, type, extension, size,
-- content hash, lifecycle status and timestamps. Frontmatter never lives here.
CREATE TABLE inodes (
    inode      INTEGER PRIMARY KEY,           -- file id
    path       TEXT NOT NULL UNIQUE,          -- normalized /life/... path
    kind       TEXT NOT NULL CHECK (kind IN ('directory', 'file')),
    ext        TEXT NOT NULL DEFAULT '',      -- case preserved; '' = no extension
    head_rev   INTEGER NOT NULL DEFAULT 0,    -- current revision pointer
    size       INTEGER NOT NULL DEFAULT 0,
    hash       TEXT,                          -- RESERVED: sha256 of the head body
    status     TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'archived', 'deleted')),
    pinned     INTEGER NOT NULL DEFAULT 0,    -- user-level flag, not frontmatter
    ctime      TEXT NOT NULL,
    mtime      TEXT NOT NULL,
    deleted_at TEXT                           -- NULL unless status = 'deleted'
);
CREATE INDEX idx_inode_path ON inodes(path);
CREATE INDEX idx_inode_kind ON inodes(kind, status);
CREATE INDEX idx_inode_pinned ON inodes(kind, status, pinned);

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

-- Markdown frontmatter is NOT mirrored here: it is part of the file body and
-- parsed on demand. Only directory display names need a system-side table.

-- Directory display names. Folder renames only change this label; the path
-- segment stays stable, and folders are not documents (no frontmatter).
CREATE TABLE dir_titles (
    inode INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    FOREIGN KEY (inode) REFERENCES inodes(inode) ON DELETE CASCADE
);

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

-- Agent conversations. `last_message_at` stays NULL until the first message
-- commits; the chat list only shows conversations with a non-NULL value.
CREATE TABLE conversations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT NOT NULL DEFAULT '',
    provider        TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    last_message_at TEXT
);
CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);
CREATE INDEX idx_conversations_last_message ON conversations(last_message_at);

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
    thinking_duration_ms INTEGER,             -- wall-clock reasoning duration
    is_partial         INTEGER,              -- 1 when the answer was cut short
    stop_reason        TEXT,                  -- stop | aborted | error
    steer_of_run       INTEGER,               -- non-null marks a steering message
    image_asset_ids    TEXT,                  -- JSON array; user rows may carry images
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

-- Image assets referenced by notes (`asset:<id>`) and chat messages. Bytes
-- live under the app-data `assets/` directory, sharded by hash prefix.
CREATE TABLE assets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256     TEXT NOT NULL UNIQUE,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    width      INTEGER,
    height     INTEGER,
    created_at TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'import'
);
CREATE INDEX idx_assets_created ON assets(created_at DESC);
";

/// Store-owned schema version (`PRAGMA user_version`).
pub fn schema_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
}

/// True when the database was created by this build.
///
/// The version stamp is the primary check; the table probe only rejects a
/// stamped-but-broken file. An *older* version is upgraded in place by
/// [`migrate`] (see `db::open_or_rebuild`); only a newer or structurally broken
/// file is rebuilt.
pub fn is_current(conn: &Connection) -> rusqlite::Result<bool> {
    if schema_version(conn)? != SCHEMA_VERSION {
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
            "INSERT OR IGNORE INTO dir_titles (inode, title)
             SELECT inode, ?2 FROM inodes WHERE path = ?1",
            params![*path, *title],
        )?;
    }
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()
}

/// Upgrade an older database in place and stamp it as current.
///
/// Every statement runs inside one transaction, so a failure rolls the whole
/// upgrade back and leaves the file with its previous structure — openable and
/// retryable on the next launch. Nothing user-visible is dropped: the only
/// table removed is `meta`, whose folder rows are copied into `dir_titles`
/// first and whose document rows are redundant (frontmatter already lives in
/// the Markdown body, which is the VFS source of truth).
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    // The cross index was removed: it was pure derived data rebuilt on every
    // Markdown write and never read by the UI. Dropping the table in place
    // keeps existing documents untouched.
    tx.execute("DROP TABLE IF EXISTS index_entries", [])?;
    if table_exists(&tx, "conversations")?
        && !column_exists(&tx, "conversations", "last_message_at")?
    {
        tx.execute(
            "ALTER TABLE conversations ADD COLUMN last_message_at TEXT",
            [],
        )?;
        // Backfill from the transcript so existing conversations stay visible.
        if table_exists(&tx, "messages")? {
            tx.execute(
                "UPDATE conversations
                 SET last_message_at = (SELECT MAX(created_at) FROM messages m
                                        WHERE m.conversation_id = conversations.id)",
                [],
            )?;
        }
    }
    if table_exists(&tx, "conversations")? {
        tx.execute(
            "CREATE INDEX IF NOT EXISTS idx_conversations_last_message
             ON conversations(last_message_at)",
            [],
        )?;
    }
    // Reasoning duration joined the message row later; old databases keep
    // their data and gain the column in place.
    if table_exists(&tx, "messages")? && !column_exists(&tx, "messages", "thinking_duration_ms")? {
        tx.execute(
            "ALTER TABLE messages ADD COLUMN thinking_duration_ms INTEGER",
            [],
        )?;
    }
    migrate_file_layers(&tx)?;
    // Stamped only after every statement above succeeded.
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()
}

/// Split the base file layer from the Markdown content layer.
///
/// Older databases kept directory labels and document frontmatter in the same
/// `meta` table and used a single `deleted` flag for lifecycle. Frontmatter is
/// already stored in the Markdown body, so only directory labels are carried
/// over; the legacy table is then dropped and `deleted` becomes `status`.
///
/// This runs inside [`migrate`]'s transaction: a failure here rolls back the
/// whole upgrade instead of leaving a half-migrated file.
pub(crate) fn migrate_file_layers(conn: &Connection) -> rusqlite::Result<()> {
    // `ext` is a base-layer attribute. Older rows never stored it, so derive it
    // once from the path with the same first-dot rule the runtime uses; without
    // this every query would fail with `no such column: ext`.
    if !column_exists(conn, "inodes", "ext")? {
        conn.execute(
            "ALTER TABLE inodes ADD COLUMN ext TEXT NOT NULL DEFAULT ''",
            [],
        )?;
        let rows = {
            let mut stmt = conn.prepare("SELECT inode, path, kind FROM inodes")?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for (inode, path, kind) in rows {
            // Directories are not documents: they never carry an extension.
            let ext = if kind == "file" {
                crate::vfs::path_extension(&path)
            } else {
                String::new()
            };
            conn.execute(
                "UPDATE inodes SET ext = ?1 WHERE inode = ?2",
                params![ext, inode],
            )?;
        }
    }
    if !column_exists(conn, "inodes", "hash")? {
        conn.execute("ALTER TABLE inodes ADD COLUMN hash TEXT", [])?;
    }
    if !column_exists(conn, "inodes", "status")? {
        // Drop dependent indexes first: SQLite refuses to drop an indexed column.
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_inode_kind;
             DROP INDEX IF EXISTS idx_inode_pinned;
             ALTER TABLE inodes ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'archived', 'deleted'));",
        )?;
        if column_exists(conn, "inodes", "deleted")? {
            conn.execute(
                "UPDATE inodes
                 SET status = CASE WHEN deleted = 1 THEN 'deleted' ELSE 'active' END",
                [],
            )?;
            conn.execute("ALTER TABLE inodes DROP COLUMN deleted", [])?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_inode_kind ON inodes(kind, status);
             CREATE INDEX IF NOT EXISTS idx_inode_pinned ON inodes(kind, status, pinned);",
        )?;
    }
    if table_exists(conn, "meta")? {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS dir_titles (
                 inode INTEGER PRIMARY KEY,
                 title TEXT NOT NULL,
                 FOREIGN KEY (inode) REFERENCES inodes(inode) ON DELETE CASCADE
             );
             INSERT OR IGNORE INTO dir_titles (inode, title)
                 SELECT m.inode, COALESCE(NULLIF(m.title, ''), i.path)
                 FROM meta m JOIN inodes i ON i.inode = m.inode
                 WHERE m.kind = 'folder';
             DROP TABLE meta;",
        )?;
    }
    // One-time hash backfill; later writes maintain it in place.
    let rows = {
        let mut stmt = conn.prepare(
            "SELECT i.inode, b.content
             FROM inodes i
             JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
             WHERE i.kind = 'file' AND i.hash IS NULL",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (inode, content) in rows {
        conn.execute(
            "UPDATE inodes SET hash = ?1 WHERE inode = ?2",
            params![crate::assets::sha256_hex(content.as_bytes()), inode],
        )?;
    }
    Ok(())
}

/// Column probe used by the additive migrations. `table` is always an internal
/// constant, never user input, so the formatted identifier is safe.
fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
        params![column],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Idempotently ensure the system folders, display titles and path renames.
/// Called on startup so databases created before the `.agent` / `ai_default`
/// layout are healed without any destructive migration.
pub fn ensure_default_dirs(conn: &Connection) -> rusqlite::Result<()> {
    for (old, new) in LEGACY_RENAMES {
        rename_path_prefix(conn, old, new)?;
    }
    for path in LEGACY_EMPTY_DIRS {
        drop_empty_legacy_dir(conn, path)?;
    }
    // Legacy ACL table: visibility is now resolved from ai.policy files only.
    conn.execute("DROP TABLE IF EXISTS path_acl", [])?;
    for path in DEFAULT_DIRS {
        conn.execute(
            "INSERT OR IGNORE INTO inodes (path, kind, head_rev, size, ctime, mtime)
             VALUES (?1, 'directory', 0, 0, datetime('now','localtime'), datetime('now','localtime'))",
            params![*path],
        )?;
    }
    for (path, title) in DEFAULT_DIR_TITLES {
        conn.execute(
            "INSERT OR IGNORE INTO dir_titles (inode, title)
             SELECT inode, ?2 FROM inodes WHERE path = ?1",
            params![*path, *title],
        )?;
    }
    Ok(())
}

/// Drop one retired system directory, but only while it is completely empty.
///
/// The row (and its `dir_titles` label, removed by the FK cascade) is what kept
/// the dead 日程 entry in the notes browse list. A folder that still holds files
/// or sub-folders is left untouched: dropping it would orphan user content, so
/// it stays visible and deletable through the normal folder manager instead.
fn drop_empty_legacy_dir(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    let inode: Option<i64> = conn
        .query_row(
            "SELECT inode FROM inodes WHERE path = ?1 AND kind = 'directory'",
            params![path],
            |row| row.get(0),
        )
        .optional()?;
    let Some(inode) = inode else { return Ok(()) };

    let children: i64 = conn.query_row(
        "SELECT COUNT(*) FROM inodes WHERE path LIKE ?1 ESCAPE '\\'",
        params![format!("{}/%", crate::vfs::cap_gate::escape_like(path))],
        |row| row.get(0),
    )?;
    if children > 0 {
        return Ok(());
    }
    conn.execute("DELETE FROM inodes WHERE inode = ?1", params![inode])?;
    Ok(())
}

/// Move one directory subtree from `old` to `new` when the old path exists and
/// the target does not. Inode ids, history and search rows stay attached.
fn rename_path_prefix(conn: &Connection, old: &str, new: &str) -> rusqlite::Result<()> {
    let exists = |path: &str| -> rusqlite::Result<bool> {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM inodes WHERE path = ?1",
            params![path],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    };
    if !exists(old)? || exists(new)? {
        return Ok(());
    }
    conn.execute(
        "UPDATE inodes SET path = ?1 WHERE path = ?2",
        params![new, old],
    )?;
    conn.execute(
        "UPDATE inodes SET path = ?1 || substr(path, length(?2) + 1)
         WHERE path LIKE ?3",
        params![new, old, format!("{old}/%")],
    )?;
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
        "INSERT OR IGNORE INTO dir_titles (inode, title)
         SELECT inode, '默认' FROM inodes WHERE path = '/life/notes'",
        [],
    )?;
    Ok(())
}

/// Root path constant used by the docs layer to validate folder ownership.
pub const NOTES_ROOT: &str = "/life/notes";
