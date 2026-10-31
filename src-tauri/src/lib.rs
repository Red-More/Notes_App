mod agent;
mod commands;
mod db;
mod docs;
#[cfg(test)]
mod tests;
mod vfs;

use std::sync::Mutex;
use tauri::Manager;
use vfs::{VfsState, VirtualFs};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // life.db 是唯一数据库；VirtualFs 独占连接并通过 Mutex 串行化。
            let conn = db::init(app.handle())?;
            // 历史文件可能没有交叉索引行，启动时补建一次（幂等）。
            if let Err(e) = vfs::index::rebuild_missing(&conn) {
                eprintln!("life.db index rebuild failed: {e}");
            }
            app.manage(VfsState(Mutex::new(VirtualFs::new(conn))));
            // Agent 侧状态：HTTP 客户端、私有密钥文件、取消标记。
            let secret_path = app.path().app_data_dir()?.join("agent-secrets.json");
            app.manage(agent::AgentState::new(secret_path));
            // Log to the console and a rotating file under the OS log dir in
            // every build mode, so diagnostics exist on user machines too.
            let log_dir = app.path().app_log_dir()?;
            std::fs::create_dir_all(&log_dir)?;
            let log_file = tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                path: log_dir,
                file_name: Some("notes".into()),
            });
            app.handle().plugin(
                tauri_plugin_log::Builder::new()
                    .targets([
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                        log_file,
                    ])
                    .level(log::LevelFilter::Info)
                    .max_file_size(1024 * 1024)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                    .build(),
            )?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::fs::fs_read,
            commands::fs::fs_write,
            commands::fs::fs_edit,
            commands::fs::fs_glob,
            commands::fs::fs_grep,
            commands::doc::doc_list,
            commands::doc::doc_get,
            commands::doc::doc_create,
            commands::doc::doc_save,
            commands::doc::doc_delete,
            commands::doc::doc_restore,
            commands::doc::doc_purge,
            commands::doc::doc_empty_trash,
            commands::doc::doc_set_pinned,
            commands::doc::doc_move,
            commands::folder::folder_list,
            commands::folder::folder_create,
            commands::folder::folder_rename,
            commands::folder::folder_rename_default,
            commands::folder::folder_delete,
            commands::folder::folder_set_pinned,
            commands::version::version_list,
            commands::version::version_create,
            commands::version::version_restore,
            commands::version::version_delete,
            commands::export::export_doc,
            commands::export::export_docs,
            commands::export::export_folder,
            commands::index::index_query,
            commands::agent::chat_list,
            commands::agent::chat_create,
            commands::agent::chat_rename,
            commands::agent::chat_delete,
            commands::agent::chat_messages,
            commands::agent::chat_append,
            commands::agent::agent_settings,
            commands::agent::agent_model_save,
            commands::agent::agent_model_delete,
            commands::agent::agent_model_activate,
            commands::agent::agent_models_list,
            commands::agent::agent_test_connection,
            commands::agent::agent_params_get,
            commands::agent::agent_params_set,
            commands::agent::agent_stream,
            commands::agent::agent_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
