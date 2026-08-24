mod accent;
mod context;
mod risk;
mod robocopy;
mod tray;

use context::PendingPath;
use robocopy::RobocopyState;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 命令列參數：若當次由「檔案總管右鍵→複製到 RoboCopy Manager」啟動，
    // 最後一個非旗標參數即為選中的路徑
    let mut pending: Option<String> = None;
    for arg in std::env::args().skip(1) {
        if arg.starts_with('-') || arg.starts_with('/') {
            continue;
        }
        pending = Some(arg.trim_matches('"').to_string());
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_single_instance::init(|app, args, _cwd| {
                let path = args
                    .into_iter()
                    .last()
                    .filter(|a| !a.starts_with('-') && !a.starts_with('/'))
                    .map(|a| a.trim_matches('"').to_string());
                // 已是運行中的實例，把路徑轉發給既有主視窗
                if let Some(p) = path {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.emit("context-menu:path", p);
                        let _ = win.show();
                        let _ = win.unminimize();
                        let _ = win.set_focus();
                    }
                } else {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.unminimize();
                        let _ = win.set_focus();
                    }
                }
            }),
        )
        .manage(RobocopyState::new())
        .manage(PendingPath(Mutex::new(pending)))
        .setup(|app| {
            tray::setup_tray(&app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            robocopy::run_robocopy,
            robocopy::cancel_robocopy,
            risk::analyze_path_risk,
            accent::get_system_accent,
            tray::update_tray_tasks,
            tray::set_tray_visible,
            context::set_explorer_context_menu,
            context::take_pending_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
