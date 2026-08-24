use serde::Serialize;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

/// 系統強調色結果
#[derive(Serialize)]
pub struct AccentResult {
    /// 十六進位 #RRGGBB
    pub accent: String,
    /// 是否讀取成功
    pub ok: bool,
}

/// 讀取 Windows 系統強調色（DWM 登錄值 AccentColor）
/// AccentColor 是 DWORD，格式 0xAABBGGRR
pub fn read_system_accent() -> AccentResult {
    let hkcu = match RegKey::predef(HKEY_CURRENT_USER).open_subkey(
        r"Software\Microsoft\Windows\DWM",
    ) {
        Ok(k) => k,
        Err(_) => return AccentResult { accent: "#005FB8".into(), ok: false },
    };
    let value: u32 = match hkcu.get_value("AccentColor") {
        Ok(v) => v,
        Err(_) => return AccentResult { accent: "#005FB8".into(), ok: false },
    };
    // DWORD 為 AABBGGRR，取出 RR/GG/BB
    let r = (value & 0xFF) as u8;
    let g = ((value >> 8) & 0xFF) as u8;
    let b = ((value >> 16) & 0xFF) as u8;
    AccentResult {
        accent: format!("#{:02X}{:02X}{:02X}", r, g, b),
        ok: true,
    }
}

#[tauri::command]
pub fn get_system_accent() -> AccentResult {
    read_system_accent()
}