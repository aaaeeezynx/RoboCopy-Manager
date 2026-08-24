// 將 assets/logo.svg 渲染為 1024x1024 PNG（作為 tauri icon 來源）
// 前置需求：npm i --no-save sharp
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

await sharp(path.join(root, "assets", "logo.svg"))
  .png()
  .toFile(path.join(root, "assets", "logo-1024.png"));

console.log("已產出 assets/logo-1024.png");
