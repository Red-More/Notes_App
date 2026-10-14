use rusqlite::Connection;
use std::sync::Mutex;
use tauri::Manager;

/// Shared database state managed by Tauri.
pub struct Db(pub Mutex<Connection>);

/// Latest schema version. `run_migrations` applies every pending step below
/// and bumps `PRAGMA user_version` to match.
const SCHEMA_VERSION: i64 = 3;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);

CREATE TABLE IF NOT EXISTS note_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    label TEXT,
    label_description TEXT,
    is_manual INTEGER NOT NULL DEFAULT 0,
    delta_base INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(note_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_versions_note ON note_versions(note_id);

CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '默认',
    is_completed INTEGER NOT NULL DEFAULT 0,
    due_date TEXT,
    reminder INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    note TEXT,
    reminder INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_schedules_date ON schedules(date);

CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    company TEXT,
    notes TEXT,
    tag TEXT NOT NULL DEFAULT '默认',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
";

/// Whether `table` already has a column named `column`. Table/column names are
/// compile-time constants in this module, so formatting them into the query is
/// safe (never derived from user input).
fn table_has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let sql = format!(
        "SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"
    );
    let n: i64 = conn.query_row(&sql, [], |r| r.get(0))?;
    Ok(n > 0)
}

/// Apply pending schema migrations in order, tracking progress via
/// `PRAGMA user_version`. Runs on every startup: fresh databases reach the
/// latest version in one pass, older databases are upgraded step by step, and
/// already-current databases become a no-op.
pub fn run_migrations(conn: &Connection) -> rusqlite::Result<()> {
    let mut version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(SCHEMA)?;
        version = 1;
        conn.pragma_update(None, "user_version", version)?;
    }
    if version < 2 {
        // Add the reverse-delta column to note_versions tables created before
        // incremental version storage was introduced. Existing rows keep NULL
        // (full content), which is a valid chain anchor.
        if !table_has_column(conn, "note_versions", "delta_base")? {
            conn.execute_batch("ALTER TABLE note_versions ADD COLUMN delta_base INTEGER;")?;
        }
        version = 2;
        conn.pragma_update(None, "user_version", version)?;
    }
    if version < 3 {
        // Add the soft-delete column to notes tables created before the recycle
        // bin was introduced. NULL means the note is active; a non-NULL value
        // is the deletion timestamp.
        if !table_has_column(conn, "notes", "deleted_at")? {
            conn.execute_batch("ALTER TABLE notes ADD COLUMN deleted_at TEXT;")?;
        }
        version = SCHEMA_VERSION;
        conn.pragma_update(None, "user_version", version)?;
    }
    Ok(())
}

/// Open (or create) the SQLite database in the app data directory
/// and apply the schema migrations.
pub fn init(app: &tauri::AppHandle) -> Result<Connection, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let conn = Connection::open(dir.join("notes.db"))?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    run_migrations(&conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a pre-migration (v0) database: tables as they existed before the
    /// delta_base / deleted_at columns were introduced, user_version at 0.
    fn old_v0_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL DEFAULT '',
                folder_id INTEGER,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE note_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                version_number INTEGER NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                label TEXT,
                label_description TEXT,
                is_manual INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                UNIQUE(note_id, version_number)
            );",
        )
        .unwrap();
        conn
    }

    fn user_version(conn: &Connection) -> i64 {
        conn.pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn run_migrations_upgrades_old_db_to_latest() {
        let conn = old_v0_conn();
        run_migrations(&conn).unwrap();
        assert_eq!(user_version(&conn), SCHEMA_VERSION);
        assert!(table_has_column(&conn, "note_versions", "delta_base").unwrap());
        assert!(table_has_column(&conn, "notes", "deleted_at").unwrap());
    }

    #[test]
    fn run_migrations_on_fresh_db_reaches_latest_version() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        assert_eq!(user_version(&conn), SCHEMA_VERSION);
        // SCHEMA already defines delta_base, so the v<2 check must skip the
        // ALTER instead of failing on a duplicate column.
        assert!(table_has_column(&conn, "note_versions", "delta_base").unwrap());
        assert!(table_has_column(&conn, "notes", "deleted_at").unwrap());
    }
}

