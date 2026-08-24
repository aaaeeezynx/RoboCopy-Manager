use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

/// 建立 tray 圖示與選單
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "開啟主視窗", true, None::<&str>)?;
    let quick_select =
        MenuItem::with_id(app, "quick-select", "快速選擇 來源/目的地…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "結束", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &quick_select, &quit])?;

    // 取 app 預設視窗圖示作為 tray 圖示
    let icon = app
        .default_window_icon()
        .cloned()
        .expect("找不到預設圖示");

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("RoboCopy Manager")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => show_main(app),
            "quick-select" => {
                let _ = app.emit("tray:quick-select", ());
            }
            "quit" => app.exit(0),
            id => {
                if let Some(task_name) = id.strip_prefix("task:") {
                    let _ = app.emit("tray:run-task", task_name.to_string());
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// 顯示並聚焦主視窗
fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 顯示或隱藏系統匣圖示與右鍵菜單
#[tauri::command]
pub fn set_tray_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_visible(visible).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 供前端呼叫：重建 tray 功能表，動態加入任務快速執行項
#[tauri::command]
pub fn update_tray_tasks(app: AppHandle, tasks: Vec<TrayTask>) -> Result<(), String> {
    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
    let toggle = MenuItem::with_id(&app, "toggle", "開啟主視窗", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quick_select =
        MenuItem::with_id(&app, "quick-select", "快速選擇 來源/目的地…", true, None::<&str>)
            .map_err(|e| e.to_string())?;
    items.push(Box::new(toggle));
    items.push(Box::new(quick_select));

    if !tasks.is_empty() {
        let sep = tauri::menu::PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
        items.push(Box::new(sep));
        for task in tasks {
            let item = MenuItem::with_id(
                &app,
                format!("task:{}", task.name),
                format!("執行「{}」", task.name),
                true,
                None::<&str>,
            )
            .map_err(|e| e.to_string())?;
            items.push(Box::new(item));
        }
    }

    let sep2 = tauri::menu::PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(&app, "quit", "結束", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    items.push(Box::new(sep2));
    items.push(Box::new(quit));

    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        items.iter().map(|i| i.as_ref()).collect();
    let menu = Menu::with_items(&app, &refs).map_err(|e| e.to_string())?;

    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct TrayTask {
    pub name: String,
    pub source: String,
    pub destination: String,
}