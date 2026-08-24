import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readTextFile, stat, writeTextFile } from "@tauri-apps/plugin-fs";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ADVANCED_OPTIONS,
  EXCLUDE_TEMPLATES,
  PRESETS,
  type RobocopyArgs,
} from "./lib/presets";
import "./App.css";

interface ProgressPayload {
  percent: number;
  line: string;
}
interface ResultPayload {
  exit_code: number;
  success: boolean;
  message: string;
  source: string;
  destination: string;
  dirs: string;
  files: string;
  size: string;
  elapsed: string;
  speed: string;
}

type Excludable = { value: string; type: "dir" | "file" };

/** 一個已儲存任務 */
interface SavedTask {
  id: string;
  name: string;
  source: string;
  destination: string;
  /** 來源是否為單一檔案 */
  sourceIsFile: boolean;
  presetId: string;
  checkedFlags: Record<string, boolean>;
  excludes: Excludable[];
  dryRun: boolean;
}

/** 一筆執行歷程 */
interface HistoryEntry {
  id: string;
  /** ISO 時間字串 */
  time: string;
  taskName: string;
  source: string;
  destination: string;
  success: boolean;
  message: string;
  files: string;
  dirs: string;
  size: string;
  elapsed: string;
  speed: string;
}

/** 應用程式設定 */
interface AppSettings {
  /** 備份完成時發送系統通知 */
  notifyOnFinish: boolean;
  /** 系統匣右鍵菜單是否顯示 */
  trayVisible: boolean;
  /** 檔案總管右鍵選單是否啟用 */
  explorerContext: boolean;
}

const TASKS_KEY = "rococopy-manager.tasks";
const THEME_KEY = "rococopy-manager.theme";
const HISTORY_KEY = "rococopy-manager.history";
const SETTINGS_KEY = "rococopy-manager.settings";
/** 歷程最多保留筆數 */
const HISTORY_LIMIT = 100;

type ThemeMode = "light" | "dark" | "system";

function loadTasks(): SavedTask[] {
  try {
    const raw = localStorage.getItem(TASKS_KEY);
    return raw ? (JSON.parse(raw) as SavedTask[]) : [];
  } catch {
    return [];
  }
}
function persistTasks(tasks: SavedTask[]) {
  try {
    localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  } catch {
    /* 忽略 */
  }
}
function loadTheme(): ThemeMode {
  return (localStorage.getItem(THEME_KEY) as ThemeMode) || "system";
}
function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw
      ? {
          notifyOnFinish: true,
          trayVisible: true,
          explorerContext: true,
          ...(JSON.parse(raw) as Partial<AppSettings>),
        }
      : { notifyOnFinish: true, trayVisible: true, explorerContext: true };
  } catch {
    return { notifyOnFinish: true, trayVisible: true, explorerContext: true };
  }
}

/** 依主題計算實際應用的明暗 */
function computeResolvedTheme(mode: ThemeMode, systemDark: boolean): "light" | "dark" {
  if (mode === "system") return systemDark ? "dark" : "light";
  return mode;
}

function App() {
  // ---- 主題與強調色 ----
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadTheme());
  const [systemDark, setSystemDark] = useState<boolean>(false);
  useEffect(() => {
    getCurrentWindow().theme().then((t) => setSystemDark(t === "dark"));
  }, []);
  const resolvedTheme = computeResolvedTheme(themeMode, systemDark);
  const [accent, setAccent] = useState("#005FB8");

  // 套用到 document
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);
  useEffect(() => {
    document.documentElement.style.setProperty("--accent", accent);
    // 依明暗微調強調色亮度
    const lightAccent =
      resolvedTheme === "dark"
        ? lightenColor(accent, 0.22)
        : darkenColor(accent, 0.08);
    document.documentElement.style.setProperty("--accent-strong", lightAccent);
  }, [accent, resolvedTheme]);

  // 讀取系統強調色
  useEffect(() => {
    (async () => {
      try {
        const res = await invoke<{ accent: string; ok: boolean }>("get_system_accent");
        if (res.ok) setAccent(res.accent);
      } catch {
        /* 使用預設 */
      }
    })();
  }, []);

  // 監聽系統主題變化
  useEffect(() => {
    const win = getCurrentWindow();
    const clean = win.onThemeChanged((e) => {
      setSystemDark(e.payload === "dark");
    });
    return () => {
      clean.then((f) => f());
    };
  }, []);

  function setTheme(mode: ThemeMode) {
    setThemeMode(mode);
    localStorage.setItem(THEME_KEY, mode);
  }

  // ---- 路徑 ----
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  /** 來源是否為單一檔案（否則為資料夾） */
  const [sourceIsFile, setSourceIsFile] = useState(false);
  const sourceIsFileRef = useRef(sourceIsFile);
  useEffect(() => {
    sourceIsFileRef.current = sourceIsFile;
  }, [sourceIsFile]);
  const sourceDropRef = useRef<HTMLDivElement>(null);
  const destDropRef = useRef<HTMLDivElement>(null);

  // ---- 情境 & 參數 ----
  const [activePreset, setActivePreset] = useState<string>("add-only");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [checkedFlags, setCheckedFlags] = useState<Record<string, boolean>>(
    () => Object.fromEntries(ADVANCED_OPTIONS.map((o) => [o.id, o.defaultChecked]))
  );
  const [dryRun, setDryRun] = useState(false);

  // ---- 排除 ----
  const [excludes, setExcludes] = useState<Excludable[]>([]);
  const [excludeInput, setExcludeInput] = useState("");
  const [dragOver, setDragOver] = useState(false);

  // ---- 執行狀態 ----
  const [running, setRunning] = useState(false);
  const [runningName, setRunningName] = useState("");
  const [percent, setPercent] = useState(0);
  const [logs, setLogs] = useState<{ task: string; lines: string[] }[]>([]);
  const [result, setResult] = useState<ResultPayload | null>(null);
  const [resultSourceTask, setResultSourceTask] = useState("");
  const logBoxRef = useRef<HTMLDivElement>(null);

  // ---- 風險提示 ----
  const [riskWarning, setRiskWarning] = useState<string[]>([]);

  // ---- 任務 ----
  const [tasks, setTasks] = useState<SavedTask[]>(() => loadTasks());
  const [taskInput, setTaskInput] = useState("");
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(
    () => new Set()
  );

  // ---- 歷程 ----
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      /* 忽略 */
    }
  }, [history]);

  // ---- 設定 ----
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  function updateSettings(patch: Partial<AppSettings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* 忽略 */
      }
      return next;
    });
  }

  // ---- 依設定同步系統匣圖示（右鍵菜單）顯示狀態 ----
  useEffect(() => {
    invoke("set_tray_visible", { visible: settings.trayVisible }).catch((e) =>
      console.error(e),
    );
  }, [settings.trayVisible]);

  // ---- 依設定同步檔案總管右鍵選單開關 ----
  useEffect(() => {
    invoke("set_explorer_context_menu", {
      enabled: settings.explorerContext,
    }).catch((e) => console.error(e));
  }, [settings.explorerContext]);

  // ---- 若本次程由檔案總管右鍵啟動，取回來源路徑 ----
  useEffect(() => {
    (async () => {
      try {
        const p = await invoke<string | null>("take_pending_path");
        if (p) {
          setActiveNav("quick");
          setSource(p);
        }
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  // ---- 右側導覽 ----
  const [activeNav, setActiveNav] = useState<
    "quick" | "run" | "history" | "settings"
  >("quick");

  // ---- tray：任務更新時重建選單 ----
  useEffect(() => {
    (async () => {
      try {
        await invoke("update_tray_tasks", {
          tasks: tasks.map((t) => ({
            name: t.name,
            source: t.source,
            destination: t.destination,
          })),
        });
      } catch (e) {
        console.error(e);
      }
    })();
  }, [tasks]);

  // ---- tray 事件 ----
  useEffect(() => {
    const un1 = listen<string>("tray:run-task", (e) => {
      const t = tasks.find((x) => x.name === e.payload);
      if (t) {
        setActiveNav("run");
        loadTask(t);
        setTimeout(() => startBackup(t.source, t.destination, t), 0);
      }
    });
    const un2 = listen("tray:quick-select", async () => {
      setActiveNav("quick");
      await pickFolder("source", sourceIsFileRef.current);
      await pickFolder("destination");
    });
    // 檔案總管右鍵：收到選中的路徑，填入來源並跳到快速執行頁
    const un3 = listen<string>("context-menu:path", (e) => {
      setActiveNav("quick");
      setSource(e.payload);
    });
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
      un3.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  // ---- robocopy 事件 ----
  useEffect(() => {
    const unProgress = listen<ProgressPayload>("robocopy:progress", (e) => {
      setPercent(e.payload.percent);
      setLogs((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last) last.lines.push(e.payload.line);
        return copy;
      });
    });
    const unResult = listen<ResultPayload>("robocopy:result", (e) => {
      setResult(e.payload);
      if (e.payload.success && lastTaskNameRef.current) {
        setResultSourceTask(lastTaskNameRef.current);
      }
      // 記錄執行歷程
      setHistory((prev) =>
        [
          {
            id: crypto.randomUUID(),
            time: new Date().toISOString(),
            taskName: lastTaskNameRef.current || "目前設定",
            source: e.payload.source,
            destination: e.payload.destination,
            success: e.payload.success,
            message: e.payload.message,
            files: e.payload.files,
            dirs: e.payload.dirs,
            size: e.payload.size,
            elapsed: e.payload.elapsed,
            speed: e.payload.speed,
          },
          ...prev,
        ].slice(0, HISTORY_LIMIT)
      );
      setRunning(false);
      setRunningName("");
      setPercent(100);
    });
    return () => {
      unProgress.then((f) => f());
      unResult.then((f) => f());
    };
  }, []);
  const lastTaskNameRef = useRef("");

  // 開始備份前記錄任務名
  const startedTaskNameRef = useRef("");

  // log 自動捲底
  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  // Tauri 官方拖放
  useEffect(() => {
    function hit(el: HTMLElement | null, x: number, y: number) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }
    const clean = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        const { paths, position } = event.payload;
        if (!paths || paths.length === 0) return;
        const p = paths[0].replace(/\/+$/, "").replace(/\\+$/, "");
        if (hit(sourceDropRef.current, position.x, position.y)) {
          // 判斷來源是檔案還是資料夾
          stat(p)
            .then((info) => setSourceIsFile(info.isFile))
            .catch(() => setSourceIsFile(false));
          setSource(p);
        } else if (hit(destDropRef.current, position.x, position.y)) {
          setDestination(p);
        }
      }
    });
    return () => {
      clean.then((f) => f());
    };
  }, []);

  // 目的地風險
  useEffect(() => {
    if (!destination) {
      setRiskWarning([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await invoke<{
          is_system_drive: boolean;
          same_drive: boolean;
          warnings: string[];
        }>("analyze_path_risk", { source, destination });
        if (!cancelled) setRiskWarning(res.warnings ?? []);
      } catch {
        if (!cancelled) setRiskWarning([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, destination]);

  // ---- 鍵盤快速鍵 ----
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        if (!running) startBackup(source, destination, null);
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveTask();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        exportTasks();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        importTasks();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, source, destination, tasks, taskInput, checkedFlags, excludes, dryRun, activePreset]);

  // 選擇資料夾或檔案
  async function pickFolder(which: "source" | "destination", asFile = false) {
    const selected = await openDialog(
      asFile
        ? { multiple: false, directory: false }
        : { multiple: false, directory: true }
    );
    if (typeof selected === "string") {
      if (which === "source") {
        setSourceIsFile(asFile);
        setSource(selected);
      } else {
        setDestination(selected);
      }
    }
  }

  // 選擇情境預設
  function applyPreset(id: string) {
    setActivePreset(id);
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const next: Record<string, boolean> = {};
    for (const k of Object.keys(checkedFlags)) next[k] = false;
    for (const flag of preset.extraArgs) {
      const opt = ADVANCED_OPTIONS.find((o) => o.flag === flag);
      if (opt) next[opt.id] = true;
    }
    // 未涵蓋的參數保留
    const finalFlags: Record<string, boolean> = {
      ...checkedFlags,
      ...next,
    };
    setCheckedFlags(finalFlags);
  }

  // 套用排除範本
  function applyExcludeTemplate(templateId: string) {
    const tpl = EXCLUDE_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return;
    const merged: Excludable[] = [...excludes];
    const exists = new Set(merged.map((e) => `${e.type}:${e.value}`));
    for (const d of tpl.dirs) {
      const key = `dir:${d}`;
      if (!exists.has(key)) {
        merged.push({ value: d, type: "dir" });
        exists.add(key);
      }
    }
    for (const f of tpl.files) {
      const key = `file:${f}`;
      if (!exists.has(key)) {
        merged.push({ value: f, type: "file" });
        exists.add(key);
      }
    }
    setExcludes(merged);
  }

  function addExcludeFromInput() {
    const v = excludeInput.trim();
    if (!v) return;
    const isDir = v.endsWith("/") || v.endsWith("\\");
    const type: "dir" | "file" = isDir ? "dir" : "file";
    const value = isDir ? v.replace(/[\\/]+$/, "") : v;
    const exists = excludes.some((e) => e.type === type && e.value === value);
    if (!exists) setExcludes([...excludes, { value, type }]);
    setExcludeInput("");
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const paths: string[] = [];
    const dt = e.dataTransfer;
    if (dt.files && dt.files.length) {
      for (let i = 0; i < dt.files.length; i++) paths.push(dt.files[i].name);
    } else if (typeof dt.getData("text") === "string" && dt.getData("text")) {
      paths.push(dt.getData("text"));
    }
    const merged: Excludable[] = [...excludes];
    const exists = new Set(merged.map((x) => `${x.type}:${x.value}`));
    for (const p of paths) {
      const value = p.split(/[\\/]/).pop() || p;
      const type: "dir" | "file" = p.includes(".") ? "file" : "dir";
      const key = `${type}:${value}`;
      if (!exists.has(key)) {
        merged.push({ value, type });
        exists.add(key);
      }
    }
    setExcludes(merged);
  }

  function removeExclude(idx: number) {
    setExcludes(excludes.filter((_, i) => i !== idx));
  }

  // 白話摘要
  function buildSummary(task?: SavedTask): string {
    const src = task ? task.source : source;
    const dst = task ? task.destination : destination;
    const srcIsFile = task ? !!task.sourceIsFile : sourceIsFile;
    const preset =
      PRESETS.find((p) => p.id === (task ? task.presetId : activePreset)) ??
      PRESETS[0];
    if (!src || !dst)
      return srcIsFile
        ? "請先選擇來源檔案與目的地資料夾。"
        : "請先選擇來源與目的地資料夾。";
    const isDry = task ? task.dryRun : dryRun || preset.id === "dry-run";
    const parts: string[] = [];
    parts.push(srcIsFile ? `把檔案「${src}」` : `把「${src}」`);
    parts.push(isDry ? "模擬同步到" : "備份到");
    parts.push(`「${dst}」`);
    const behaviors: string[] = [];
    if (preset.deletesDestination) behaviors.push("會刪除目的端多餘檔案");
    else behaviors.push("不會刪除任何檔案");
    const flags = task ? task.checkedFlags : checkedFlags;
    if (flags["subdirs"]) behaviors.push("含子資料夾");
    if (flags["newer-only"]) behaviors.push("只複製較新檔案");
    if (flags["restartable"]) behaviors.push("支援續傳");
    if (behaviors.length) parts.push(`（${behaviors.join("、")}）`);
    const ex = task ? task.excludes : excludes;
    const allEx = ex.map((e) => e.value);
    if (allEx.length) parts.push(`；排除 ${allEx.join(", ")}`);
    return parts.join(" ") + "。";
  }

  // ---- 組裝並執行單一備份 ----
  async function startBackup(
    srcArg: string,
    dstArg: string,
    task: SavedTask | null
  ) {
    const srcIsFile = task ? !!task.sourceIsFile : sourceIsFile;
    if (!srcArg || !dstArg) {
      alert(
        srcIsFile
          ? "請先選擇來源檔案與目的地資料夾"
          : "請先選擇來源與目的地資料夾"
      );
      return;
    }
    setRunning(true);
    setRunningName(task ? task.name : "目前設定");
    setPercent(0);
    setResult(null);
    const flags = task ? task.checkedFlags : checkedFlags;
    const ex = task ? task.excludes : excludes;
    const isDry = task ? task.dryRun : dryRun;

    const extraArgs: string[] = [];
    for (const opt of ADVANCED_OPTIONS) {
      if (flags[opt.id]) extraArgs.push(opt.flag);
    }
    const args: RobocopyArgs = {
      source: srcArg,
      destination: dstArg,
      extra_args: extraArgs,
      exclude_dirs: ex.filter((e) => e.type === "dir").map((e) => e.value),
      exclude_files: ex.filter((e) => e.type === "file").map((e) => e.value),
      source_is_file: srcIsFile,
      dry_run: isDry,
      notify: settings.notifyOnFinish,
    };
    startedTaskNameRef.current = task ? task.name : "";
    lastTaskNameRef.current = startedTaskNameRef.current;
    setLogs([{ task: task ? task.name : "目前設定", lines: [] }]);
    try {
      await invoke("run_robocopy", { args });
    } catch (err) {
      setRunning(false);
      setRunningName("");
      setResult({
        exit_code: -1,
        success: false,
        message: `啟動失敗: ${err}`,
        source: srcArg,
        destination: dstArg,
        dirs: "",
        files: "",
        size: "",
        elapsed: "",
        speed: "",
      });
    }
  }

  // ---- 多 Job：依序執行勾選任務 ----
  async function runSelectedTasks() {
    const selected = tasks.filter((t) => selectedTaskIds.has(t.id));
    if (selected.length === 0) {
      alert("請先勾選要執行任務");
      return;
    }
    for (const t of selected) {
      if (running) break; // 被取消
      await startBackup(t.source, t.destination, t);
      // 等待上一個執行完成（running 轉 false）再繼續
      await waitForFinish();
    }
  }

  function waitForFinish(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!runningRef.current) resolve();
        else setTimeout(check, 300);
      };
      check();
    });
  }
  const runningRef = useRef(false);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  async function cancelBackup() {
    try {
      await invoke("cancel_robocopy");
    } catch (err) {
      console.error(err);
    }
    setRunning(false);
    setRunningName("");
  }

  // ---- 任務 CRUD ----
  function saveTask() {
    const name = taskInput.trim();
    if (!name) {
      alert("請先輸入任務名稱");
      return;
    }
    const task: SavedTask = {
      id: crypto.randomUUID(),
      name,
      source,
      destination,
      sourceIsFile,
      presetId: activePreset,
      checkedFlags: { ...checkedFlags },
      excludes: excludes.map((e) => ({ ...e })),
      dryRun,
    };
    const next = [...tasks, task];
    setTasks(next);
    persistTasks(next);
    setTaskInput("");
  }

  function loadTask(task: SavedTask) {
    setSource(task.source);
    setSourceIsFile(task.sourceIsFile ?? false);
    setDestination(task.destination);
    setActivePreset(task.presetId);
    setExcludes(task.excludes.map((e) => ({ ...e })));
    setDryRun(task.dryRun);
    const next: Record<string, boolean> = {};
    for (const opt of ADVANCED_OPTIONS) {
      next[opt.id] = task.checkedFlags[opt.id] ?? opt.defaultChecked;
    }
    setCheckedFlags(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function deleteTask(id: string) {
    const next = tasks.filter((t) => t.id !== id);
    setTasks(next);
    persistTasks(next);
    setSelectedTaskIds((prev) => {
      const s = new Set(prev);
      s.delete(id);
      return s;
    });
  }

  function toggleTaskSelect(id: string) {
    setSelectedTaskIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  }

  // ---- 匯入 / 匯出 ----
  async function exportTasks() {
    if (tasks.length === 0) {
      alert("沒有任務可匯出");
      return;
    }
    try {
      const p = await saveDialog({ defaultPath: "robocopy-tasks.json" });
      if (!p) return;
      await writeTextFile(p, JSON.stringify(tasks, null, 2));
      alert("匯出成功");
    } catch (e) {
      alert(`匯出失敗: ${e}`);
    }
  }

  async function importTasks() {
    try {
      const sel = await openDialog({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof sel !== "string") return;
      const text = await readTextFile(sel);
      const imported = JSON.parse(text) as SavedTask[];
      if (!Array.isArray(imported)) throw new Error("格式錯誤");
      // 賦予新 id 避免重疊
      const normalized = imported.map((t) => ({ ...t, id: crypto.randomUUID() }));
      const next = [...tasks, ...normalized];
      setTasks(next);
      persistTasks(next);
      alert(`已匯入 ${normalized.length} 筆任務`);
    } catch (e) {
      alert(`匯入失敗: ${e}`);
    }
  }

  /** 清理 robocopy 摘要欄位（去除前綴如 "Files :"） */
  function cleanStat(v: string, prefix: string): string {
    return v.replace(new RegExp(`^${prefix}\\s*:?\\s*`), "").trim();
  }

  function formatHistoryTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString("zh-TW", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatResultDetail(r: ResultPayload) {
    const row = (label: string, value: string) => (
      <div className="result-stat" key={label}>
        <span className="result-stat-label">{label}</span>
        <span className="result-stat-value">{value || "—"}</span>
      </div>
    );
    const items = [row("來源", r.source), row("目的地", r.destination)];
    if (r.size) items.push(row("傳輸大小", r.size));
    if (r.files) items.push(row("檔案數", r.files.replace(/^Files/, "").trim()));
    if (r.dirs) items.push(row("資料夾數", r.dirs.replace(/^Dirs/, "").trim()));
    if (r.speed) items.push(row("速度", r.speed.replace(/^Speed/, "").trim()));
    return items;
  }

  const currentResult = result
    ? resultSourceTask
      ? { ...result, message: `${result.message}（${resultSourceTask}）` }
      : result
    : null;

  // ---- 共用：備份設定（來源 / 目的地） ----
  function renderPathSetup() {
    return (
      <div className="block">
        <h2 className="block-title">備份設定</h2>
        <div className="path-row">
          <label className="path-label">來源</label>
          <div className="source-type-segment" role="group">
            <button
              className={!sourceIsFile ? "active" : ""}
              onClick={() => setSourceIsFile(false)}
              disabled={running}
              title="來源是整個資料夾"
            >
              資料夾
            </button>
            <button
              className={sourceIsFile ? "active" : ""}
              onClick={() => setSourceIsFile(true)}
              disabled={running}
              title="來源是單一檔案，複製到目的地資料夾"
            >
              單一檔案
            </button>
          </div>
          <div className="path-dropwrap" ref={sourceDropRef}>
            <input
              className="path-input"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder={
                sourceIsFile
                  ? "把檔案拖到這裡，或點瀏覽"
                  : "把資料夾拖到這裡，或點瀏覽"
              }
              disabled={running}
            />
          </div>
          <button
            className="btn"
            onClick={() => pickFolder("source", sourceIsFile)}
            disabled={running}
          >
            瀏覽…
          </button>
        </div>
        <div className="path-row">
          <label className="path-label">目的地</label>
          <div className="path-dropwrap" ref={destDropRef}>
            <input
              className="path-input"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="把資料夾拖到這裡，或點瀏覽"
              disabled={running}
            />
          </div>
          <button
            className="btn"
            onClick={() => pickFolder("destination")}
            disabled={running}
          >
            瀏覽…
          </button>
        </div>
      </div>
    );
  }

  // ---- 共用：執行（摘要 / 按鈕 / 進度 / 結果 / 日誌） ----
  function renderExecution() {
    return (
      <div className="block">
        <h2 className="block-title">執行</h2>
        {riskWarning.length > 0 && (
          <div className="risk-box">
            <span className="risk-icon">!</span>
            <div className="risk-list">
              {riskWarning.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          </div>
        )}
        <div className="summary-box">
          <span className="summary-text">{buildSummary()}</span>
        </div>

        <div className="action-row">
          {!running ? (
            <button
              className="btn btn-primary btn-lg"
              onClick={() => startBackup(source, destination, null)}
              disabled={!source || !destination}
            >
              {dryRun ? "開始模擬（Ctrl+Enter）" : "開始備份（Ctrl+Enter）"}
            </button>
          ) : (
            <button className="btn btn-danger btn-lg" onClick={cancelBackup}>
              取消
            </button>
          )}
          <div className="progress-wrap">
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="progress-text">
              {running ? `${runningName} · ` : ""}
              {percent}%
            </span>
          </div>
        </div>

        {currentResult && (
          <>
            <div className={`result-banner ${currentResult.success ? "ok" : "err"}`}>
              {currentResult.success ? "完成" : "失敗"} —{" "}
              {currentResult.message}
            </div>
            {currentResult.success && (
              <div className="result-stats">
                {formatResultDetail(currentResult)}
              </div>
            )}
          </>
        )}

        <div className="log-box" ref={logBoxRef}>
          {logs.length === 0 ? (
            <span className="log-empty">等待執行…</span>
          ) : (
            logs.map((g, gi) => (
              <div key={gi} className="log-group">
                {g.task && (
                  <div className="log-task-title">{g.task}</div>
                )}
                {g.lines.map((l, i) => (
                  <div key={i} className="log-line">{l}</div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  // ---- 共用：任務管理（我的任務列表 / 匯入匯出 / 儲存） ----
  function renderTaskPanel() {
    return (
      <div className="block">
        <h2 className="block-title">我的任務</h2>
        {tasks.length === 0 ? (
          <p className="tasks-empty">
            還沒有儲存的任務。設定好路徑、情境、排除後，在下方命名並儲存。
          </p>
        ) : (
          <div className="task-list">
            {tasks.map((t) => (
              <div key={t.id} className={`task-card ${selectedTaskIds.has(t.id) ? "selected" : ""}`}>
                <label
                  className="task-check"
                  onClick={(e) => e.preventDefault()}
                >
                  <input
                    type="checkbox"
                    checked={selectedTaskIds.has(t.id)}
                    onChange={() => toggleTaskSelect(t.id)}
                    disabled={running}
                  />
                </label>
                <div className="task-info" onClick={() => loadTask(t)}>
                  <div className="task-name">{t.name}</div>
                  <div className="task-meta">
                    {t.sourceIsFile && (
                      <span className="badge badge-file">檔案</span>
                    )}
                    {t.source} → {t.destination}
                  </div>
                </div>
                <span className={`badge badge-${t.presetId}`}>
                  {PRESETS.find((p) => p.id === t.presetId)?.label ?? ""}
                </span>
                <div className="task-actions">
                  <button
                    className="btn btn-small"
                    onClick={() => startBackup(t.source, t.destination, t)}
                    disabled={running}
                  >
                    ▶ 執行
                  </button>
                  <button
                    className="btn btn-small btn-danger"
                    onClick={() => deleteTask(t.id)}
                    disabled={running}
                  >
                    刪除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="task-batch-row">
          <button
            className="btn btn-primary"
            onClick={runSelectedTasks}
            disabled={running || selectedTaskIds.size === 0}
          >
            執行勾選的任務（{selectedTaskIds.size}）
          </button>
          <button className="btn" onClick={importTasks} disabled={running}>
            匯入
          </button>
          <button className="btn" onClick={exportTasks} disabled={running}>
            匯出
          </button>
        </div>
        <div className="task-save-row">
          <input
            className="task-input"
            value={taskInput}
            onChange={(e) => setTaskInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveTask();
            }}
            placeholder="輸入任務名稱，儲存目前設定（Ctrl+S）"
            disabled={running}
          />
          <button className="btn" onClick={saveTask} disabled={running}>
            儲存目前設定（Cmd/Ctrl+S）
          </button>
        </div>
      </div>
    );
  }

  return (
    <main className="app">
      <div className="app-body">
        {/* 左側導覽 */}
        <nav className="nav-rail">
          <div className="nav-brand">
            <svg
              className="nav-logo"
              viewBox="0 0 48 48"
              role="img"
              aria-label="RoboCopy Manager"
            >
              <defs>
                <linearGradient id="nav-logo-bg" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#4CC2FF" />
                  <stop offset="0.5" stopColor="#0F6CBD" />
                  <stop offset="1" stopColor="#6B2FBF" />
                </linearGradient>
                <linearGradient id="nav-logo-gloss" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.5" />
                  <stop offset="0.55" stopColor="#FFFFFF" stopOpacity="0.1" />
                  <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
                </linearGradient>
              </defs>
              <rect width="48" height="48" rx="12" fill="url(#nav-logo-bg)" />
              <rect width="48" height="26" rx="12" fill="url(#nav-logo-gloss)" />
              <g transform="translate(0 1.8)" opacity="0.35">
                <path
                  d="M13.5 18A10.5 10.5 0 0 1 34.5 18"
                  fill="none"
                  stroke="#00203F"
                  strokeWidth="5"
                  strokeLinecap="round"
                />
                <path
                  d="M34.5 30A10.5 10.5 0 0 1 13.5 30"
                  fill="none"
                  stroke="#00203F"
                  strokeWidth="5"
                  strokeLinecap="round"
                />
                <polygon points="29.5 19.5 39.5 19.5 34.5 27" fill="#00203F" />
                <polygon points="18.5 28.5 8.5 28.5 13.5 21" fill="#00203F" />
              </g>
              <path
                d="M13.5 18A10.5 10.5 0 0 1 34.5 18"
                fill="none"
                stroke="#FFFFFF"
                strokeWidth="5"
                strokeLinecap="round"
              />
              <path
                d="M34.5 30A10.5 10.5 0 0 1 13.5 30"
                fill="none"
                stroke="#FFFFFF"
                strokeWidth="5"
                strokeLinecap="round"
              />
              <polygon points="29.5 19.5 39.5 19.5 34.5 27" fill="#FFFFFF" />
              <polygon points="18.5 28.5 8.5 28.5 13.5 21" fill="#FFFFFF" />
            </svg>
            <div className="nav-appname">RoboCopy</div>
          </div>
          <button
            className={`nav-item ${activeNav === "quick" ? "active" : ""}`}
            onClick={() => setActiveNav("quick")}
            title="快速執行"
          >
            <span className="nav-item-icon">⚡</span>
            <span className="nav-item-text">快速執行</span>
          </button>
          <button
            className={`nav-item ${activeNav === "run" ? "active" : ""}`}
            onClick={() => setActiveNav("run")}
            title="任務执行"
          >
            <span className="nav-item-icon">▤</span>
            <span className="nav-item-text">任務执行</span>
          </button>
          <button
            className={`nav-item ${activeNav === "history" ? "active" : ""}`}
            onClick={() => setActiveNav("history")}
            title="歷程"
          >
            <span className="nav-item-icon">◷</span>
            <span className="nav-item-text">歷程</span>
          </button>
          <button
            className={`nav-item ${activeNav === "settings" ? "active" : ""}`}
            onClick={() => setActiveNav("settings")}
            title="設定"
          >
            <span className="nav-item-icon">⚙</span>
            <span className="nav-item-text">設定</span>
          </button>
        </nav>

        {/* 主內容 */}
        <div className="content">
          <header className="app-header">
            <div className="header-title-block">
              <h1>RoboCopy Manager</h1>
              <span className="subtitle">Windows 備份工具</span>
            </div>
            {/* 主題切換 */}
            <div className="theme-segment" role="group">
              {(["light", "system", "dark"] as ThemeMode[]).map((mode) => (
                <button
                  key={mode}
                  className={`segment-btn ${themeMode === mode ? "active" : ""}`}
                  onClick={() => setTheme(mode)}
                  title={
                    mode === "light"
                      ? "淺色"
                      : mode === "dark"
                      ? "深色"
                      : "跟隨系統"
                  }
                >
                  {mode === "light" ? "☀" : mode === "dark" ? "☾" : "⛭"}
                </button>
              ))}
            </div>
          </header>

          {/* ===== 快速執行檢視 ===== */}
          {activeNav === "quick" && (
            <section className="view">
              {renderPathSetup()}
              {renderExecution()}
            </section>
          )}

          {/* ===== 任務执行檢視 ===== */}
          {activeNav === "run" && (
            <section className="view">
              {renderTaskPanel()}
              {renderPathSetup()}

              {/* 情境 */}
              <div className="block">
                <h2 className="block-title">選擇情境</h2>
                <div className="preset-segment">
                  {PRESETS.map((p) => (
                    <button
                      key={p.id}
                      className={`segment-card ${activePreset === p.id ? "active" : ""}`}
                      onClick={() => applyPreset(p.id)}
                      disabled={running}
                    >
                      <span className="segment-card-label">{p.label}</span>
                      <span className="segment-card-desc">{p.description}</span>
                    </button>
                  ))}
                </div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={dryRun}
                    onChange={(e) => setDryRun(e.target.checked)}
                    disabled={running}
                  />
                  模擬模式（只預覽，不真的執行）
                </label>
              </div>

              {/* 進階參數 */}
              <div className="block">
                <button
                  className="collapsible-header"
                  onClick={() => setAdvancedOpen(!advancedOpen)}
                >
                  <span>{advancedOpen ? "▾" : "▸"}</span> 進階參數
                </button>
                {advancedOpen && (
                  <div className="advanced-grid">
                    {ADVANCED_OPTIONS.map((opt) => (
                      <label
                        key={opt.id}
                        className="advanced-item"
                        title={opt.description}
                      >
                        <input
                          type="checkbox"
                          checked={checkedFlags[opt.id] ?? false}
                          onChange={(e) =>
                            setCheckedFlags({
                              ...checkedFlags,
                              [opt.id]: e.target.checked,
                            })
                          }
                          disabled={running}
                        />
                        <div>
                          <div className="advanced-label">{opt.label}</div>
                          <div className="advanced-desc">{opt.description}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* 排除清單 */}
              <div className="block">
                <h2 className="block-title">排除清單</h2>
                <div className="template-row">
                  {EXCLUDE_TEMPLATES.map((t) => (
                    <button
                      key={t.id}
                      className="template-btn"
                      onClick={() => applyExcludeTemplate(t.id)}
                      disabled={running}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <div
                  className={`drop-zone ${dragOver ? "over" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                >
                  把要排除的檔案/資料夾拖到這裡（會自動取檔名）
                </div>
                <div className="chip-row">
                  {excludes.map((ex, i) => (
                    <span key={`${ex.type}-${ex.value}-${i}`} className={`chip ${ex.type}`}>
                      {ex.type === "dir" ? "▤" : "📄"} {ex.value}
                      <button
                        className="chip-remove"
                        onClick={() => removeExclude(i)}
                        disabled={running}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    className="chip-input"
                    value={excludeInput}
                    onChange={(e) => setExcludeInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addExcludeFromInput();
                    }}
                    placeholder="輸入後按 Enter（路徑結尾 / 視為資料夾）"
                    disabled={running}
                  />
                </div>
              </div>

              {renderExecution()}
            </section>
          )}

          {/* ===== 歷程檢視 ===== */}
          {activeNav === "history" && (
            <section className="view">
              <div className="block">
                <div className="block-head">
                  <h2 className="block-title">執行歷程</h2>
                  {history.length > 0 && (
                    <button className="btn btn-small btn-danger" onClick={() => setHistory([])}>
                      清除歷程
                    </button>
                  )}
                </div>
                {history.length === 0 ? (
                  <p className="tasks-empty">
                    還沒有任何執行紀錄。完成一次備份後，結果會自動記錄在這裡（最多保留 {HISTORY_LIMIT} 筆）。
                  </p>
                ) : (
                  <div className="task-list">
                    {history.map((h) => (
                      <div key={h.id} className="history-card">
                        <div className="history-head">
                          <span className="history-time">{formatHistoryTime(h.time)}</span>
                          <span className="history-name">{h.taskName}</span>
                          <span
                            className={`badge ${h.success ? "badge-add-only" : "badge-dry-run"}`}
                          >
                            {h.success ? "成功" : "失敗"}
                          </span>
                        </div>
                        <div className="history-meta">
                          {h.source} → {h.destination}
                        </div>
                        {!h.success && h.message && (
                          <div className="history-msg">{h.message}</div>
                        )}
                        <div className="result-stats">
                          <div className="result-stat">
                            <span className="result-stat-label">檔案數</span>
                            <span className="result-stat-value">
                              {cleanStat(h.files, "Files") || "—"}
                            </span>
                          </div>
                          <div className="result-stat">
                            <span className="result-stat-label">傳輸大小</span>
                            <span className="result-stat-value">
                              {cleanStat(h.size, "Bytes") || "—"}
                            </span>
                          </div>
                          <div className="result-stat">
                            <span className="result-stat-label">用時</span>
                            <span className="result-stat-value">
                              {cleanStat(h.elapsed, "Times") || "—"}
                            </span>
                          </div>
                          <div className="result-stat">
                            <span className="result-stat-label">速度</span>
                            <span className="result-stat-value">
                              {cleanStat(h.speed, "Speed") || "—"}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ===== 設定檢視 ===== */}
          {activeNav === "settings" && (
            <section className="view">
              <div className="block">
                <h2 className="block-title">外觀</h2>
                <div className="preset-segment">
                  {(
                    [
                      { id: "light", label: "淺色", desc: "一律使用淺色主題" },
                      { id: "system", label: "跟隨系統", desc: "自動配合 Windows 深淺色" },
                      { id: "dark", label: "深色", desc: "一律使用深色主題" },
                    ] as { id: ThemeMode; label: string; desc: string }[]
                  ).map((m) => (
                    <button
                      key={m.id}
                      className={`segment-card ${themeMode === m.id ? "active" : ""}`}
                      onClick={() => setTheme(m.id)}
                    >
                      <span className="segment-card-label">{m.label}</span>
                      <span className="segment-card-desc">{m.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="block">
                <h2 className="block-title">強調色</h2>
                <div className="accent-row">
                  <span className="accent-swatch" style={{ background: accent }} />
                  <div>
                    <div className="accent-hex">{accent}</div>
                    <div className="accent-note">自動偵測 Windows 系統強調色，更換系統佈景主題後重新啟動即可套用</div>
                  </div>
                </div>
              </div>

              <div className="block">
                <h2 className="block-title">通知</h2>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.notifyOnFinish}
                    onChange={(e) =>
                      updateSettings({ notifyOnFinish: e.target.checked })
                    }
                  />
                  備份完成時顯示系統通知（來源/目的地、用時、傳輸大小、檔案數）
                </label>
              </div>

              <div className="block">
                <h2 className="block-title">系統匣右鍵菜單</h2>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.trayVisible}
                    onChange={(e) =>
                      updateSettings({ trayVisible: e.target.checked })
                    }
                  />
                  顯示系統匣圖示與右鍵菜單（開啟主視窗、快速選擇來源/目的地、執行任務、結束）
                </label>
              </div>

              <div className="block">
                <h2 className="block-title">檔案總管右鍵選單</h2>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.explorerContext}
                    onChange={(e) =>
                      updateSettings({ explorerContext: e.target.checked })
                    }
                  />
                  在檔案/資料夾上按右鍵，顯示「複製到 RoboCopy Manager」並自動填入來源
                </label>
              </div>

              <div className="block">
                <h2 className="block-title">快捷鍵</h2>
                <div className="shortcut-list">
                  <div className="shortcut-row">
                    <span>執行備份 / 模擬</span>
                    <kbd>Ctrl + Enter</kbd>
                  </div>
                  <div className="shortcut-row">
                    <span>儲存目前設定為任務</span>
                    <kbd>Ctrl + S</kbd>
                  </div>
                  <div className="shortcut-row">
                    <span>匯出任務</span>
                    <kbd>Ctrl + Shift + E</kbd>
                  </div>
                  <div className="shortcut-row">
                    <span>匯入任務</span>
                    <kbd>Ctrl + Shift + I</kbd>
                  </div>
                </div>
              </div>
            </section>
          )}

          <footer className="app-footer">
            快捷鍵：Ctrl+Enter 執行 ・Ctrl+S 儲存 ・Ctrl+Shift+E 匯出 ・Ctrl+Shift+I 匯入
          </footer>
        </div>
      </div>
    </main>
  );
}

/** 讓顏色變亮 */
function lightenColor(hex: string, amt: number): string {
  return adjust(hex, (c) => Math.round(c + (255 - c) * amt));
}
/** 讓顏色變暗 */
function darkenColor(hex: string, amt: number): string {
  return adjust(hex, (c) => Math.round(c * (1 - amt)));
}
function adjust(hex: string, fn: (c: number) => number): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = fn((n >> 16) & 0xff);
  const g = fn((n >> 8) & 0xff);
  const b = fn(n & 0xff);
  const cl = (v: number) => Math.max(0, Math.min(255, v));
  return `#${((cl(r) << 16) | (cl(g) << 8) | cl(b)).toString(16).padStart(6, "0").toUpperCase()}`;
}

export default App;