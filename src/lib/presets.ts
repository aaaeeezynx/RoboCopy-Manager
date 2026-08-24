// 共用型別與預設值

/** robocopy 執行參數（對應 Rust 端的 RobocopyArgs） */
export interface RobocopyArgs {
  source: string;
  destination: string;
  extra_args: string[];
  exclude_dirs: string[];
  exclude_files: string[];
  /** 來源是否為單一檔案 */
  source_is_file: boolean;
  dry_run: boolean;
  /** 完成時是否發送系統通知 */
  notify: boolean;
}

/** 情境預設（P1） */
export interface Preset {
  id: string;
  label: string;
  icon: string;
  description: string;
  extraArgs: string[];
  /** 此情境是否會刪除目的端多餘檔案 */
  deletesDestination: boolean;
}

export const PRESETS: Preset[] = [
  {
    id: "add-only",
    label: "只加新檔",
    icon: "➕",
    description: "只複製新檔，不刪除任何東西（最安全）",
    extraArgs: ["/E", "/XO", "/R:1", "/W:1"],
    deletesDestination: false,
  },
  {
    id: "incremental",
    label: "同步更新",
    icon: "🔄",
    description: "鏡像但只動有變動的檔案",
    extraArgs: ["/MIR", "/XO", "/FFT", "/R:1", "/W:1"],
    deletesDestination: true,
  },
  {
    id: "mirror",
    label: "完整鏡像",
    icon: "🪞",
    description: "目的地 = 來源完全一樣（多餘檔案會被刪除）",
    extraArgs: ["/MIR", "/R:1", "/W:1"],
    deletesDestination: true,
  },
  {
    id: "dry-run",
    label: "模擬測試",
    icon: "🧪",
    description: "只預覽會做什麼，不真的執行",
    extraArgs: [],
    deletesDestination: false,
  },
];

/** 進階參數 checkbox（P1 折疊區） */
export interface AdvancedOption {
  id: string;
  label: string;
  description: string;
  flag: string;
  defaultChecked: boolean;
}

export const ADVANCED_OPTIONS: AdvancedOption[] = [
  {
    id: "subdirs",
    label: "包含子資料夾",
    description: "/E  連同空的子資料夾一起複製",
    flag: "/E",
    defaultChecked: true,
  },
  {
    id: "mirror",
    label: "鏡像同步",
    description: "/MIR  目的地多餘的檔案會被刪除",
    flag: "/MIR",
    defaultChecked: false,
  },
  {
    id: "newer-only",
    label: "只覆蓋較新檔",
    description: "/XO  舊檔不動，省時間",
    flag: "/XO",
    defaultChecked: true,
  },
  {
    id: "preserve-perms",
    label: "保留權限",
    description: "/COPY:DATSOU  連 NTFS 權限一起複製",
    flag: "/COPY:DATSOU",
    defaultChecked: false,
  },
  {
    id: "fat-timestamps",
    label: "寬容時間戳",
    description: "/FFT  跨檔案系統（FAT/NTFS）時間戳誤差容忍",
    flag: "/FFT",
    defaultChecked: false,
  },
  {
    id: "restartable",
    label: "可續傳模式",
    description: "/Z  大檔案中斷可續傳（會稍慢）",
    flag: "/Z",
    defaultChecked: false,
  },
];

/** 排除範本（E1 Layer 1） */
export interface ExcludeTemplate {
  id: string;
  label: string;
  icon: string;
  dirs: string[];
  files: string[];
}

export const EXCLUDE_TEMPLATES: ExcludeTemplate[] = [
  {
    id: "dev",
    label: "開發專案",
    icon: "💻",
    dirs: ["node_modules", ".git", "dist", "build", ".next", ".cache"],
    files: ["*.log", "*.tmp"],
  },
  {
    id: "media",
    label: "媒體庫",
    icon: "🎵",
    dirs: ["@eaDir"],
    files: ["Thumbs.db", ".DS_Store"],
  },
  {
    id: "photo",
    label: "攝影備份",
    icon: "🖼️",
    dirs: [],
    files: ["*.CR2", "*.XMP", ".DS_Store", "Thumbs.db"],
  },
  {
    id: "minimal",
    label: "最小排除",
    icon: "🧹",
    dirs: [],
    files: ["Thumbs.db", ".DS_Store", "*.tmp"],
  },
];
