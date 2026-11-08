// 本机工具路径：~/.config/agent-hub/config.json 里的 node / tmux / codex / devin / agy。
// 安装时用 detectTool 自动找（PATH、/Applications 里的 app 包、常见安装目录），找不到就留空；
// 代码里要用某个工具时调 toolPath(名字, 环境变量名)：环境变量 > config.json > 现场再找一遍 > 裸命令名（交给 PATH）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TOOLS = ["node", "tmux", "codex", "devin", "agy", "claude"];

const homeDir = (home) => home || process.env.HOME || os.homedir();
export const configPath = (home) => path.join(homeDir(home), ".config", "agent-hub", "config.json");

export function readConfig(home) {
  try { return JSON.parse(fs.readFileSync(configPath(home), "utf8")); } catch { return {}; }
}

const isExe = (p) => { try { return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true); } catch { return false; } };

function onPath(name, home) {
  const dirs = (process.env.PATH || "").split(":").filter(Boolean);
  dirs.push(path.join(homeDir(home), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin");
  for (const d of dirs) { const p = path.join(d, name); if (isExe(p)) return p; }
  return "";
}

function misePaths(tool, home) {
  const root = path.join(homeDir(home), ".local", "share", "mise", "installs", tool);
  let vers = [];
  try { vers = fs.readdirSync(root).filter((v) => /^\d/.test(v)).sort().reverse(); } catch { /* 没装 mise */ }
  return [...vers.map((v) => path.join(root, v, "tmux")), path.join(homeDir(home), ".local", "share", "mise", "shims", tool)];
}

// 各工具除了 PATH 以外还要找哪些地方（app 包里自带的命令行）
const EXTRA = {
  tmux: (home) => misePaths("tmux", home),
  codex: (home) => [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    path.join(homeDir(home), "Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"),
    "/Applications/Codex.app/Contents/Resources/codex",
  ],
  devin: (home) => [
    "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin",
    path.join(homeDir(home), "Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin"),
  ],
  agy: () => [],
  node: () => [process.execPath],
};

export function detectTool(name, home) {
  if (name === "node" && isExe(process.execPath)) return process.execPath;
  const hit = onPath(name, home);
  if (hit) return hit;
  for (const p of (EXTRA[name]?.(home) ?? [])) if (isExe(p)) return p;
  return "";
}

const cache = new Map();
export function toolPath(name, envVar, home) {
  const env = envVar && process.env[envVar];
  if (env) return env;
  if (cache.has(name)) return cache.get(name);
  const cfg = readConfig(home)[name];
  const found = (cfg && isExe(cfg) ? cfg : "") || detectTool(name, home) || name;
  cache.set(name, found);
  return found;
}

export { isExe };
