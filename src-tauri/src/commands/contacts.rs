use crate::commands::db_err;
use crate::db::Db;
use crate::models::Contact;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Row};
use tauri::State;

fn contact_from_row(r: &Row) -> rusqlite::Result<Contact> {
    Ok(Contact {
        id: r.get(0)?,
        name: r.get(1)?,
        phone: r.get(2)?,
        email: r.get(3)?,
        company: r.get(4)?,
        notes: r.get(5)?,
        tag: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

const CONTACT_COLS: &str =
    "id, name, phone, email, company, notes, tag, created_at, updated_at";

/// Minimal email check: contains '@' with a non-empty part on both sides and
/// no whitespace anywhere.
fn is_valid_email(s: &str) -> bool {
    let Some(at) = s.find('@') else {
        return false;
    };
    at > 0 && at < s.len() - 1 && !s.chars().any(char::is_whitespace)
}

/// List contacts optionally filtered by tag and fuzzy-searched by
/// name / phone / company.
#[tauri::command]
pub fn list_contacts(
    state: State<Db>,
    tag: Option<String>,
    search: Option<String>,
) -> Result<Vec<Contact>, String> {
    let conn = state.0.lock().unwrap();
    let mut sql = format!("SELECT {CONTACT_COLS} FROM contacts WHERE 1 = 1");
    let mut args: Vec<SqlValue> = Vec::new();
    if let Some(t) = tag {
        if !t.is_empty() {
            sql.push_str(" AND tag = ?");
            args.push(SqlValue::Text(t));
        }
    }
    if let Some(s) = search {
        let s = s.trim().to_string();
        if !s.is_empty() {
            sql.push_str(" AND (name LIKE ? OR phone LIKE ? OR company LIKE ?)");
            let pat = format!("%{s}%");
            args.push(SqlValue::Text(pat.clone()));
            args.push(SqlValue::Text(pat.clone()));
            args.push(SqlValue::Text(pat));
        }
    }
    sql.push_str(" ORDER BY created_at DESC");
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args), contact_from_row)
        .map_err(db_err)?;
    let mut contacts = Vec::new();
    for row in rows {
        contacts.push(row.map_err(db_err)?);
    }
    Ok(contacts)
}

#[tauri::command]
pub fn create_contact(
    state: State<Db>,
    name: String,
    phone: Option<String>,
    email: Option<String>,
    company: Option<String>,
    notes: Option<String>,
    tag: Option<String>,
) -> Result<Contact, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("联系人姓名不能为空".into());
    }
    if let Some(email) = email.as_deref() {
        if !email.is_empty() && !is_valid_email(email) {
            return Err("邮箱格式不正确".into());
        }
    }
    let tag = tag
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "默认".into());
    let conn = state.0.lock().unwrap();
    conn.execute(
        "INSERT INTO contacts (name, phone, email, company, notes, tag) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![name, phone, email, company, notes, tag],
    )
    .map_err(db_err)?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        &format!("SELECT {CONTACT_COLS} FROM contacts WHERE id = ?1"),
        params![id],
        contact_from_row,
    )
    .map_err(db_err)
}

#[tauri::command]
pub fn update_contact(
    state: State<Db>,
    id: i64,
    name: String,
    phone: Option<String>,
    email: Option<String>,
    company: Option<String>,
    notes: Option<String>,
    tag: Option<String>,
) -> Result<Contact, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("联系人姓名不能为空".into());
    }
    if let Some(email) = email.as_deref() {
        if !email.is_empty() && !is_valid_email(email) {
            return Err("邮箱格式不正确".into());
        }
    }
    let tag = tag
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "默认".into());
    let conn = state.0.lock().unwrap();
    conn.execute(
        "UPDATE contacts SET name = ?1, phone = ?2, email = ?3, company = ?4, notes = ?5, tag = ?6,
                updated_at = datetime('now','localtime')
         WHERE id = ?7",
        params![name, phone, email, company, notes, tag, id],
    )
    .map_err(db_err)?;
    conn.query_row(
        &format!("SELECT {CONTACT_COLS} FROM contacts WHERE id = ?1"),
        params![id],
        contact_from_row,
    )
    .map_err(db_err)
}

#[tauri::command]
pub fn delete_contact(state: State<Db>, id: i64) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    conn.execute("DELETE FROM contacts WHERE id = ?1", params![id])
        .map_err(db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // Mirrors db::SCHEMA for the contacts table.
        conn.execute_batch(
            "CREATE TABLE contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT,
                email TEXT,
                company TEXT,
                notes TEXT,
                tag TEXT NOT NULL DEFAULT '默认',
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn email_validation_accepts_plain_addresses_and_rejects_others() {
        for e in ["a@b.com", "user.name+tag@example.cn", "x@y"] {
            assert!(is_valid_email(e), "{e} should be valid");
        }
        for e in ["", "no-at-sign", "@leading", "trailing@", "a b@c.com", "a@b c.com"] {
            assert!(!is_valid_email(e), "{e} should be invalid");
        }
    }

    #[test]
    fn valid_email_is_insertable_into_contacts() {
        // The shape create_contact would insert after validation must be
        // accepted by the contacts schema.
        assert!(is_valid_email("alice@example.com"));
        let conn = test_conn();
        conn.execute(
            "INSERT INTO contacts (name, email) VALUES (?1, ?2)",
            params!["爱丽丝", "alice@example.com"],
        )
        .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM contacts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
