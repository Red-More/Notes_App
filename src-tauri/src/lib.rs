mod agent;
mod assets;
mod commands;
mod db;
mod directory_config;
mod docs;
mod mcp;
mod skills;
#[cfg(test)]
mod tests;
mod vfs;

use std::sync::{Mutex, MutexGuard};
use tauri::Manager;
use vfs::{VfsState, VirtualFs};

/// Take the guard even when a previous holder panicked. These mutexes only
/// protect in-process state, so poisoning must not take down every later call.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

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
            // 增量迁移（文件分层、会话列）先执行：旧库在这里把目录标题
            // 拆到 dir_titles，并把 deleted 升级为 status。
            db::schema::migrate(&conn)?;
            // 系统目录、中文标题与 Agent 默认 ACL：幂等补齐，不覆盖用户修改。
            db::schema::ensure_default_dirs(&conn)?;
            // 检索索引自愈：删除孤儿行、补建缺失行；FTS 行数与可见文件数不一致时告警。
            match vfs::fts::rebuild_missing(&conn) {
                Ok((removed, added)) if removed > 0 || added > 0 => {
                    log::info!("search index repaired: removed={removed}, added={added}");
                }
                Ok(_) => {}
                Err(e) => log::warn!("search index repair failed: {e}"),
            }
            match vfs::fts::stats(&conn) {
                Ok((indexed, visible)) if indexed != visible => {
                    log::warn!("search index mismatch: indexed={indexed}, visible={visible}")
                }
                Ok(_) => {}
                Err(e) => log::warn!("search index stats failed: {e}"),
            }
            // 首发不预置任何技能：`skills_installed = []`，全部由用户导入。
            let mut vault = VirtualFs::new(conn);
            // Agent runs never auto-resume: rows left executing become
            // `interrupted` and the UI offers an explicit "continue" action.
            if let Err(e) = agent::runs::recover(vault.conn()) {
                log::warn!("agent run recovery failed: {e}");
            }
            // 默认配置：`.agent` 模型配置 + `.lifeos` 可见性（幂等，不覆盖用户修改）。
            if let Err(e) = directory_config::ensure_defaults(&mut vault) {
                log::warn!("default directory config failed: {e}");
            }
            // Agent 工作区：模型可读写，但草稿不会自动加载。
            if let Err(e) = skills::ensure_workspace(&vault) {
                eprintln!("life.db agent workspace failed: {e}");
            }
            app.manage(VfsState(Mutex::new(vault)));
            // Agent 侧状态：HTTP 客户端、私有密钥文件、取消标记。
            let secret_path = app.path().app_data_dir()?.join("agent-secrets.json");
            app.manage(agent::AgentState::new(secret_path));
            // 图片资产字节落在应用私有目录，虚拟文件系统里只保留 Markdown。
            let asset_root = app.path().app_data_dir()?.join("assets");
            app.manage(assets::AssetStore::new(asset_root));
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
            commands::fs::user_read,
            commands::fs::user_search,
            commands::fs::root_dirs,
            commands::doc::doc_list,
            commands::doc::doc_get,
            commands::doc::doc_create,
            commands::doc::doc_rename,
            commands::doc::doc_save,
            commands::doc::doc_delete,
            commands::doc::doc_restore,
            commands::doc::doc_purge,
            commands::doc::doc_empty_trash,
            commands::doc::doc_set_pinned,
            commands::doc::doc_move,
            commands::doc::doc_move_path,
            commands::folder::folder_list,
            commands::folder::folder_path,
            commands::folder::folder_create,
            commands::folder::folder_reorder,
            commands::folder::folder_rename,
            commands::folder::folder_rename_default,
            commands::folder::folder_delete,
            commands::folder::folder_set_pinned,
            commands::version::version_list,
            commands::version::version_content,
            commands::version::version_create,
            commands::version::version_restore,
            commands::version::version_delete,
            commands::export::export_doc,
            commands::export::export_docs,
            commands::export::export_folder,
            commands::assets::asset_import,
            commands::assets::asset_data,
            commands::search::search_reindex,
            commands::skill::skill_list,
            commands::skill::skill_read,
            commands::skill::agent_skill_read,
            commands::skill::skill_save,
            commands::skill::skill_set_enabled,
            commands::skill::skill_delete,
            commands::skill::skill_import,
            commands::skill::skill_draft_list,
            commands::skill::skill_draft_read,
            commands::skill::skill_draft_promote,
            commands::skill::skill_draft_delete,
            commands::dir_config::lifeos_list,
            commands::dir_config::lifeos_get,
            commands::dir_config::lifeos_save,
            commands::dir_config::agent_config_get,
            commands::dir_config::agent_config_save,
            commands::agent::chat_list,
            commands::agent::chat_create,
            commands::agent::chat_rename,
            commands::agent::chat_set_model,
            commands::agent::chat_delete,
            commands::agent::chat_messages,
            commands::agent::chat_append,
            commands::agent::chat_truncate,
            commands::agent::chat_truncate_from,
            commands::agent::chat_delete_message,
            commands::agent::chat_run_start,
            commands::agent::chat_run_transition,
            commands::agent::chat_run_finish,
            commands::agent::chat_run_touch,
            commands::agent::chat_run_state,
            commands::agent::chat_run_resume,
            commands::agent::agent_settings,
            commands::agent::agent_prompt_config_set,
            commands::agent::agent_model_save,
            commands::agent::agent_model_delete,
            commands::agent::agent_model_activate,
            commands::agent::agent_models_list,
            commands::agent::agent_test_connection,
            commands::agent::agent_params_get,
            commands::agent::agent_params_set,
            commands::agent::agent_stream,
            commands::agent::agent_cancel,
            commands::mcp::mcp_server_list,
            commands::mcp::mcp_server_save,
            commands::mcp::mcp_server_delete,
            commands::mcp::mcp_server_tools,
            commands::mcp::mcp_all_tools,
            commands::mcp::mcp_tool_call,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
