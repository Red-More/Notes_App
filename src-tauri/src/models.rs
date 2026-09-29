use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub folder_id: Option<i64>,
    pub folder_name: Option<String>,
    pub is_pinned: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteVersion {
    pub id: i64,
    pub note_id: i64,
    pub version_number: i64,
    pub title: String,
    pub content: String,
    pub label: Option<String>,
    pub label_description: Option<String>,
    pub is_manual: i64,
    pub created_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: i64,
    pub name: String,
    pub is_pinned: i64,
    pub sort_order: i64,
    pub note_count: i64,
    pub created_at: String,
}

/// Folder list plus virtual counts used by the folder management page.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderStats {
    pub total: i64,
    pub unclassified: i64,
    pub folders: Vec<Folder>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: i64,
    pub title: String,
    pub category: String,
    pub is_completed: i64,
    pub due_date: Option<String>,
    pub reminder: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: i64,
    pub title: String,
    pub date: String,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub note: Option<String>,
    pub reminder: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub id: i64,
    pub name: String,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub company: Option<String>,
    pub notes: Option<String>,
    pub tag: String,
    pub created_at: String,
    pub updated_at: String,
}
