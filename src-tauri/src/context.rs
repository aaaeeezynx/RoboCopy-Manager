use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use winreg::enums::*;
use winreg::RegKey;

/// 保存程式啟動時從命令列拿到的待處理路徑，供前端稍候讀取
pub struct PendingPath(pub Mutex<Option<String>>);

/// 右鍵選單選單名稱與顯示文字
const MENU_PREFIX: &str = "RoboCopyBackup";
const MENU_LABEL: &str = "複製到 RoboCopy Manager";

/// 在檔案總管右鍵選單註冊 / 移除「複製到 RoboCopy Manager」
#[tauri::command]
pub fn set_explorer_context_menu(app: AppHandle, enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("取得程式路徑失敗: {e}"))?
        .to_string_lossy()
        .to_string();

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let classes = hkcu
        .open_subkey_with_flags("Software\\Classes", KEY_READ | KEY_WRITE)
        .map_err(|e| format!("開啟 HKCU\\Software\\Classes 失敗: {e}"))?;

    // 檔案（*）與資料夾（Directory）兩處都掛
    for target in ["*", "Directory"] {
        let verb_path = format!("{target}\\shell\\{MENU_PREFIX}");
        if enabled {
            // 先清除可能殘留的舊鍵，避免值累加/重複
            let _ = classes.delete_subkey_all(&verb_path);
            match classes.create_subkey(&verb_path) {
                Ok((key, _)) => {
                    let _ = key.set_value("", &MENU_LABEL);
                    let _ = key.set_value("Icon", &format!("\"{exe}\",0"));
                    match key.create_subkey("command") {
                        Ok((cmd, _)) => {
                            let _ = cmd.set_value("", &format!("\"{exe}\" \"%1\""));
                        }
                        Err(e) => {
                            let _ = classes.delete_subkey_all(&verb_path).map_err(|_| ());
                            return Err(format!("建立 command 失敗: {e}"));
                        }
                    }
                }
                Err(e) => return Err(format!("建立 {verb_path} 失敗: {e}")),
            }
        } else {
            let _ = classes.delete_subkey_all(&verb_path);
        }
    }

    // 通知前端刷新狀態（當有視窗時）
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("explorer-menu-changed", enabled);
    }
    let _ = app.emit("explorer-menu-changed", enabled);

    Ok(())
}

/// 取得啟動時從右鍵選單帶入的路徑（取出後清空）
#[tauri::command]
pub fn take_pending_path(state: tauri::State<PendingPath>) -> Result<Option<String>, String> {
    let mut g = state.0.lock().map_err(|e| e.to_string())?;
    Ok(g.take())
}