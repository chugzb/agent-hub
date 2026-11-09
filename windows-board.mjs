#!/usr/bin/env node
// 员工看板：本机网页，只读，只监听 127.0.0.1。实时显示每个员工在干活 / 空闲 / 疑似卡住、在做什么、做了多久，以及员工之间的消息。
// 数据：~/.claude/sessions/*.json + 对话记录（Claude Code 会话）、反重力桌面端本机接口、Codex 适配器的 presence、~/agy-logs/inbox.jsonl。
// 界面思路借鉴 abtop-web-ui（卡片 + 状态点 + 时长）、agent-orchestrator（「需要你处理」置顶）、herdr（卡住判断从严）、repowire（消息时间线）。
// 用法：node board.mjs [端口，默认 4646]
import http from "node:http";
import fs from "node:fs";
import { INBOX } from "./bin/hub-lib.mjs";
import { windowsAgents, claudeAgents, redact } from "./windows-state.mjs";
import { teamState } from "./team-state.mjs";
const PORT = Number(process.argv[2] || process.env.BOARD_PORT || 4646);
const clip = (s, n = 140) => { s = redact(s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
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

// 最近 n 条消息（新的在前）；before=行号 时取这一行之前的 n 行，给「加载更早的消息」用。line 是在收件箱里的行号，at 是完整时间戳
function messagesPage(n = 40, before = Infinity) {
  let rows = []; try { rows = inboxTail(n, before); } catch {}
  const list = rows.map(({ line, text }) => { try { const m = JSON.parse(text); return { line, at: fullTime(m), id: m.id, time: m.time, from: m.from, to: m.to ?? "主控", type: m.type, text: clip(m.text, 3000) }; } catch { return null; } }).filter(Boolean).reverse();
  return { messages: list, more: rows.length > 0 && rows[0].line > 1 };
}

async function snapshot() {
  const agents = [...windowsAgents(), ...claudeAgents()];
  const order = { error: 0, stuck: 0, working: 1, idle: 2, offline: 4 };
  agents.sort((a,b) => (order[a.state] ?? 3) - (order[b.state] ?? 3) || a.name.localeCompare(b.name));
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
  try {
  if (!okHost(req.headers.host)) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); return res.end("只允许本机访问"); }
  if (req.url === "/favicon.ico") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const json = (obj) => { res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  if (req.headers.origin && ![`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(req.headers.origin)) { res.writeHead(403); return res.end(); }
  if (url.pathname === "/api/state") return json(await fresh());
  if (url.pathname === "/api/float") { const {all,...compact}=teamState((await fresh()).agents); return json(compact); }
  if (url.pathname === "/mini") { res.writeHead(200, {"content-type":"text/html; charset=utf-8","cache-control":"no-store"}); return res.end(fs.readFileSync(new URL("./mini.html",import.meta.url),"utf8")); }
  if (url.pathname === "/float") { res.writeHead(200, {"content-type":"text/html; charset=utf-8","cache-control":"no-store"}); return res.end(fs.readFileSync(new URL('./float.html',import.meta.url),'utf8')); }
  if (url.pathname === "/api/messages") {
    const before = Number(url.searchParams.get("before")) || Infinity;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 40));
    return json(messagesPage(limit, before));
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
  if (url.pathname !== "/") { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(fs.readFileSync(new URL("./board.html", import.meta.url), "utf8"));
  } catch { if (!res.headersSent) res.writeHead(500); res.end("读取失败"); }
});
server.listen(PORT, "127.0.0.1", () => console.log(`员工看板：http://127.0.0.1:${PORT}`));
