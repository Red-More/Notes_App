//! SQLite WAL 基础设施。
//!
//! 这里不做应用层“操作日志表”，而是把 SQLite 自带的 write-ahead log 管好：
//! - 打开库时统一 pragma（WAL / synchronous / foreign_keys / busy_timeout）；
//! - 提供显式 checkpoint，便于迁移后或长写事务后收敛 WAL 文件；
//! - 启动时 integrity_check，损坏只上报、不阻塞。
//!
//! 崩溃恢复由 SQLite 在下次打开数据库时自动完成，VirtualFs 不重复造轮子。

use rusqlite::Connection;
use std::time::Duration;

/// `PRAGMA wal_checkpoint` 的返回值：busy、WAL 帧数、已 checkpoint 帧数。
#[derive(Debug, Clone)]
pub struct CheckpointReport {
    pub busy: i64,
    pub log_frames: i64,
    pub checkpointed: i64,
}

/// `PRAGMA integrity_check` 的聚合结果。
#[derive(Debug, Clone)]
pub struct IntegrityReport {
    pub ok: bool,
    pub messages: Vec<String>,
}

/// 应用统一连接配置。必须在任何读写之前调用。
pub fn configure(conn: &Connection) -> rusqlite::Result<()> {
    // 单连接 + Tauri State 互斥锁，5s 足够覆盖迁移与批量写。
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;",
    )?;
    Ok(())
}

/// 执行 TRUNCATE checkpoint：把 WAL 内容写回主库并截断 WAL 文件。
/// 返回的 busy=1 表示有其他连接持有读事务，调用方可降级为日志提示。
pub fn checkpoint(conn: &Connection) -> rusqlite::Result<CheckpointReport> {
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
        Ok(CheckpointReport {
            busy: r.get(0)?,
            log_frames: r.get(1)?,
            checkpointed: r.get(2)?,
        })
    })
}

/// 全量完整性检查。`PRAGMA integrity_check` 正常时只返回一行 "ok"。
pub fn integrity_check(conn: &Connection) -> rusqlite::Result<IntegrityReport> {
    let mut stmt = conn.prepare("PRAGMA integrity_check")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut messages = Vec::new();
    for row in rows {
        messages.push(row?);
    }
    let ok = messages.len() == 1 && messages[0] == "ok";
    Ok(IntegrityReport { ok, messages })
}
