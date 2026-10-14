use crate::commands::db_err;
use crate::db::Db;
use crate::models::Schedule;
use rusqlite::{params, Row};
use tauri::State;

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

/// Validate a "YYYY-MM" month string: a 4-digit year and a 01-12 month.
fn is_valid_month(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 7 || b[4] != b'-' {
        return false;
    }
    b[..4].iter().all(u8::is_ascii_digit)
        && b[5..].iter().all(u8::is_ascii_digit)
        && (1..=12).contains(&s[5..].parse::<u32>().unwrap_or(0))
}

/// Validate a "YYYY-MM-DD" date string by splitting into parts and checking
/// numeric ranges (month 1-12, day 1-31). Real calendar rules (e.g. February
/// days) are deliberately not enforced to keep the check simple.
fn is_valid_date(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return false;
    }
    if !parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit())) {
        return false;
    }
    let month: u32 = parts[1].parse().unwrap_or(0);
    let day: u32 = parts[2].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// Reject schedules whose end time is not strictly after the start time.
/// "HH:MM" strings compare correctly as plain text; empty times are ignored.
fn validate_time_order(start_time: &Option<String>, end_time: &Option<String>) -> Result<(), String> {
    if let (Some(s), Some(e)) = (start_time, end_time) {
        if !s.is_empty() && !e.is_empty() && s >= e {
            return Err("结束时间需晚于开始时间".into());
        }
    }
    Ok(())
}

/// List all schedules within a month ("YYYY-MM").
#[tauri::command]
pub fn list_schedules(state: State<Db>, month: String) -> Result<Vec<Schedule>, String> {
    if !is_valid_month(&month) {
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
    if !is_valid_date(&date) {
        return Err("日期格式应为 YYYY-MM-DD".into());
    }
    validate_time_order(&start_time, &end_time)?;
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
    if !is_valid_date(&date) {
        return Err("日期格式应为 YYYY-MM-DD".into());
    }
    validate_time_order(&start_time, &end_time)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // Mirrors db::SCHEMA for the schedules table.
        conn.execute_batch(
            "CREATE TABLE schedules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                date TEXT NOT NULL,
                start_time TEXT,
                end_time TEXT,
                note TEXT,
                reminder INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn month_validation_accepts_yyyy_mm_and_rejects_others() {
        for m in ["2026-01", "2026-10", "2026-12", "0000-01", "9999-12"] {
            assert!(is_valid_month(m), "{m} should be valid");
        }
        for m in [
            "2026-1", "2026-00", "2026-13", "2026-100", "26-01", "2026/01", "2026-", "-01",
            "abcdef-01", "2026-01-02", "",
        ] {
            assert!(!is_valid_month(m), "{m} should be invalid");
        }
    }

    #[test]
    fn date_validation_accepts_yyyy_mm_dd_and_rejects_others() {
        for d in ["2026-01-01", "2026-12-31", "2026-02-29", "0000-01-31", "9999-12-01"] {
            assert!(is_valid_date(d), "{d} should be valid");
        }
        for d in [
            "2026-1-1", "2026-13-01", "2026-00-01", "2026-01-00", "2026-01-32", "2026/01/01",
            "2026-01", "26-01-01", "abcd-01-01", "2026-01-01x", "",
        ] {
            assert!(!is_valid_date(d), "{d} should be invalid");
        }
    }

    #[test]
    fn time_order_requires_end_strictly_after_start() {
        assert!(validate_time_order(&None, &None).is_ok());
        assert!(validate_time_order(&Some("09:00".into()), &None).is_ok());
        assert!(validate_time_order(&None, &Some("10:00".into())).is_ok());
        assert!(validate_time_order(&Some("09:00".into()), &Some("10:00".into())).is_ok());
        assert!(validate_time_order(&Some("".into()), &Some("".into())).is_ok());
        assert!(validate_time_order(&Some("10:00".into()), &Some("09:00".into())).is_err());
        assert!(validate_time_order(&Some("10:00".into()), &Some("10:00".into())).is_err());
        assert_eq!(
            validate_time_order(&Some("10:00".into()), &Some("09:00".into())),
            Err("结束时间需晚于开始时间".to_string())
        );
    }

    #[test]
    fn valid_values_pass_validation_and_insert() {
        // Data that passes every check (the shape create_schedule would insert)
        // must be accepted by the schedules schema.
        assert!(is_valid_date("2026-10-14"));
        assert!(validate_time_order(&Some("09:00".into()), &Some("10:30".into())).is_ok());
        let conn = test_conn();
        conn.execute(
            "INSERT INTO schedules (title, date, start_time, end_time) VALUES (?1, ?2, ?3, ?4)",
            params!["测试", "2026-10-14", "09:00", "10:30"],
        )
        .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM schedules", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
