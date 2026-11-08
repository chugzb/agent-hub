#!/usr/bin/env node
// 员工看板：本机网页，只读，只监听 127.0.0.1。实时显示每个员工在干活 / 空闲 / 疑似卡住、在做什么、做了多久，以及员工之间的消息。
// 数据：~/.claude/sessions/*.json + 对话记录（Claude Code 会话）、反重力桌面端本机接口、Codex 适配器的 presence、~/agy-logs/inbox.jsonl。
// 界面思路借鉴 abtop-web-ui（卡片 + 状态点 + 时长）、agent-orchestrator（「需要你处理」置顶）、herdr（卡住判断从严）、repowire（消息时间线）。
// 用法：node board.mjs [端口，默认 4646]
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  call as deskCall, inspect as deskInspect, isQuotaError, modelConfigs, poolOf, familyName, clockText,
} from "./desk.mjs";
import { nextReset } from "./health.mjs";
import { demoPage, demoSnapshot } from "./demo-data.mjs";

const PORT = Number(process.argv[2] || process.env.BOARD_PORT || 4646);
const HOME = os.homedir();
const SESS = path.join(HOME, ".claude", "sessions");
const PROJ = path.join(HOME, ".claude", "projects");
const ROLES = path.join(HOME, ".config", "agy-team", "roles.json");
const INBOX = path.join(HOME, "agy-logs", "inbox.jsonl");
const PRES = path.join(HOME, "agy-logs", "presence");
const STUCK_MIN = 15; // 干活状态下这么久没有任何新动作，标「疑似卡住」
const DEMO = process.env.BOARD_DEMO === "1"; // 演示模式：只用 demo-data.mjs 里的假员工、假消息，不读本机数据（README 截图用）

const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const clip = (s, n = 140) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };

// 本机哪些 pid 是 peer-bridge（它们登记的是反重力 / Codex 员工，不当 Claude 会话显示）
function bridgePids() {
  try {
    const ps = execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" });
    const m = new Map();
    for (const l of ps.split("\n")) { const x = /^\s*(\d+)\s+.*peer-bridge\.mjs\s+(\S+)/.exec(l); if (x) m.set(Number(x[1]), x[2]); }
    return m;
  } catch { return new Map(); }
}

// Claude Code 对话记录的最后几步：最近一次说了什么、调了什么工具
function lastActivity(cwd, sessionId) {
  const file = path.join(PROJ, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
  let st; try { st = fs.statSync(file); } catch { return null; }
  const fd = fs.openSync(file, "r"); const len = Math.min(st.size, 120_000); const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd);
  const lines = b.toString("utf8").split("\n").slice(1).reverse();
  let tool = null, text = null, at = null, err = null;
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    // 接口报错（DeepSeek 官方接口余额不足是 402 / insufficient balance）：记录最近一条，给「额度用完」用
    if (!err && e.isApiErrorMessage) {
      const t = (Array.isArray(e.message?.content) ? e.message.content : []).find((c) => c.type === "text" && c.text?.trim());
      if (t) err = t.text;
    }
    if (e.type !== "assistant") continue;
    at ??= e.timestamp;
    for (const c of (Array.isArray(e.message?.content) ? e.message.content : []).slice().reverse()) {
      if (!tool && c.type === "tool_use") {
        const i = c.input || {};
        tool = `${c.name}${i.description ? "：" + i.description : i.file_path ? "：" + path.basename(i.file_path) : i.to ? " → " + i.to : i.pattern ? "：" + i.pattern : ""}`;
      }
      if (!text && c.type === "text" && c.text?.trim()) text = c.text;
    }
    if (tool && text) break;
  }
  return { tool: tool && clip(tool, 90), text: text && clip(text, 160), err: err && clip(err, 300), at, mtime: st.mtimeMs };
}

// 通道地址 → 会话名，显示「SendMessage → 3d」而不是一串 socket 路径
function sockNames() {
  const m = new Map();
  try { for (const f of fs.readdirSync(SESS)) { if (!f.endsWith(".json")) continue; const d = readJson(path.join(SESS, f)); if (d?.messagingSocketPath && d.name) m.set(d.messagingSocketPath, d.name); } } catch {}
  return m;
}
const named = (s, names) => s && s.replace(/uds:(\S+?\.sock)/g, (x, p) => names.get(p) || x);

function claudeAgents(bridges) {
  const out = []; const names = sockNames();
  let files = []; try { files = fs.readdirSync(SESS).filter((f) => f.endsWith(".json")); } catch {}
  for (const f of files) {
    const d = readJson(path.join(SESS, f)); if (!d?.pid || !alive(d.pid) || bridges.has(d.pid)) continue;
    const act = d.sessionId && d.cwd ? lastActivity(d.cwd, d.sessionId) : null;
    const busy = d.status === "busy";
    const lastMove = Math.max(act?.mtime ?? 0, d.statusUpdatedAt ?? 0);
    out.push({
      name: d.name || `pid ${d.pid}`,
      avatar: (d.tmux && /^ds/.test(d.tmux)) || /^3[df]$/.test(d.name || "") ? "deepseek" : "claude",
      kind: (d.tmux && /^ds/.test(d.tmux)) || /^3[df]$/.test(d.name || "") ? "DeepSeek · 终端" : d.tmux ? "Claude Code · 终端" : d.entrypoint === "claude-vscode" ? "Claude Code · VS Code" : "Claude Code",
      state: busy ? (Date.now() - lastMove > STUCK_MIN * 60_000 ? "stuck" : "working") : "idle",
      since: d.statusUpdatedAt, lastMove, where: d.cwd?.replace(HOME, "~"), tmux: d.tmux,
      doing: named(act?.tool, names), said: named(act?.text, names),
    });
  }
  return out;
}

// 每个员工最近收到的一条活（派活 / 消息），给反重力员工的气泡用：桌面端只给得出对话标题，看不出手上在干嘛
function lastTaskFor() {
  const m = new Map();
  for (const { text: l } of inboxTail(400)) {
    let d; try { d = JSON.parse(l); } catch { continue; }
    if (d.to && d.text && d.from !== d.to && d.from !== "系统") m.set(d.to, { from: d.from, text: d.text });
  }
  return m;
}

// ---------- 收件箱只读尾部 ----------
// inbox.jsonl 只会越来越大。记住每一行的起点（行号 → 字节位置）：文件变长只扫新加的那一截，变短或换了文件（归档）才从头扫；
// 取最近 N 行只读最后那一段字节，不再每 3 秒把整个文件读进来。行号从 1 开始，跟 server.mjs 游标的行号是同一个意思。
const inbox = { ino: 0, size: 0, starts: [], pending: 0 };
function inboxIndex() {
  let st; try { st = fs.statSync(INBOX); } catch { Object.assign(inbox, { ino: 0, size: 0, starts: [], pending: 0 }); return inbox; }
  if (st.ino !== inbox.ino || st.size < inbox.size) Object.assign(inbox, { ino: st.ino, size: 0, starts: [], pending: 0 });
  if (st.size > inbox.size) {
    const fd = fs.openSync(INBOX, "r"); const buf = Buffer.alloc(256 * 1024);
    try {
      let pos = inbox.size;
      while (pos < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - pos), pos);
        if (!n) break;
        for (let i = 0; i < n; i++) {
          const o = pos + i;
          if (o === inbox.pending) { inbox.starts.push(o); inbox.pending = -1; }
          if (buf[i] === 10) inbox.pending = o + 1;
        }
        pos += n;
      }
      inbox.size = pos;
    } finally { fs.closeSync(fd); }
  }
  return inbox;
}
/** 第 [from, to) 行（行号从 1 开始）的原文 */
function inboxLines(from, to) {
  const ix = inboxIndex(); const total = ix.starts.length;
  from = Math.max(1, from); to = Math.min(total + 1, to);
  if (from >= to) return [];
  const a = ix.starts[from - 1], b = to <= total ? ix.starts[to - 1] : ix.size;
  const buf = Buffer.alloc(b - a); const fd = fs.openSync(INBOX, "r");
  try { fs.readSync(fd, buf, 0, b - a, a); } finally { fs.closeSync(fd); }
  return buf.toString("utf8").split("\n").slice(0, to - from).map((text, i) => ({ line: from + i, text }));
}
const inboxTail = (n, before = Infinity) => { const total = inboxIndex().starts.length; const end = Math.min(before, total + 1); return inboxLines(end - n, end); };
/** 消息的完整时间：收件箱里有 at / ts 就用；没有就拿「11-08 03:16」按今年补（补出来在明天以后，说明是去年的） */
function fullTime(m) {
  for (const k of ["at", "ts", "timestamp"]) {
    const v = m[k];
    if (typeof v === "number" && v > 0) return v < 1e12 ? v * 1000 : v;
    if (typeof v === "string" && Date.parse(v)) return Date.parse(v);
  }
  const x = /^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(String(m.time || ""));
  if (!x) return 0;
  const now = new Date(); const d = new Date(now.getFullYear(), x[1] - 1, +x[2], +x[3], +x[4]);
  if (d - now > 86400_000) d.setFullYear(d.getFullYear() - 1);
  return d.getTime();
}

// 反重力对话因为报错停下（额度用完、模型报错、撑爆等）：摘要里只有「是报错停的」，报错原文要拉整段对话才有，
// 所以只在出错时拉，而且按「对话 + 最后修改时间」缓存，同一次报错只拉一遍
const ERR_REASON = "EXECUTOR_TERMINATION_REASON_ERROR";
const errCache = new Map();
async function lastError(id, mod) {
  const c = errCache.get(id); if (c && c.mod === mod) return c.text;
  let text = "对话报错停下了";
  try {
    const steps = (await deskCall("GetCascadeTrajectory", { cascadeId: id })).data.trajectory?.steps ?? [];
    const e = [...steps].reverse().find((x) => x.type === "CORTEX_STEP_TYPE_ERROR_MESSAGE")?.errorMessage?.error;
    if (e) text = clip(e.shortError || e.modelErrorMessage || e.userErrorMessage || text, 160);
  } catch {}
  errCache.set(id, { mod, text });
  return text;
}

async function employeeAgents() {
  const roles = readJson(ROLES, {}); const out = []; const tasks = lastTaskFor();
  let traj = {};
  if (Object.values(roles).some((r) => r.kind === "desktop")) {
    try { traj = (await deskCall("GetAllCascadeTrajectories", {})).data.trajectorySummaries ?? {}; } catch (e) { traj = { _err: e.message }; }
  }
  // 反重力员工以员工表为准：没登记进 roles.json 的反重力对话（含员工换下来的 old_desktop_id / old_desktop_ids 旧对话、测试对话）一律不显示
  for (const [name, r] of Object.entries(roles)) {
    if (r.kind === "desktop") {
      const t = traj[r.desktop_id];
      const st = t ? t.status.replace("CASCADE_RUN_STATUS_", "") : traj._err ? "OFFLINE" : "MISSING";
      const mod = t?.lastModifiedTime ? Date.parse(t.lastModifiedTime) : 0;
      const failed = st === "IDLE" && t?.latestExecutorTerminationReason === ERR_REASON;   // 出错停下：state 记 error
      out.push({ name, avatar: r.avatar || "gemini", kind: r.avatar === "claude" ? "反重力 · Claude" : "反重力 · Gemini", state: failed ? "error" : st === "RUNNING" ? (Date.now() - mod > STUCK_MIN * 60_000 ? "stuck" : "working") : st === "IDLE" ? "idle" : "offline",
        since: mod, lastMove: mod,
        doing: failed ? await lastError(r.desktop_id, mod) : traj._err ? `连不上桌面端：${clip(traj._err, 60)}` : tasks.get(name) ? `${tasks.get(name).from} 派的：${clip(tasks.get(name).text.replace(/^【[^】]*】/, ""), 80)}` : t?.summary ? clip(t.summary, 90) : "",
        said: t?.stepCount ? `共 ${t.stepCount} 步` : "" });
    } else if (r.kind === "codex") {
      const p = readJson(path.join(PRES, `${encodeURIComponent(name)}.json`), {});
      const lock = readJson(path.join(PRES, `${encodeURIComponent(name)}.lock`));
      const running = typeof lock === "number" ? alive(lock) : false;
      out.push({ name, avatar: "codex", kind: "Codex CLI", state: running ? "working" : p.state === "waiting" ? "waiting" : "idle", since: p.since ?? p.beat, lastMove: p.beat,
        doing: running ? clip(p.task, 90) : "", said: r.cwd ? "" : "", where: r.cwd?.replace(HOME, "~") });
    } else if (r.kind === "devin") {
      const p = readJson(path.join(PRES, `${encodeURIComponent(name)}.json`), {});
      const lock = readJson(path.join(PRES, `${encodeURIComponent(name)}.lock`));
      const running = typeof lock === "number" ? alive(lock) : false;
      // presence 写 state=waiting：桌面版把会话放开了、在等会话，不算歇着
      out.push({ name, avatar: "devin", kind: `Devin · ${r.model || ""}`, state: running ? "working" : p.state === "waiting" ? "waiting" : "idle", since: p.since ?? p.beat, lastMove: p.beat,
        doing: running ? clip(p.task, 90) : "", where: r.cwd?.replace(HOME, "~") });
    } else if (r.kind === "tmux") {
      out.push({ name, avatar: r.avatar || "claude", kind: "终端 agent · tmux", state: "unknown", doing: `窗口 ${r.tmux}`, since: 0, lastMove: 0 });
    }
  }
  return out;
}

// 名册以外、在别处手动开的 Codex 会话：读 ~/.codex/sessions 里 30 分钟内动过的会话记录
const CODEX_SESS = path.join(HOME, ".codex", "sessions");
function walk(dir, out = [], depth = 0) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory() && depth < 4) walk(p, out, depth + 1); else if (e.name.endsWith(".jsonl")) out.push(p); }
  return out;
}
function codexSessions(known) {
  const out = []; const since = Date.now() - 30 * 60_000;
  const now = new Date(); const days = [0, 1].map((k) => { const d = new Date(now - k * 86400_000); return path.join(CODEX_SESS, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")); });
  for (const f of days.flatMap((d) => walk(d))) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < since) continue;
    let meta = {}; try { meta = JSON.parse(fs.readFileSync(f, "utf8").split("\n", 1)[0]).payload ?? {}; } catch {}
    if (known.has(meta.id)) continue;
    const fd = fs.openSync(f, "r"); const len = Math.min(st.size, 80_000); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd);
    let running = false, doing = "", said = "", started = 0;
    for (const l of b.toString("utf8").split("\n").slice(1)) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      const t = e.payload?.type;
      if (t === "task_started") { running = true; started = Date.parse(e.timestamp) || started; }
      else if (t === "task_complete") running = false;
      else if (t === "function_call") doing = `${e.payload.name}${e.payload.arguments ? "：" + clip(e.payload.arguments, 70) : ""}`;
      else if (t === "agent_message" && e.payload.message) said = e.payload.message;
      else if (e.type === "response_item" && e.payload?.role === "assistant") { const c = e.payload.content?.find?.((x) => x.text); if (c) said = c.text; }
    }
    out.push({ name: `Codex · ${path.basename(meta.cwd || "?")}`, avatar: "codex", kind: `Codex · ${meta.originator === "codex_exec" ? "后台" : "手动"}`,
      state: running ? (Date.now() - st.mtimeMs > STUCK_MIN * 60_000 ? "stuck" : "working") : "idle",
      since: started || st.mtimeMs, lastMove: st.mtimeMs, doing: clip(doing, 90), said: clip(said, 160), where: meta.cwd?.replace(HOME, "~") });
  }
  return out;
}

// 最近 n 条消息（新的在前）；before=行号 时取这一行之前的 n 行，给「加载更早的消息」用。line 是在收件箱里的行号，at 是完整时间戳
function messagesPage(n = 40, before = Infinity) {
  let rows = []; try { rows = inboxTail(n, before); } catch {}
  const list = rows.map(({ line, text }) => { try { const m = JSON.parse(text); return { line, at: fullTime(m), id: m.id, time: m.time, from: m.from, to: m.to ?? "主控", type: m.type, text: clip(m.text, 3000) }; } catch { return null; } }).filter(Boolean).reverse();
  return { messages: list, more: rows.length > 0 && rows[0].line > 1 };
}

// 名牌用的三个附加字段（只加不改）：tool 跑在哪个工具里（色签），model 用的哪家模型（头像和干活区小字），group 员工表里写的分组
// tool：员工表写了 tool 就用，否则看 kind；model：员工表 brain → model → 从 kind 里取，Claude Code 会话取不到就写 Claude
function toolOf(kind) {
  const k = String(kind || "");
  if (/^反重力/.test(k)) return "反重力";
  if (/^Devin/.test(k)) return "Devin";
  if (/^Codex/.test(k)) return "Codex";
  if (/^终端/.test(k)) return "终端";
  return "Claude Code"; // Claude Code 会话，包括跑在 Claude Code 里的 DeepSeek（claude-ds）
}
function modelFromKind(kind) {
  const k = String(kind || "");
  const dv = /^Devin · (.+)$/.exec(k); if (dv) return dv[1].trim();
  if (/DeepSeek/i.test(k)) return "DeepSeek";
  if (/Gemini/i.test(k)) return "Gemini";
  if (/Claude/i.test(k)) return "Claude";
  return "";
}
// 对话健康（health.mjs 写的 ~/agy-logs/presence/<员工>.health.json）：{state:"overflow"|"renewed"|"big"|"ok", at, old, new, mb}；文件没有或读坏了就当没有
function healthOf(name) {
  const h = readJson(path.join(PRES, `${encodeURIComponent(name)}.health.json`));
  if (!h || typeof h.state !== "string") return null;
  const at = typeof h.at === "number" ? h.at : Date.parse(h.at) || 0;
  const until = typeof h.until === "string" && h.until ? h.until : "";
  // quota 带着「什么时候恢复」：until 是额度重置时间，recover 是给人看的本地时间
  return { state: h.state, at, mb: typeof h.mb === "number" ? h.mb : null, from: h.from || "", model: h.model || "", until, recover: until ? clockText(until) : "" };
}
function withTag(a, roles) {
  const r = roles[a.name] || {};
  return { ...a, tool: r.tool || toolOf(a.kind), model: r.brain || r.model || modelFromKind(a.kind), group: r.group || "", health: roles[a.name] ? healthOf(a.name) : null };
}

async function snapshot() {
  if (DEMO) return demoSnapshot();
  const bridges = bridgePids();
  const roles = readJson(ROLES, {});
  const known = new Set(Object.values(roles).map((r) => r.session).filter(Boolean));
  const agents = [...await employeeAgents(), ...claudeAgents(bridges), ...codexSessions(known)].map((a) => withTag(a, roles));
  // 额度用完：health.mjs 记了 quota 且还没到恢复时间 → 单独一个「没额度」状态，不再当作出错挂在干活区；
  // 恢复时间已过就当它已经好了（额度报错是旧的、活多数也被别人接手了），显示成歇着，别再挂红
  const now = Date.now();
  for (const a of agents) {
    const h = a.health;
    if (!h || h.state !== "quota") continue;
    const until = Date.parse(h.until || "");
    const expired = Number.isFinite(until) && now >= until;
    a.state = expired ? "idle" : "quota";
    a.doing = expired ? "" : h.recover ? `额度用完，${h.recover} 恢复` : "额度用完，等额度恢复";
    a.said = "";
  }
  const order = { error: 0, stuck: 0, working: 1, waiting: 2, idle: 2, quota: 3, unknown: 3, offline: 4 };
  agents.sort((a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3) || (b.lastMove ?? 0) - (a.lastMove ?? 0));
  const mp = messagesPage();
  return { at: Date.now(), agents, messages: mp.messages, more: mp.more };
}

// ---------- 快照全局共用 ----------
// 以前每个打开的标签页每 3 秒各算一次（每次跑 ps、读几十个文件、调反重力接口）。现在全局每 3 秒算一次，所有连接共用；内容没变就不推。
// BOARD_LOG=1 时每算一次打一行日志（第几次、几个连接、耗时、推没推），验证用。
const TICK_MS = 3000;
const LOG = process.env.BOARD_LOG === "1";
const clients = new Set();
let latest = null, latestKey = "", latestAt = 0, computing = null, computed = 0, timer = null;
function refresh() {
  if (computing) return computing;
  computing = (async () => {
    const t0 = Date.now();
    const snap = await snapshot();
    const key = JSON.stringify({ ...snap, at: 0 });
    const changed = key !== latestKey;
    latest = snap; latestKey = key; latestAt = Date.now(); computed++;
    if (changed) { const data = `data: ${JSON.stringify(snap)}\n\n`; for (const res of clients) { try { res.write(data); } catch {} } }
    if (LOG) console.log(`[快照] 第 ${computed} 次 · ${clients.size} 个连接 · ${Date.now() - t0}ms · ${changed ? "有变化，已推" : "没变，不推"}`);
    return snap;
  })().finally(() => { computing = null; });
  return computing;
}
function loop() {
  timer = null;
  if (!clients.size) return;
  const t0 = Date.now();
  refresh().catch((e) => console.error("快照出错：", e.message)).finally(() => { if (clients.size && !timer) timer = setTimeout(loop, Math.max(500, TICK_MS - (Date.now() - t0))); });
}
const fresh = async () => (latest && Date.now() - latestAt < TICK_MS ? latest : refresh());

// 只认本机：Host 头必须是 127.0.0.1:端口 或 localhost:端口，防 DNS 重绑定（外面的网页借浏览器读消息）
const okHost = (h) => [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(String(h || "").toLowerCase());

const server = http.createServer(async (req, res) => {
  if (!okHost(req.headers.host)) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); return res.end("只允许本机访问"); }
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const json = (obj) => { res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
  if (url.pathname === "/api/state") return json(await fresh());
  if (url.pathname === "/api/messages") {
    const before = Number(url.searchParams.get("before")) || Infinity;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 40));
    return json(DEMO ? demoPage(limit, before) : messagesPage(limit, before));
  }
  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    try { res.write(`data: ${JSON.stringify(await fresh())}\n\n`); } catch {}
    clients.add(res);
    const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 15000);
    req.on("close", () => { clients.delete(res); clearInterval(ping); });
    if (!timer && !computing) timer = setTimeout(loop, TICK_MS);
    return;
  }
  const m = /^\/assets\/((?:cut\/)?[a-z0-9-]+\.(gif|webp|png))$/.exec(url.pathname);
  if (m) { try { const buf = fs.readFileSync(new URL(`./board-assets/${m[1]}`, import.meta.url)); res.writeHead(200, { "content-type": `image/${m[2]}`, "cache-control": "max-age=86400" }); return res.end(buf); } catch { res.writeHead(404); return res.end(); } }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(fs.readFileSync(new URL("./board.html", import.meta.url), "utf8"));
});
server.listen(PORT, "127.0.0.1", () => console.log(`员工看板：http://127.0.0.1:${PORT}`));
