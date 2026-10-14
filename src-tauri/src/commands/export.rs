use crate::commands::db_err;
use crate::db::Db;
use crate::models::Note;
use rusqlite::{params, Connection, Row};
use std::io::Write;
use tauri::State;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

fn note_from_row(r: &Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        title: r.get(1)?,
        content: r.get(2)?,
        folder_id: r.get(3)?,
        folder_name: r.get(4)?,
        is_pinned: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        deleted_at: r.get(8)?,
    })
}

/// Escape a value for a YAML double-quoted string so the exported front
/// matter stays parseable: backslash, double quote and newlines are escaped.
fn yaml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
    out
}

/// Build the YAML front matter block for a note. The creation/update
/// timestamps are written verbatim from the database ("YYYY-MM-DD HH:MM:SS").
fn front_matter(note: &Note) -> String {
    let folder = note
        .folder_name
        .clone()
        .unwrap_or_else(|| "默认".to_string());
    let pinned = if note.is_pinned != 0 { "true" } else { "false" };
    format!(
        "---\ntitle: \"{}\"\nfolder: \"{}\"\npinned: {}\ncreated: {}\nupdated: {}\n---\n",
        yaml_escape(&note.title),
        yaml_escape(&folder),
        pinned,
        note.created_at,
        note.updated_at
    )
}

/// Full Markdown content: YAML front matter, a blank line, then the raw body.
fn note_to_markdown(note: &Note) -> String {
    format!("{}\n{}", front_matter(note), note.content)
}

/// Make a note title safe for use as a file name: illegal characters and
/// control characters become '_'; an empty/whitespace title becomes "未命名";
/// the result is truncated to 60 characters.
fn safe_file_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return "未命名".to_string();
    }
    cleaned.chars().take(60).collect()
}

/// Assign `{id}-{safe title}` base names, disambiguating collisions with a
/// numeric suffix so no entry overwrites another inside the ZIP.
fn unique_base_names(notes: &[Note]) -> Vec<String> {
    let mut seen: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    notes
        .iter()
        .map(|n| {
            let base = format!("{}-{}", n.id, safe_file_name(&n.title));
            let cnt = seen.entry(base.clone()).or_insert(0);
            *cnt += 1;
            if *cnt == 1 {
                base
            } else {
                format!("{base}-{cnt}")
            }
        })
        .collect()
}

/// Pair each note with its `{base}.md` file name and Markdown content.
fn notes_to_zip_entries(notes: &[Note]) -> Vec<(String, String)> {
    unique_base_names(notes)
        .into_iter()
        .zip(notes.iter())
        .map(|(base, note)| (format!("{base}.md"), note_to_markdown(note)))
        .collect()
}

/// Write the given `(file name, content)` entries into a ZIP archive at
/// `dest_path`, deflating every entry, then finish (flush) the archive.
fn write_zip(dest_path: &str, entries: &[(String, String)]) -> Result<(), String> {
    let file = std::fs::File::create(dest_path)
        .map_err(|e| format!("无法创建导出文件 {dest_path}: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, content) in entries {
        zip.start_file(name, options)
            .map_err(|e| format!("导出 ZIP 写入失败: {e}"))?;
        zip.write_all(content.as_bytes())
            .map_err(|e| format!("导出 ZIP 写入失败: {e}"))?;
    }
    zip.finish().map_err(|e| format!("导出 ZIP 写入失败: {e}"))?;
    Ok(())
}

/// Fetch a single non-deleted note with its folder name. Missing or already
/// deleted notes map to a dedicated "笔记不存在" error.
fn fetch_note(conn: &Connection, id: i64) -> Result<Note, String> {
    conn.query_row(
        "SELECT n.id, n.title, n.content, n.folder_id, f.name, n.is_pinned, n.created_at, n.updated_at, n.deleted_at
         FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
         WHERE n.id = ?1 AND n.deleted_at IS NULL",
        params![id],
        note_from_row,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => "笔记不存在".to_string(),
        other => db_err(other),
    })
}

/// Fetch multiple non-deleted notes (with folder names), keeping id order.
fn fetch_notes(conn: &Connection, ids: &[i64]) -> Result<Vec<Note>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders: Vec<String> = ids.iter().map(|_| "?".to_string()).collect();
    let sql = format!(
        "SELECT n.id, n.title, n.content, n.folder_id, f.name, n.is_pinned, n.created_at, n.updated_at, n.deleted_at
         FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
         WHERE n.deleted_at IS NULL AND n.id IN ({})",
        placeholders.join(",")
    );
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), note_from_row)
        .map_err(db_err)?;
    let mut notes = Vec::new();
    for row in rows {
        notes.push(row.map_err(db_err)?);
    }
    Ok(notes)
}

/// Export a single note as a Markdown file with YAML front matter.
fn export_note_to_impl(conn: &Connection, note_id: i64, dest_path: &str) -> Result<(), String> {
    let note = fetch_note(conn, note_id)?;
    std::fs::write(dest_path, note_to_markdown(&note))
        .map_err(|e| format!("无法写入导出文件 {dest_path}: {e}"))
}

#[tauri::command]
pub fn export_note_to(state: State<Db>, note_id: i64, dest_path: String) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    export_note_to_impl(&conn, note_id, &dest_path)
}

/// Export multiple notes as a ZIP archive of Markdown files.
fn export_notes_to_impl(conn: &Connection, ids: &[i64], dest_path: &str) -> Result<(), String> {
    let notes = fetch_notes(conn, ids)?;
    if notes.is_empty() {
        return Err("没有可导出的笔记".to_string());
    }
    write_zip(dest_path, &notes_to_zip_entries(&notes))
}

#[tauri::command]
pub fn export_notes_to(state: State<Db>, ids: Vec<i64>, dest_path: String) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    export_notes_to_impl(&conn, &ids, &dest_path)
}

/// Export every non-deleted note of a folder as a ZIP archive.
fn export_folder_to_impl(conn: &Connection, folder_id: i64, dest_path: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.title, n.content, n.folder_id, f.name, n.is_pinned, n.created_at, n.updated_at, n.deleted_at
             FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
             WHERE n.deleted_at IS NULL AND n.folder_id = ?1
             ORDER BY n.id ASC",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![folder_id], note_from_row)
        .map_err(db_err)?;
    let mut notes = Vec::new();
    for row in rows {
        notes.push(row.map_err(db_err)?);
    }
    if notes.is_empty() {
        return Err("没有可导出的笔记".to_string());
    }
    write_zip(dest_path, &notes_to_zip_entries(&notes))
}

#[tauri::command]
pub fn export_folder_to(state: State<Db>, folder_id: i64, dest_path: String) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    export_folder_to_impl(&conn, folder_id, &dest_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL DEFAULT '',
                folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                deleted_at TEXT
            );",
        )
        .unwrap();
        conn
    }

    fn insert_note(
        conn: &Connection,
        id: i64,
        title: &str,
        content: &str,
        folder_id: Option<i64>,
    ) {
        conn.execute(
            "INSERT INTO notes (id, title, content, folder_id) VALUES (?1, ?2, ?3, ?4)",
            params![id, title, content, folder_id],
        )
        .unwrap();
    }

    fn temp_zip_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "notes_export_test_{}_{}.zip",
            std::process::id(),
            name
        ))
    }

    #[test]
    fn front_matter_escapes_special_characters() {
        let note = Note {
            id: 1,
            title: "标题 with \"quotes\" and \\ backslash\nand 中文\nnewline".to_string(),
            content: "body".to_string(),
            folder_id: Some(1),
            folder_name: Some("资料\"夹".to_string()),
            is_pinned: 1,
            created_at: "2026-10-14 09:30:00".to_string(),
            updated_at: "2026-10-14 10:00:00".to_string(),
            deleted_at: None,
        };
        let fm = front_matter(&note);
        assert!(fm.starts_with("---\n"));
        assert!(fm.contains(
            "title: \"标题 with \\\"quotes\\\" and \\\\ backslash\\nand 中文\\nnewline\""
        ));
        assert!(fm.contains("folder: \"资料\\\"夹\""));
        assert!(fm.contains("pinned: true"));
        assert!(fm.contains("created: 2026-10-14 09:30:00"));
        assert!(fm.contains("updated: 2026-10-14 10:00:00"));
        assert!(fm.ends_with("---\n"));
    }

    #[test]
    fn front_matter_default_folder_and_unpinned() {
        let note = Note {
            id: 2,
            title: "t".to_string(),
            content: "c".to_string(),
            folder_id: None,
            folder_name: None,
            is_pinned: 0,
            created_at: "2026-10-14 09:30:00".to_string(),
            updated_at: "2026-10-14 10:00:00".to_string(),
            deleted_at: None,
        };
        let fm = front_matter(&note);
        assert!(fm.contains("folder: \"默认\""));
        assert!(fm.contains("pinned: false"));
    }

    #[test]
    fn safe_file_name_replaces_illegal_characters_and_truncates() {
        assert_eq!(
            safe_file_name("a/b\\c:d*e?f\"g<h>i|j"),
            "a_b_c_d_e_f_g_h_i_j"
        );
        assert_eq!(safe_file_name(""), "未命名");
        assert_eq!(safe_file_name("   "), "未命名");
        let long: String = "长".repeat(100);
        assert_eq!(safe_file_name(&long).chars().count(), 60);
    }

    #[test]
    fn zip_export_contains_markdown_files_with_front_matter() {
        let conn = test_conn();
        insert_note(&conn, 1, "测试 笔记", "第一行\n第二行", None);
        let path = temp_zip_path("basic");
        export_notes_to_impl(&conn, &[1], path.to_str().unwrap()).unwrap();

        let file = std::fs::File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert_eq!(archive.len(), 1);
        let mut content = String::new();
        archive
            .by_name("1-测试 笔记.md")
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert!(content.starts_with("---\ntitle: \"测试 笔记\"\n"));
        assert!(content.contains("folder: \"默认\"\n"));
        assert!(content.contains("pinned: false\n"));
        assert!(content.contains("created: "));
        assert!(content.ends_with("---\n\n第一行\n第二行"));
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn deleted_notes_are_excluded_from_export() {
        let conn = test_conn();
        insert_note(&conn, 1, "keep", "c1", None);
        insert_note(&conn, 2, "gone", "c2", None);
        conn.execute(
            "UPDATE notes SET deleted_at = datetime('now','localtime') WHERE id = 2",
            [],
        )
        .unwrap();
        let path = temp_zip_path("trash");
        // Exporting only a deleted note yields no exportable notes.
        assert_eq!(
            export_notes_to_impl(&conn, &[2], path.to_str().unwrap()),
            Err("没有可导出的笔记".to_string())
        );
        // Mixed ids skip the deleted note inside the archive.
        export_notes_to_impl(&conn, &[1, 2], path.to_str().unwrap()).unwrap();
        let file = std::fs::File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert_eq!(archive.len(), 1);
        let mut names: Vec<String> = Vec::new();
        for i in 0..archive.len() {
            names.push(archive.by_index(i).unwrap().name().to_string());
        }
        assert!(names.contains(&"1-keep.md".to_string()));
        std::fs::remove_file(&path).unwrap();
    }
}
