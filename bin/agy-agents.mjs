// 看团队（Windows 版）：hub 员工谁在忙 / 空闲，外加本机所有不经 hub 在跑的 Codex / Kiro 任务
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { roles, busy, latestJob, lastLines, ago, mtime, DIR } from "./hub-lib.mjs";
import { readFileSync } from "node:fs";
import { teamState } from "../team-state.mjs";
import { redact } from "../windows-state.mjs";

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
function newestLog(dir) {
  if (!dir || !existsSync(dir)) return "";
  const logs = readdirSync(dir).filter((f) => /\.log$/i.test(f)).map((f) => join(dir, f)).sort((a, b) => mtime(b) - mtime(a));
  return logs[0] || "";
}
function lastLine(dir) {
  const f = newestLog(dir);
  if (!f) return "";
  const s = lastLines(f, 1);
  return `${cut(s, 110)}（${ago(Date.now() - mtime(f))}前有动静）`;
}

const shared = teamState();
const statusBy = new Map(shared.all.map(a=>[a.name,a]));
const out = [shared.summary];
const R = roles();
out.push("== hub 员工 ==");
const mine = new Set();
const off = {};
const order = Object.entries(R).sort(([a],[b]) => { const k = (x) => (x.startsWith("cx") ? 0 : x.startsWith("kr") || x.startsWith("kv") ? 1 : 2); return k(a) - k(b) || a.localeCompare(b, "en", { numeric: true }); });
for (const [id, r] of order) {
  if (r.disabled) { const key = r.disabledReason || "停用"; (off[key] ||= []).push(id); continue; }
  const status=statusBy.get(id);
  if(status?.group==='quota'){out.push(`[没额度] ${id}  ${status.tool}  ${status.reason}`);continue;}
  if(status?.group==='attention'){const active=busy(id);if(active)mine.add(active.dir.toLowerCase());out.push(`[要处理] ${id}  ${status.tool}  ${status.doing}`);continue;}
  if (r.kind === "codex-app" || r.kind === "desktop") {
    let p = {};
    try { p = JSON.parse(readFileSync(join(DIR, "presence", `${encodeURIComponent(id)}.json`), "utf8")); } catch { /* 没上过线 */ }
    const fresh = p.beat && Date.now() - p.beat < 60_000;
    const label = r.kind === "codex-app" ? "Codex 客户端" : "反重力桌面";
    if (p.state === "waiting" && fresh) out.push(`[等活] ${id}  ${label}  挂着等活（派了马上开工）`);
    else if (p.state === "working") out.push(`[在忙] ${id}  ${label}  干了 ${ago(Date.now() - (p.since || Date.now()))}  ${p.task || ""}`);
    else if (p.state === "idle" && p.beat && Date.now() - p.beat < 600_000) out.push(`[空闲] ${id}  ${label}  刚交完一单，还没回去挂着等活`);
    else out.push(`[离线] ${id}  ${label}  没挂着等活${p.beat ? `（上次 ${ago(Date.now() - p.beat)}前）` : "（还没上过线）"}`);
    continue;
  }
  const who = r.kind === "cursor" ? `Cursor ${r.model || "claude-opus-5-5-high-fast"}` : r.kind === "codex" ? `Codex ${r.model || "gpt-6.1-sol"}·${r.effort || "high"}` : r.kind === "kiro" ? `Kiro ${r.agent || "default"}` : r.kind === "claude-ds" ? `Claude DS ${r.model || "deepseek-flash"}` : r.kind;
  const b = busy(id);
  if (b) {
    mine.add(b.dir.toLowerCase());
    out.push(`[在忙] ${id}  ${who}  跑了 ${ago(Date.now() - b.start)}  ${b.task}`);
    out.push(`       目录 ${b.dir}`);
    const l = lastLine(b.dir);
    if (l) out.push(`       最近：${l}`);
  } else {
    const j = latestJob(id);
    out.push(`[空闲] ${id}  ${who}${j ? `  上一单 ${basename(j)}` : ""}`);
  }
}

// hub 外面在跑的：按命令行里的任务目录归并
let procs = [];
try {
  const ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -match 'codex(\\.cmd|\\.exe|\\.js)?\"?\\s+exec' -or $_.CommandLine -match 'kiro-launch\\.ps1|hub-kiro\\.ps1|run\\d*\\.cmd') } | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress";
  const txt = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", windowsHide: true, maxBuffer: 20 << 20 });
  const j = txt.trim() ? JSON.parse(txt) : [];
  procs = Array.isArray(j) ? j : [j];
} catch (e) { out.push(`（查本机进程失败：${e.message.split("\n")[0]}）`); }

const ext = new Map();
for (const p of procs) {
  const c = p.CommandLine || "";
  let dir = c.match(/\s-C\s+"([^"]+)"/)?.[1] || c.match(/\s-C\s+(\S+)/)?.[1]
    || c.match(/-Dir\s+['"]?([^'"\s]+)/)?.[1]
    || c.match(/([A-Za-z]:\\[^"\s]+)\\run\d*\.cmd/i)?.[1];
  if (!dir) continue;
  if (mine.has(dir.toLowerCase())) continue;
  const kind = /kiro/i.test(c) ? "Kiro" : "Codex";
  const t = Number(String(p.CreationDate).match(/\d+/)?.[0]) || Date.now();
  const k = dir.toLowerCase();
  const o = ext.get(k);
  if (!o || t < o.t) ext.set(k, { dir, kind, t, pid: p.ProcessId });
}
out.push("");
out.push(`== hub 外面在跑的（${ext.size} 个）==`);
for (const e of [...ext.values()].sort((a, b) => a.t - b.t)) {
  out.push(`[${e.kind}] ${basename(e.dir)}  跑了 ${ago(Date.now() - e.t)}  PID ${e.pid}`);
  const l = lastLine(e.dir);
  if (l) out.push(`       最近：${l}`);
}
if (Object.keys(off).length) { out.push("== 停用（派不了，恢复见原因）=="); for (const [why, ids] of Object.entries(off)) out.push(`[停用] ${ids.join('、')}（${ids.length} 个）  ${why}`); }
console.log(redact(out.join("\n")));
