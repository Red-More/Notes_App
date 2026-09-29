use crate::db::Db;
use crate::models::Todo;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Row};
use tauri::State;

fn db_err(e: rusqlite::Error) -> String {
    format!("数据库错误: {e}")
}

fn todo_from_row(r: &Row) -> rusqlite::Result<Todo> {
    Ok(Todo {
        id: r.get(0)?,
        title: r.get(1)?,
        category: r.get(2)?,
        is_completed: r.get(3)?,
        due_date: r.get(4)?,
        reminder: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

const TODO_COLS: &str =
    "id, title, category, is_completed, due_date, reminder, created_at, updated_at";

/// List todos ordered by: incomplete first, newest first.
#[tauri::command]
pub fn list_todos(state: State<Db>, search: Option<String>) -> Result<Vec<Todo>, String> {
    let conn = state.0.lock().unwrap();
    let mut sql = format!("SELECT {TODO_COLS} FROM todos WHERE 1 = 1");
    let mut args: Vec<SqlValue> = Vec::new();
    if let Some(s) = search {
        let s = s.trim().to_string();
        if !s.is_empty() {
            sql.push_str(" AND title LIKE ?");
            args.push(SqlValue::Text(format!("%{s}%")));
        }
    }
    sql.push_str(" ORDER BY is_completed ASC, created_at DESC");
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args), todo_from_row)
        .map_err(db_err)?;
    let mut todos = Vec::new();
    for row in rows {
        todos.push(row.map_err(db_err)?);
    }
    Ok(todos)
}

#[tauri::command]
pub fn create_todo(
    state: State<Db>,
    title: String,
    category: Option<String>,
    due_date: Option<String>,
    reminder: Option<bool>,
) -> Result<Todo, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("待办标题不能为空".into());
    }
    let category = category.unwrap_or_else(|| "默认".into());
    let conn = state.0.lock().unwrap();
    conn.execute(
        "INSERT INTO todos (title, category, due_date, reminder) VALUES (?1, ?2, ?3, ?4)",
        params![title, category, due_date, reminder.unwrap_or(false) as i64],
    )
    .map_err(db_err)?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        &format!("SELECT {TODO_COLS} FROM todos WHERE id = ?1"),
        params![id],
        todo_from_row,
    )
    .map_err(db_err)
}

#[tauri::command]
pub fn update_todo(
    state: State<Db>,
    id: i64,
    title: String,
    category: Option<String>,
    due_date: Option<String>,
    reminder: Option<bool>,
) -> Result<Todo, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("待办标题不能为空".into());
    }
    let category = category.unwrap_or_else(|| "默认".into());
    let conn = state.0.lock().unwrap();
    conn.execute(
        "UPDATE todos SET title = ?1, category = ?2, due_date = ?3, reminder = ?4,
                updated_at = datetime('now','localtime')
         WHERE id = ?5",
        params![title, category, due_date, reminder.unwrap_or(false) as i64, id],
    )
    .map_err(db_err)?;
    conn.query_row(
        &format!("SELECT {TODO_COLS} FROM todos WHERE id = ?1"),
        params![id],
        todo_from_row,
    )
    .map_err(db_err)
}

/// Toggle the completion state of a todo.
#[tauri::command]
pub fn toggle_todo(state: State<Db>, id: i64) -> Result<Todo, String> {
    let conn = state.0.lock().unwrap();
    conn.execute(
        "UPDATE todos SET is_completed = 1 - is_completed, updated_at = datetime('now','localtime') WHERE id = ?1",
        params![id],
    )
    .map_err(db_err)?;
    conn.query_row(
        &format!("SELECT {TODO_COLS} FROM todos WHERE id = ?1"),
        params![id],
        todo_from_row,
    )
    .map_err(db_err)
}

#[tauri::command]
pub fn delete_todo(state: State<Db>, id: i64) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    conn.execute("DELETE FROM todos WHERE id = ?1", params![id])
        .map_err(db_err)?;
    Ok(())
}
