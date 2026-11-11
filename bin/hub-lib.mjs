// Windows shared paths, role registry, inbox and running-worker records.
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

export { HOME } from "../home.mjs";
import { HOME } from "../home.mjs";
import { withInboxLock } from "../inbox-lock.mjs";
export const BIN_DIR = dirname(fileURLToPath(import.meta.url));
export const DIR = process.env.HUB_DIR ?? join(HOME, "agy-logs");
export const INBOX = join(DIR, "inbox.jsonl");
export const RUNNING = join(DIR, "running");
export const ROLES = process.env.HUB_ROLES ?? join(HOME, ".config", "agy-team", "roles.json");
export const JOBS = process.env.HUB_JOBS ?? join(HOME, ".local", "share", "agent-hub", "jobs");
export const MASTER = "主控";

export const roles = () => { try { return JSON.parse(readFileSync(ROLES, "utf8").replace(/^\uFEFF/, "")); } catch { return {}; } };

export const now = () => {
  const d = new Date(), p = (x) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const stamp = () => {
  const d = new Date(), p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export function appendMsg(from, to, type, text, extra = {}) {
  mkdirSync(DIR, { recursive: true });
  const msg = { id: randomBytes(4).toString("hex"), time: now(), from, to, type, ...extra, text: String(text).slice(0, 4000) };
  withInboxLock(DIR, () => appendFileSync(INBOX, JSON.stringify(msg) + "\n"));
  return msg;
}

const runFile = (role) => join(RUNNING, `${encodeURIComponent(role)}.json`);
export function getRun(role) { try { return JSON.parse(readFileSync(runFile(role), "utf8")); } catch { return null; } }
export function setRun(role, info) { mkdirSync(RUNNING, { recursive: true }); writeFileSync(runFile(role), JSON.stringify(info)); }
export function clearRun(role, pid) {
  const r = getRun(role);
  if (r && (pid === undefined || r.pid === pid)) { try { unlinkSync(runFile(role)); } catch { /* 已删 */ } }
}

export function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// 员工正在跑：有记录且进程还活着；记录在但进程没了就清掉
export function busy(role) {
  const r = getRun(role);
  if (!r) return null;
  if (alive(r.pid)) return r;
  clearRun(role, r.pid);
  return null;
}

// 读日志：Kiro 日志是 UTF-16LE，Codex 是 UTF-8；看前两个字节判断
export function readText(file, maxBytes = 200_000) {
  if (!existsSync(file)) return "";
  let b = readFileSync(file);
  if (b.length > maxBytes) b = b.subarray(b.length - maxBytes);
  const utf16 = (b[0] === 0xff && b[1] === 0xfe) || (b.length > 4 && b[1] === 0 && b[3] === 0) || (b.length > 4 && b[0] === 0 && b[2] === 0);
  let s = utf16 ? b.toString("utf16le") : b.toString("utf8");
  return s.replace(/^\uFEFF/, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}
export function lastLines(file, n = 3) {
  return readText(file).split("\n").map((l) => l.trim()).filter(Boolean).slice(-n).join(" / ");
}

export function latestJob(role) {
  if (!existsSync(JOBS)) return null;
  const ds = readdirSync(JOBS).filter((d) => d.startsWith(`${role}-`) && !d.endsWith("-home")).sort();
  return ds.length ? join(JOBS, ds[ds.length - 1]) : null;
}
export const ago = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
};
export const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
