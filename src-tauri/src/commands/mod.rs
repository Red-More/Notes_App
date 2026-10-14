pub mod contacts;
pub mod export;
pub mod folders;
pub mod notes;
pub mod schedules;
pub mod todos;

/// Map a rusqlite error to a user-facing message and log the underlying error.
/// Shared by all command modules so the "数据库错误: ..." wording stays uniform.
pub fn db_err(e: rusqlite::Error) -> String {
    log::warn!("db error: {e}");
    format!("数据库错误: {e}")
}
