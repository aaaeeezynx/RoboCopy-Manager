use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// robocopy 執行參數
#[derive(serde::Deserialize)]
pub struct RobocopyArgs {
    /// 來源資料夾
    pub source: String,
    /// 目的地資料夾
    pub destination: String,
    /// 額外參數（例如 /MIR /XO /R:1 /W:1）
    pub extra_args: Vec<String>,
    /// 排除的資料夾（/XD）
    pub exclude_dirs: Vec<String>,
    /// 排除的檔案（/XF）
    pub exclude_files: Vec<String>,
    /// 來源是否為單一檔案（而非資料夾）
    #[serde(default)]
    pub source_is_file: bool,
    /// 是否只模擬（/L）
    pub dry_run: bool,
    /// 完成時是否發送系統通知
    #[serde(default = "default_true")]
    pub notify: bool,
}

fn default_true() -> bool {
    true
}

/// 進度事件 payload
#[derive(serde::Serialize, Clone)]
pub struct ProgressEvent {
    /// 0~100
    pub percent: u8,
    /// 最近一行 log
    pub line: String,
}

/// 結果事件 payload
#[derive(serde::Serialize, Clone)]
pub struct ResultEvent {
    pub exit_code: i32,
    pub success: bool,
    pub message: String,
    /// 統計摘要
    pub source: String,
    pub destination: String,
    pub dirs: String,
    pub files: String,
    pub size: String,
    pub elapsed: String,
    pub speed: String,
}

/// 持有目前正在執行的 robocopy 行程
pub struct RobocopyState {
    child: Mutex<Option<Child>>,
}

impl RobocopyState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }
}

/// 將 robocopy exit code 轉成人類可讀訊息
/// robocopy 的 exit code 是 bitmask，0~7 算成功
fn interpret_exit_code(code: i32) -> (bool, String) {
    let success = code < 8;
    let mut parts: Vec<&str> = Vec::new();
    if code & 1 != 0 {
        parts.push("有檔案被複製");
    }
    if code & 2 != 0 {
        parts.push("有多餘檔案/資料夾");
    }
    if code & 4 != 0 {
        parts.push("有檔案不符");
    }
    if code & 8 != 0 {
        parts.push("部分檔案複製失敗");
    }
    if code & 16 != 0 {
        parts.push("發生嚴重錯誤");
    }
    let msg = if parts.is_empty() {
        "沒有檔案需要複製".to_string()
    } else {
        parts.join("；")
    };
    (success, msg)
}

#[tauri::command]
pub fn run_robocopy(
    app: AppHandle,
    state: State<RobocopyState>,
    args: RobocopyArgs,
) -> Result<(), String> {
    // 組裝參數
    let mut cmd_args: Vec<String> = Vec::new();
    if args.source_is_file {
        // 單一檔案來源：拆成「所在目錄 + 檔名」，
        // robocopy 以「來源目錄 目的地 檔名」的方式只複製該檔案
        let path = std::path::Path::new(&args.source);
        match (path.file_name(), path.parent()) {
            (Some(file_name), Some(parent)) => {
                cmd_args.push(parent.to_string_lossy().to_string());
                cmd_args.push(args.destination.clone());
                cmd_args.push(file_name.to_string_lossy().to_string());
            }
            // 拆不出檔名時退回直接把原始路徑當來源
            _ => {
                cmd_args.push(args.source.clone());
                cmd_args.push(args.destination.clone());
            }
        }
    } else {
        cmd_args.push(args.source.clone());
        cmd_args.push(args.destination.clone());
    }

    // 排除資料夾 /XD
    if !args.exclude_dirs.is_empty() {
        cmd_args.push("/XD".to_string());
        cmd_args.extend(args.exclude_dirs.iter().cloned());
    }
    // 排除檔案 /XF
    if !args.exclude_files.is_empty() {
        cmd_args.push("/XF".to_string());
        cmd_args.extend(args.exclude_files.iter().cloned());
    }
    // 額外參數
    cmd_args.extend(args.extra_args.iter().cloned());

    // 模擬模式
    if args.dry_run {
        cmd_args.push("/L".to_string());
    }

    // /NP 關閉進度百分比（我們自己解析）
    cmd_args.push("/NP".to_string());

    let mut command = Command::new("robocopy");
    command
        .args(&cmd_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // CREATE_NO_WINDOW: 不跳出黑色 cmd 視窗
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("啟動 robocopy 失敗: {}", e))?;
    let stdout = child.stdout.take().ok_or("無法取得 robocopy stdout")?;

    // 儲存行程供 cancel 使用
    {
        let mut guard = state.child.lock().map_err(|e| format!("鎖定失敗: {}", e))?;
        *guard = Some(child);
    }

    let app_handle = app.clone();
    let src = args.source.clone();
    let dst = args.destination.clone();
    let notify = args.notify;

    // 在獨立 thread 讀取 stdout 並 emit 進度
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut last_percent: u8 = 0;
        let mut buf_dirs = String::new();
        let mut buf_files = String::new();
        let mut buf_size = String::new();
        let mut buf_elapsed = String::new();

        // robocopy 以 Windows 主控台字碼頁輸出（可能非 UTF-8，例如 Big5/CP950），
        // 因此以 byte 為單位讀行並用 lossy 解碼，避免因單一非 UTF-8 位元組
        // 觸發 UTF-8 解碼錯誤而中斷後續摘要表解析。
        let mut line_bytes: Vec<u8> = Vec::new();
        loop {
            line_bytes.clear();
            let n = match reader.read_until(b'\n', &mut line_bytes) {
                Ok(n) => n,
                Err(_) => break,
            };
            if n == 0 {
                break;
            }
            let text = String::from_utf8_lossy(&line_bytes);
            let text = text.trim_end_matches(['\r', '\n']).to_string();

            // 嘗試解析百分比（robocopy 格式如 "  45%" 或 "100%"）
            if let Some(p) = parse_percent(&text) {
                last_percent = p;
            }
            // 擷取結尾的統計摘要表
            if let Some(v) = parse_summary_dirs(&text) {
                buf_dirs = v;
            }
            if let Some(v) = parse_summary_files(&text) {
                buf_files = v;
            }
            if let Some(v) = parse_summary_bytes(&text) {
                buf_size = v;
            }
            if let Some(v) = parse_summary_times(&text) {
                buf_elapsed = v;
            }
            let _ = app_handle.emit(
                "robocopy:progress",
                ProgressEvent {
                    percent: last_percent,
                    line: text,
                },
            );
        }

        // 摘要表沒有 Speed 列，用「總位元組 ÷ 用時」自行計算平均速度
        let buf_speed = compute_speed(&buf_size, &buf_elapsed);
        eprintln!(
            "[robocopy] 摘要解析: dirs={:?} files={:?} size={:?} elapsed={:?} speed={:?}",
            buf_dirs, buf_files, buf_size, buf_elapsed, buf_speed
        );

        // stdout 結束代表行程已收尾，取回 child 取得 exit code
        let state: State<RobocopyState> = app_handle.state();
        let exit_code = if let Ok(mut guard) = state.child.lock() {
            if let Some(mut child) = guard.take() {
                child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1)
            } else {
                -1
            }
        } else {
            -1
        };

        let (success, msg) = interpret_exit_code(exit_code);
        let event = ResultEvent {
            exit_code,
            success,
            message: format!("Exit {}: {}", exit_code, msg),
            source: src.clone(),
            destination: dst.clone(),
            dirs: buf_dirs.clone(),
            files: buf_files.clone(),
            size: buf_size.clone(),
            elapsed: buf_elapsed.clone(),
            speed: buf_speed.clone(),
        };
        let _ = app_handle.emit("robocopy:result", event.clone());

        // 若執行成功且使用者開啟通知，發出系統通知（含完整說明）
        if success && notify {
            let _ = send_notification(&app_handle, &event);
        }
    });

    Ok(())
}

/// 發送 Windows 系統通知
fn send_notification(app: &AppHandle, r: &ResultEvent) -> tauri::Result<()> {
    use tauri_winrt_notification::{Duration, Sound, Toast};

    // WinRT 通知要求呼叫執行緒已初始化 COM（MTA），否則會以 CO_E_NOTINITIALIZED 靜默失敗。
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Com::CoInitializeEx(
            std::ptr::null::<core::ffi::c_void>(),
            windows_sys::Win32::System::Com::COINIT_MULTITHREADED as u32,
        );
    }

    let text1 = format!("來源：{}", r.source);
    let text2 = format!(
        "目的地：{}\n已複製：{} 檔案、{} 資料夾，共 {}\n用時 {} · 速度 {}",
        r.destination, r.files, r.dirs, r.size, r.elapsed, r.speed
    );

    let build_toast = |app_id: &str| {
        Toast::new(app_id)
            .title("備份完成")
            .text1(&text1)
            .text2(&text2)
            .duration(Duration::Short)
            .sound(Some(Sound::Default))
    };

    // 優先使用應用程式本身的 AUMID（安裝版已透過開始功能表快捷鍵註冊）。
    // 若該 AUMID 未註冊（例如全新環境尚未安裝），再 fallback 到 PowerShell AUMID。
    let real_app_id = app.config().identifier.clone();
    match build_toast(&real_app_id).show() {
        Ok(()) => Ok(()),
        Err(first_err) => {
            eprintln!("[robocopy] 使用 AUMID「{real_app_id}」發送失敗: {first_err}，改試 PowerShell AUMID");
            build_toast(Toast::POWERSHELL_APP_ID).show().map_err(|e| {
                eprintln!("[robocopy] 系統通知發送失敗: {e}");
                tauri::Error::Anyhow(e.into())
            })
        }
    }
}

/// 從摘要列中擷取「Total」欄位（標籤冒號後的第一個 token）
/// robocopy 摘要格式例如："   Files :         6         6         0 ..."
/// 或中文："   檔案 :         6         6         0 ..."
fn extract_first_value(line: &str) -> Option<String> {
    // 以冒號切分，取「標籤後」的數值區段（第 2 段）
    let value_part = line.splitn(2, [':', '：']).nth(1)?.trim();
    let mut tokens = value_part.split_whitespace();
    let first = tokens.next()?;

    // 時間格式 HH:MM:SS
    if first.contains(':') {
        return Some(first.to_string());
    }

    // 數值（檔案/目錄數量或位元組大小）
    if first.parse::<f64>().is_ok() {
        // 若下一個 token 是單位（KB/MB/GB...），合併回傳
        let unit = tokens.next().unwrap_or("");
        if is_size_unit(unit) {
            return Some(format!("{} {}", first, unit));
        }
        return Some(first.to_string());
    }

    None
}

fn is_size_unit(s: &str) -> bool {
    matches!(s.to_ascii_uppercase().as_str(), "B" | "KB" | "MB" | "GB" | "TB" | "PB" | "K" | "M" | "G" | "T" | "P")
}

/// 依「總位元組」與「用時」計算平均速度字串
fn compute_speed(size: &str, elapsed: &str) -> String {
    let bytes = parse_bytes(size).unwrap_or(0.0);
    let secs = parse_elapsed_secs(elapsed);
    if secs <= 0.0 {
        return String::new();
    }
    let bps = bytes / secs;
    if bps >= 1024.0 * 1024.0 * 1024.0 {
        format!("{:.2} GB/s", bps / (1024.0 * 1024.0 * 1024.0))
    } else if bps >= 1024.0 * 1024.0 {
        format!("{:.2} MB/s", bps / (1024.0 * 1024.0))
    } else if bps >= 1024.0 {
        format!("{:.2} KB/s", bps / 1024.0)
    } else {
        format!("{:.0} B/s", bps)
    }
}

/// 解析位元組大小字串（如 "76.8 k"、"1.2 MB"）為位元組數
fn parse_bytes(size: &str) -> Option<f64> {
    let mut tokens = size.trim().split_whitespace();
    let num: f64 = tokens.next()?.parse().ok()?;
    let unit = tokens.next().unwrap_or("B").to_ascii_uppercase();
    let mult = match unit.as_str() {
        "B" => 1.0,
        "K" | "KB" => 1024.0,
        "M" | "MB" => 1024.0 * 1024.0,
        "G" | "GB" => 1024.0 * 1024.0 * 1024.0,
        "T" | "TB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        "P" | "PB" => 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    Some(num * mult)
}

/// 解析「HH:MM:SS」或「MM:SS」用時為秒數
fn parse_elapsed_secs(elapsed: &str) -> f64 {
    let mut parts = elapsed.trim().split(':').filter_map(|p| p.parse::<f64>().ok());
    match (parts.next(), parts.next(), parts.next()) {
        (Some(h), Some(m), Some(s)) => h * 3600.0 + m * 60.0 + s,
        (Some(m), Some(s), None) => m * 60.0 + s,
        (Some(s), None, None) => s,
        _ => 0.0,
    }
}

/// 擷取 robocopy 摘要表「Dirs / 目錄」列總計
fn parse_summary_dirs(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let label = trimmed.split(':').next().unwrap_or(trimmed);
    let label = label.split('：').next().unwrap_or(label).trim().to_lowercase();
    if label == "dirs" || label == "目錄" {
        extract_first_value(trimmed)
    } else {
        None
    }
}

/// 擷取 robocopy 摘要表「Files / 檔案」列總計
fn parse_summary_files(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let label = trimmed.split(':').next().unwrap_or(trimmed);
    let label = label.split('：').next().unwrap_or(label).trim().to_lowercase();
    if label == "files" || label == "檔案" {
        extract_first_value(trimmed)
    } else {
        None
    }
}

/// 擷取 robocopy 摘要表「Bytes / 位元組」列總計
fn parse_summary_bytes(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let label = trimmed.split(':').next().unwrap_or(trimmed);
    let label = label.split('：').next().unwrap_or(label).trim().to_lowercase();
    if label == "bytes" || label == "位元組" {
        extract_first_value(trimmed)
    } else {
        None
    }
}

/// 擷取 robocopy 摘要表「Times / 時間」列總計
fn parse_summary_times(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let label = trimmed.split(':').next().unwrap_or(trimmed);
    let label = label.split('：').next().unwrap_or(label).trim().to_lowercase();
    if label == "times" || label == "時間" || label == "time" {
        extract_first_value(trimmed)
    } else {
        None
    }
}

#[tauri::command]
pub fn cancel_robocopy(state: State<RobocopyState>) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|e| format!("鎖定失敗: {}", e))?;
    if let Some(mut child) = guard.take() {
        child.kill().map_err(|e| format!("終止失敗: {}", e))?;
    }
    Ok(())
}

/// 解析 robocopy 進度百分比
/// robocopy 進度行可能像 "  45%" 或 "100%"
fn parse_percent(line: &str) -> Option<u8> {
    let trimmed = line.trim();
    if trimmed.ends_with('%') {
        let num_part = trimmed.trim_end_matches('%').trim();
        num_part.parse::<u8>().ok()
    } else {
        None
    }
}
