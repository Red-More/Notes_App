use crate::db::Db;
use crate::models::Schedule;
use rusqlite::{params, Row};
use tauri::State;

fn db_err(e: rusqlite::Error) -> String {
    format!("数据库错误: {e}")
}

fn schedule_from_row(r: &Row) -> rusqlite::Result<Schedule> {
    Ok(Schedule {
        id: r.get(0)?,
        title: r.get(1)?,
        date: r.get(2)?,
        start_time: r.get(3)?,
        end_time: r.get(4)?,
        note: r.get(5)?,
        reminder: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

const SCHEDULE_COLS: &str =
    "id, title, date, start_time, end_time, note, reminder, created_at, updated_at";

/// List all schedules within a month ("YYYY-MM").
#[tauri::command]
pub fn list_schedules(state: State<Db>, month: String) -> Result<Vec<Schedule>, String> {
    if !month.chars().all(|c| c.is_ascii_digit() || c == '-') || month.len() != 7 {
        return Err("月份格式应为 YYYY-MM".into());
    }
    let conn = state.0.lock().unwrap();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SCHEDULE_COLS} FROM schedules WHERE date LIKE ?1 ORDER BY date ASC, start_time ASC"
        ))
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![format!("{month}%")], schedule_from_row)
        .map_err(db_err)?;
    let mut schedules = Vec::new();
    for row in rows {
        schedules.push(row.map_err(db_err)?);
    }
    Ok(schedules)
}

#[tauri::command]
pub fn create_schedule(
    state: State<Db>,
    title: String,
    date: String,
    start_time: Option<String>,
    end_time: Option<String>,
    note: Option<String>,
    reminder: Option<bool>,
) -> Result<Schedule, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("日程标题不能为空".into());
    }
    if date.len() != 10 || !date.starts_with(char::is_numeric) {
        return Err("日期格式应为 YYYY-MM-DD".into());
    }
    let conn = state.0.lock().unwrap();
    conn.execute(
        "INSERT INTO schedules (title, date, start_time, end_time, note, reminder)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![title, date, start_time, end_time, note, reminder.unwrap_or(false) as i64],
    )
    .map_err(db_err)?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        &format!("SELECT {SCHEDULE_COLS} FROM schedules WHERE id = ?1"),
        params![id],
        schedule_from_row,
    )
    .map_err(db_err)
}

#[tauri::command]
pub fn update_schedule(
    state: State<Db>,
    id: i64,
    title: String,
    date: String,
    start_time: Option<String>,
    end_time: Option<String>,
    note: Option<String>,
    reminder: Option<bool>,
) -> Result<Schedule, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("日程标题不能为空".into());
    }
    let conn = state.0.lock().unwrap();
    conn.execute(
        "UPDATE schedules SET title = ?1, date = ?2, start_time = ?3, end_time = ?4, note = ?5, reminder = ?6,
                updated_at = datetime('now','localtime')
         WHERE id = ?7",
        params![title, date, start_time, end_time, note, reminder.unwrap_or(false) as i64, id],
    )
    .map_err(db_err)?;
    conn.query_row(
        &format!("SELECT {SCHEDULE_COLS} FROM schedules WHERE id = ?1"),
        params![id],
        schedule_from_row,
    )
    .map_err(db_err)
}

#[tauri::command]
pub fn delete_schedule(state: State<Db>, id: i64) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    conn.execute("DELETE FROM schedules WHERE id = ?1", params![id])
        .map_err(db_err)?;
    Ok(())
}
