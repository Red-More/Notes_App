mod agent;
mod commands;
mod db;
mod docs;
mod mcp;
mod media;
mod privacy;
mod skills;
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
            // 首次启动写入 6 个内置技能；已种过则不再补，避免卸载后复活。
            let mut vault = VirtualFs::new(conn);
            // 媒体作业不跨进程续跑：上次运行中的作业标记失败，排队中的保留。
            if let Err(e) = media::jobs::recover(vault.conn()) {
                log::warn!("media job recovery failed: {e}");
            }
            // 聊天作业不跨进程续跑：排队/运行中的行标记为 interrupted，保留部分输出。
            if let Err(e) = agent::jobs::recover(vault.conn()) {
                log::warn!("chat job recovery failed: {e}");
            }
            if let Err(e) = skills::seed_builtins(&mut vault) {
                eprintln!("life.db skill seed failed: {e}");
            }
            // Agent 工作区：模型可读写，但草稿不会自动加载。
            if let Err(e) = skills::ensure_workspace(&vault) {
                eprintln!("life.db agent workspace failed: {e}");
            }
            app.manage(VfsState(Mutex::new(vault)));
            // Agent 侧状态：HTTP 客户端、私有密钥文件、取消标记与本地运行时。
            let secret_path = app.path().app_data_dir()?.join("agent-secrets.json");
            let models_dir = app.path().app_data_dir()?.join("models");
            let agent_state = agent::AgentState::new(secret_path, models_dir);
            // 本地模型偏好随应用启动恢复；仅在用户启用后才加载。
            let local_config = {
                let vfs = app.state::<VfsState>();
                let vfs = vfs.0.lock().unwrap();
                agent::local::runtime::load_config(vfs.conn())
            };
            agent_state.local.set_config(local_config);
            app.manage(agent_state);
            // 本地 MNN 模型根目录：bundle 目录由用户/开发流程放入，命令只认目录名。
            let mnn_root = app.path().app_data_dir()?.join("models").join("mnn");
            app.manage(agent::local_mnn::LocalMnnState::new(mnn_root));
            // 聊天作业：命令只入队，后台单分派器按引擎串行执行，页面切换不再取消生成。
            let chat_jobs = std::sync::Arc::new(agent::jobs::ChatJobs::new());
            app.manage(chat_jobs.clone());
            agent::jobs::spawn(app.handle().clone(), chat_jobs);
            // 媒体资产目录与作业取消标记；与 Agent run 生命周期解耦。
            let media_root = app.path().app_data_dir()?.join("media");
            std::fs::create_dir_all(&media_root)?;
            app.manage(media::MediaState::new(media_root));
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
            commands::index::search_reindex,
            commands::skill::skill_list,
            commands::skill::skill_read,
            commands::skill::skill_save,
            commands::skill::skill_set_enabled,
            commands::skill::skill_delete,
            commands::skill::skill_import,
            commands::skill::skill_draft_list,
            commands::skill::skill_draft_read,
            commands::skill::skill_draft_promote,
            commands::skill::skill_draft_delete,
            commands::agent::chat_list,
            commands::agent::chat_create,
            commands::agent::chat_rename,
            commands::agent::chat_delete,
            commands::agent::chat_messages,
            commands::agent::chat_append,
            commands::agent::chat_truncate,
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
            commands::chat_job::chat_job_submit,
            commands::chat_job::chat_job_watch,
            commands::chat_job::chat_job_snapshot,
            commands::chat_job::chat_job_list,
            commands::chat_job::chat_job_cancel,
            commands::local::local_model_status,
            commands::local::local_model_config_set,
            commands::local::local_model_load,
            commands::local::local_model_unload,
            commands::local::local_model_pause,
            commands::local::local_model_resume,
            commands::local::local_model_import,
            commands::local::local_model_remove,
            commands::local::local_model_activate,
            commands::privacy::privacy_labels_list,
            commands::privacy::privacy_label_set,
            commands::privacy::privacy_label_delete,
            commands::privacy::privacy_entities_list,
            commands::privacy::privacy_entity_add,
            commands::privacy::privacy_entity_delete,
            commands::privacy::privacy_audit_list,
            commands::media::media_job_submit,
            commands::media::media_job_list,
            commands::media::media_job_get,
            commands::media::media_job_cancel,
            commands::media::media_asset_get,
            commands::media::media_asset_path,
            commands::media::media_asset_data,
            commands::media::media_asset_gc,
            commands::media::media_asset_store,
            commands::mcp::mcp_server_list,
            commands::mcp::mcp_server_save,
            commands::mcp::mcp_server_delete,
            commands::mcp::mcp_server_tools,
            commands::mcp::mcp_all_tools,
            commands::mcp::mcp_tool_call,
            commands::local_mnn::local_mnn_status,
            commands::local_mnn::local_mnn_models,
            commands::local_mnn::local_mnn_load,
            commands::local_mnn::local_mnn_generate,
            commands::local_mnn::local_mnn_cancel,
            commands::local_mnn::local_mnn_unload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
