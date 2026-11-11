// 像 tmux 一样盯一个员工：node watch-worker.mjs worker1
// 自动跟最新任务目录的 run.log，把 Cursor stream-json 翻成人话；换单自动跟新单
import { readdirSync, statSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getRun, alive, JOBS } from "./hub-lib.mjs";

const role = process.argv[2];
if (!role) { console.log("用法：node watch-worker.mjs worker1"); process.exit(1); }
const C = { dim: "\x1b[90m", b: "\x1b[1m", blue: "\x1b[36m", green: "\x1b[32m", yel: "\x1b[33m", red: "\x1b[31m", x: "\x1b[0m" };
const SECRET_RE = /(sk\x2d[A-Za-z0-9_-]{8,}|ghp\x5f[A-Za-z0-9]{10,}|(?:secret|token|password|api[_-]?key)["'=: ]+[^\s"']{6,})/gi;
const clean = (s) => String(s ?? "").replace(SECRET_RE, "***");
const t = () => new Date().toTimeString().slice(0, 8);
const cut = (s, n = 220) => { s = clean(s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };

function curDir() {
  const r = getRun(role); if (r && alive(r.pid)) return { dir: r.dir, busy: true };
  try { const ds = readdirSync(JOBS).filter((d) => d.startsWith(role + "-")).sort(); return ds.length ? { dir: join(JOBS, ds[ds.length - 1]), busy: false } : null; } catch { return null; }
}

function show(line) {
  let j; try { j = JSON.parse(line); } catch { if (line.trim() && !/^Connection lost|^Retry attempt/.test(line)) console.log(C.dim + t() + " " + C.x + cut(line, 400)); return; }
  if (j.type === "system") console.log(`${C.dim}${t()}${C.x} ${C.b}开工${C.x} ${j.model || ""}`);
  else if (j.type === "tool_call" && j.subtype === "started") {
    const k = Object.keys(j.tool_call || {})[0] || "tool"; const a = (j.tool_call[k] || {}).args || {};
    const name = k.replace(/ToolCall$/, "");
    const what = a.command || a.path || a.filePath || a.targetFile || a.globPattern || a.pattern || a.query || a.url || JSON.stringify(a);
    const color = /shell|bash|terminal/i.test(name) ? C.yel : /edit|write|replace|delete/i.test(name) ? C.red : C.blue;
    console.log(`${C.dim}${t()}${C.x} ${color}${name}${C.x} ${cut(what)}`);
  } else if (j.type === "tool_call" && j.subtype === "completed") {
    const k = Object.keys(j.tool_call || {})[0] || ""; const res = (j.tool_call[k] || {}).result || {};
    if (res.error || res.failure) console.log(`${C.dim}${t()}${C.x} ${C.red}  ✗ ${cut(JSON.stringify(res.error || res.failure), 160)}${C.x}`);
  } else if (j.type === "assistant") {
    const txt = (j.message?.content || []).map((c) => c.text || "").join("").trim(); if (txt) console.log(`${C.dim}${t()}${C.x} ${C.green}说${C.x} ${cut(txt, 500)}`);
  } else if (j.type === "result") console.log(`${C.dim}${t()}${C.x} ${C.b}${C.green}交卷${C.x} ${cut(j.result, 800)}`);
}

let dir = null, pos = 0, buf = "";
console.log(`${C.b}盯 ${role}${C.x}（Ctrl+C 退出）`);
setInterval(() => {
  const cd = curDir(); if (!cd) return;
  if (cd.dir !== dir) {
    dir = cd.dir; pos = 0; buf = "";
    console.log(`\n${C.b}── ${role} ${cd.busy ? "在忙" : "空闲（最近一单）"} · ${dir}${C.x}`);
  }
  const log = join(dir, "run.log"); if (!existsSync(log)) return;
  const size = statSync(log).size; if (size < pos) pos = 0; if (size === pos) return;
  // 第一次打开只回放最后 60KB
  if (pos === 0 && size > 60000) pos = size - 60000;
  const fd = openSync(log, "r"); const b = Buffer.alloc(size - pos); readSync(fd, b, 0, b.length, pos); closeSync(fd); pos = size;
  buf += b.toString("utf8"); const lines = buf.split(/\r?\n/); buf = lines.pop();
  for (const l of lines) show(l);
}, 1500);
