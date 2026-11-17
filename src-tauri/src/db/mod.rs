//! Database lifecycle.
//!
//! The application keeps a single SQLite file, `life.db`:
//! - `wal` owns WAL mode, checkpointing and the integrity check;
//! - `schema` owns the final table set and the default directory seed;
//! - `vfs::VirtualFs` holds the connection and is the only writer.
//!
//! Older structures are upgraded in place by `schema::migrate`, inside one
//! transaction, so no document, conversation or setting is lost on upgrade.
//! A *newer* or structurally broken file cannot be downgraded: it is copied
//! aside as `life.db.bak-v<old>`, then deleted (with its `-wal` / `-shm`
//! sidecars) and rebuilt from the final schema.

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

/// Open `life.db` inside `dir`, upgrading or rebuilding it as required.
///
/// An empty file is treated as a first launch and built in place. A file written
/// by an older build is upgraded in place — one transaction, no rows dropped. A
/// *newer* file, or one whose structure is broken beyond the migration, is
/// copied aside and rebuilt; there is no way to downgrade those.
pub fn open_or_rebuild(dir: &Path) -> Result<Connection, Box<dyn std::error::Error>> {
    let db_path = dir.join(DB_FILE_NAME);
    let mut conn = Connection::open(&db_path)?;
    wal::configure(&conn)?;

    if schema::is_current(&conn)? {
        return Ok(conn);
    }

    // No application tables yet: a first launch on an empty file. Nothing to
    // preserve, so build the final schema in place.
    if !schema::has_user_tables(&conn)? {
        schema::create(&mut conn)?;
        log::info!("life.db created (schema v{})", schema::SCHEMA_VERSION);
        return Ok(conn);
    }

    let version = schema::schema_version(&conn)?;

    // Older builds are upgraded in place. The migration is transactional: on
    // failure it rolls back and we keep the original file (plus a backup copy)
    // instead of deleting user data.
    if version < schema::SCHEMA_VERSION {
        match schema::migrate(&conn) {
            Ok(()) => {
                if schema::is_current(&conn)? {
                    log::info!(
                        "life.db upgraded in place (v{version} -> v{})",
                        schema::SCHEMA_VERSION
                    );
                    return Ok(conn);
                }
                // The upgrade completed but required tables are still missing:
                // the file was structurally broken before the upgrade.
                log::warn!("life.db upgrade left an incomplete schema; rebuilding");
            }
            Err(e) => {
                // Rolled back: the file still has its previous structure.
                log::error!("life.db in-place upgrade failed (rolled back): {e}");
                wal::checkpoint(&conn).ok();
                backup_database(&db_path, version);
                return Err(e.into());
            }
        }
    }

    // Newer or structurally broken file: back it up, then rebuild from the
    // final schema. This is the only destructive path left.
    drop(conn);
    backup_database(&db_path, version);
    remove_database_files(&db_path)?;
    log::warn!("life.db structure mismatch detected; deleted and rebuilt the database");
    let mut fresh = Connection::open(&db_path)?;
    wal::configure(&fresh)?;
    schema::create(&mut fresh)?;
    log::info!("life.db rebuilt (schema v{})", schema::SCHEMA_VERSION);
    Ok(fresh)
}

/// Copy the outgoing database next to itself before a schema rebuild.
///
/// The rebuild deletes every document, so keeping the previous file (under a
/// version-suffixed name) is the only recovery path for user data.
fn backup_database(db_path: &Path, version: i64) {
    let name = db_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| DB_FILE_NAME.to_string());
    for n in 0..100 {
        let suffix = if n == 0 { String::new() } else { format!("-{n}") };
        let target = db_path.with_file_name(format!("{name}.bak-v{version}{suffix}"));
        if target.exists() {
            continue;
        }
        match std::fs::copy(db_path, &target) {
            Ok(_) => log::warn!("life.db backed up to {}", target.display()),
            // Startup must still succeed: report loudly but keep rebuilding.
            Err(e) => log::error!("life.db backup to {} failed: {e}", target.display()),
        }
        return;
    }
    log::error!("life.db backup skipped: too many existing backups");
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
