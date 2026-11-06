//! Database lifecycle.
//!
//! The application keeps a single SQLite file, `life.db`:
//! - `wal` owns WAL mode, checkpointing and the integrity check;
//! - `schema` owns the final table set and the default directory seed;
//! - `vfs::VirtualFs` holds the connection and is the only writer.
//!
//! There is no incremental migration path. The project has never shipped, so an
//! unexpected file (wrong `user_version` or missing tables) is deleted, together
//! with its `-wal` / `-shm` sidecars, and rebuilt from the final schema.

pub mod schema;
pub mod wal;

use std::path::Path;

use rusqlite::Connection;
use tauri::Manager;

/// The one database file. Models never see it; VirtualFs owns the namespace.
pub const DB_FILE_NAME: &str = "life.db";

/// Open `life.db`, applying WAL settings and the final schema.
///
/// The startup integrity check only logs failures; it never blocks boot. A
/// TRUNCATE checkpoint follows so a fresh database converges to a single file.
pub fn init(app: &tauri::AppHandle) -> Result<Connection, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let conn = open_or_rebuild(&dir)?;

    match wal::integrity_check(&conn) {
        Ok(report) if !report.ok => {
            log::error!("life.db integrity_check failed: {:?}", report.messages);
        }
        Ok(_) => {}
        Err(e) => log::warn!("life.db integrity_check error: {e}"),
    }
    match wal::checkpoint(&conn) {
        Ok(report) => log::info!(
            "life.db wal checkpoint: frames={}, checkpointed={}, busy={}",
            report.log_frames,
            report.checkpointed,
            report.busy
        ),
        Err(e) => log::warn!("life.db initial wal checkpoint failed: {e}"),
    }

    log::info!(
        "life.db ready (schema v{}, journal=WAL)",
        schema::SCHEMA_VERSION
    );
    Ok(conn)
}

/// Open `life.db` inside `dir`, rebuilding it when the schema is not current.
///
/// An empty file is treated as a first launch and built in place. A file with
/// application tables that fails `schema::is_current` is deleted (sidecars too)
/// and rebuilt; there is no user data to preserve before the first release.
pub fn open_or_rebuild(dir: &Path) -> Result<Connection, Box<dyn std::error::Error>> {
    let db_path = dir.join(DB_FILE_NAME);
    let mut conn = Connection::open(&db_path)?;
    wal::configure(&conn)?;

    if schema::is_current(&conn)? {
        return Ok(conn);
    }

    if schema::has_user_tables(&conn)? {
        drop(conn);
        remove_database_files(&db_path)?;
        log::warn!("life.db structure mismatch detected; deleted and rebuilt the database");
        let mut fresh = Connection::open(&db_path)?;
        wal::configure(&fresh)?;
        schema::create(&mut fresh)?;
        log::info!("life.db rebuilt (schema v{})", schema::SCHEMA_VERSION);
        return Ok(fresh);
    }

    schema::create(&mut conn)?;
    log::info!("life.db created (schema v{})", schema::SCHEMA_VERSION);
    Ok(conn)
}

/// Delete the database file and the WAL sidecars a crashed build may leave.
fn remove_database_files(db_path: &Path) -> std::io::Result<()> {
    std::fs::remove_file(db_path)?;
    let name = db_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| DB_FILE_NAME.to_string());
    for sidecar in ["-wal", "-shm"] {
        let path = db_path.with_file_name(format!("{name}{sidecar}"));
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}
