//! 数据库生命周期入口。
//!
//! 本次重构后整个应用只保留一个 SQLite 文件 `life.db`：
//! - `wal` 负责 WAL 模式、checkpoint 与完整性检查；
//! - `schema` 负责 VirtualFs 表结构与默认目录种子；
//! - 上层 `vfs::VirtualFs` 持有连接，是唯一写库的地方。
//!
//! 旧的 `notes.db` 关系型存储不再打开，也不做数据迁移。

pub mod schema;
pub mod wal;

use rusqlite::Connection;
use tauri::Manager;

/// 唯一数据库文件名。真实文件系统对模型不可见，路径由 VirtualFs 管理。
pub const DB_FILE_NAME: &str = "life.db";

/// 打开 `life.db`，应用 WAL 配置并执行 schema 迁移。
///
/// 启动时执行一次 `integrity_check`，损坏只记录日志、不阻塞启动；
/// 迁移完成后再做一次 TRUNCATE checkpoint，让新库尽早收敛为单文件状态。
pub fn init(app: &tauri::AppHandle) -> Result<Connection, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let mut conn = Connection::open(dir.join(DB_FILE_NAME))?;
    wal::configure(&conn)?;
    schema::migrate(&mut conn)?;

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
            report.log_frames, report.checkpointed, report.busy
        ),
        Err(e) => log::warn!("life.db initial wal checkpoint failed: {e}"),
    }

    log::info!(
        "life.db ready (schema v{}, journal=WAL)",
        schema::SCHEMA_VERSION
    );
    Ok(conn)
}
