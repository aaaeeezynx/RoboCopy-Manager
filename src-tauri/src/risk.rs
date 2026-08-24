use serde::Serialize;

/// 目的地風險分析結果
#[derive(Serialize)]
pub struct RiskResult {
    /// 來源磁碟字根，例如 C:
    pub source_root: String,
    /// 目的地磁碟字根，例如 D:
    pub destination_root: String,
    /// 目的地是否為系統碟
    pub is_system_drive: bool,
    /// 與來源是否同一顆磁碟（多以磁碟字根判斷）
    pub same_drive: bool,
    /// 建議的重大風險（非空即有風險提示）
    pub warnings: Vec<String>,
}

/// 取出路徑的磁碟字根，例如 "C:\foo" -> "C:"
fn drive_root(path: &str) -> String {
    let p = path.trim();
    let bytes = p.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        p[..2].to_uppercase()
    } else {
        String::new()
    }
}

/// 判斷某磁碟字根是否為系統碟
/// Windows 系統通常安裝在 C:，此處以 SYSTEMDRIVE 環境變數為準，失敗則假設 C:
fn system_drive() -> String {
    std::env::var("SYSTEMDRIVE")
        .unwrap_or_else(|_| "C:".into())
        .trim()
        .to_uppercase()
}

#[tauri::command]
pub fn analyze_path_risk(source: String, destination: String) -> RiskResult {
    let src_root = drive_root(&source);
    let dst_root = drive_root(&destination);
    let sys = system_drive();

    let is_system_drive = !dst_root.is_empty() && dst_root == sys;
    let same_drive = !src_root.is_empty() && src_root == dst_root;

    let mut warnings = Vec::new();

    if is_system_drive {
        warnings.push(format!(
            "目的地位於系統碟 {}，誤操作可能影響 Windows 系統，請小心。",
            dst_root
        ));
    }
    if same_drive {
        warnings.push("來源與目的地在同一顆磁碟，若硬碟故障會同時損失兩份資料，建議改用外接或另一顆磁碟。".to_string());
    }
    if dst_root.is_empty() {
        warnings.push("無法判斷目的地磁碟代號。".to_string());
    }

    RiskResult {
        source_root: src_root,
        destination_root: dst_root,
        is_system_drive,
        same_drive,
        warnings,
    }
}