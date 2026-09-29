mod commands;
mod db;
mod models;

use db::Db;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let conn = db::init(app.handle())?;
            app.manage(Db(Mutex::new(conn)));
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
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
            commands::notes::list_versions,
            commands::notes::restore_version,
            commands::notes::create_label,
            commands::notes::update_label,
            commands::notes::delete_label,
            commands::folders::list_folders,
            commands::folders::create_folder,
            commands::folders::rename_folder,
            commands::folders::delete_folder,
            commands::folders::set_folder_pinned,
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
