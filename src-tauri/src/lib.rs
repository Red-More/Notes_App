mod commands;
mod db;
mod models;

use db::Db;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let conn = db::init(app.handle())?;
            app.manage(Db(Mutex::new(conn)));
            // Log to the console and a rotating file under the OS log dir in
            // every build mode, so diagnostics exist on user machines too.
            let log_dir = app.path().app_log_dir()?;
            std::fs::create_dir_all(&log_dir)?;
            let log_file = tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::Folder {
                    path: log_dir,
                    file_name: Some("notes".into()),
                },
            );
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
            commands::notes::list_notes,
            commands::notes::get_note,
            commands::notes::create_note,
            commands::notes::save_note,
            commands::notes::delete_notes,
            commands::notes::set_notes_pinned,
            commands::notes::move_notes,
            commands::notes::list_deleted_notes,
            commands::notes::restore_notes,
            commands::notes::purge_notes,
            commands::notes::empty_trash,
            commands::notes::list_versions,
            commands::notes::restore_version,
            commands::notes::create_version,
            commands::notes::delete_version,
            commands::export::export_note_to,
            commands::export::export_notes_to,
            commands::export::export_folder_to,
            commands::folders::list_folders,
            commands::folders::create_folder,
            commands::folders::rename_folder,
            commands::folders::delete_folder,
            commands::folders::set_folder_pinned,
            commands::folders::rename_default_folder,
            commands::todos::list_todos,
            commands::todos::create_todo,
            commands::todos::update_todo,
            commands::todos::toggle_todo,
            commands::todos::delete_todo,
            commands::schedules::list_schedules,
            commands::schedules::create_schedule,
            commands::schedules::update_schedule,
            commands::schedules::delete_schedule,
            commands::contacts::list_contacts,
            commands::contacts::create_contact,
            commands::contacts::update_contact,
            commands::contacts::delete_contact,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
