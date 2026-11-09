// hub-bridge（Windows native peer bridge）
// 让 hub 员工（cx / kr / ds …，未停用的）以 Claude Code 本机会话的身份出现在原生 ListAgents 里：
//   - 进来：Claude 会话 SendMessage(to="cx2") → 本进程该员工的命名管道 → 记进 hub 收件箱（发件人=会话名）；
//           员工空闲且发件人是 主控会话 → 直接按这句话派一单（agy-send）；空闲但发件人不是主控会话 → 回执告诉对方去找主控
//   - 出去：员工发给「主控」或某个会话名的消息（done / help / progress …）→ 以 cross-session-message 推进那个 Claude 会话
// 一个进程托管全部管道；Claude 按 <pid>.json 认会话，所以每个员工配一个极小的占位进程（waitfor.exe）提供 pid。
// 登记格式按本机 Claude Code 2.1.319 实测（sessions/*.json、<pid>.<sha256(小写管道路径)>.key、procStart=FILETIME）。
// 不是公开接口：Claude Code 升级后可能失效；失效时收件箱照常记，主控用 read_messages / 监听照样能收，不丢消息。
// 用法：node hub-bridge.mjs            （常驻）
//       node hub-bridge.mjs --once cx2 （只登记一个员工，调试用）
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { HOME, roles, busy, appendMsg, INBOX, BIN_DIR, DIR, JOBS } from "./hub-lib.mjs";

const SESS = path.join(HOME, ".claude", "sessions");
const LOG = path.join(DIR, "hub-bridge.log");
const PID_DOMAIN = "win32:" + os.hostname().toLowerCase();
const MASTER_SESSION = process.env.HUB_MASTER_SESSION;
const MASTER_NAME_RE = MASTER_SESSION ? new RegExp(MASTER_SESSION, "i") : /主控|master/i;
const BRIDGE_TAG = "agent-hub-bridge";
const ONLY = process.argv.includes("--once") ? process.argv[process.argv.indexOf("--once") + 1] : null;
const KINDS = new Set(["codex", "kiro", "claude-ds", "cursor"]);

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hex16 = () => crypto.randomBytes(16).toString("hex");
const log = (...a) => { const l = `${new Date().toLocaleString("zh-CN", { hour12: false })} ${a.join(" ")}`; console.log(l); try { fs.appendFileSync(LOG, l + "\n"); } catch {} };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "")); } catch { return null; } };
const writeAtomic = (f, s) => { fs.writeFileSync(f + ".tmp", s); fs.renameSync(f + ".tmp", f); };
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const ccVersion = () => { for (const f of fs.readdirSync(SESS)) { if (!/^\d+\.json$/.test(f)) continue; const d = readJson(path.join(SESS, f)); if (d?.version && !d[BRIDGE_TAG]) return d.version; } return "2.1.319"; };

// 进程启动时间（Windows FILETIME，100ns since 1601），和 Claude 记的 procStart 同一口径
function fileTimes(pids) {
  if (!pids.length) return {};
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1}' -f $_.Id, $_.StartTime.ToFileTimeUtc() }`],
    { encoding: "utf8", windowsHide: true });
  const m = {}; for (const l of out.split(/\r?\n/)) { const [p, t] = l.trim().split(" "); if (p && t) m[p] = t; } return m;
}

// 上次没清干净的桥登记（占位进程已死）清掉；绝不碰真 Claude 会话的文件
function sweepStale() {
  for (const f of fs.readdirSync(SESS)) {
    const m = /^(\d+)\.json$/.exec(f); if (!m) continue;
    const d = readJson(path.join(SESS, f)); if (!d?.[BRIDGE_TAG]) continue;
    if (isAlive(Number(m[1])) && d.bridgePid && isAlive(d.bridgePid) && d.bridgePid !== process.pid) continue;
    for (const g of fs.readdirSync(SESS)) if (g === f || (g.startsWith(m[1] + ".") && g.endsWith(".key"))) { try { fs.rmSync(path.join(SESS, g), { force: true }); } catch {} }
    log(`清掉旧登记 ${d.name}（pid ${m[1]}）`);
  }
}

// 名字防撞：有真 Claude 会话叫这个名字就不登记
function realSessionNamed(name) {
  for (const f of fs.readdirSync(SESS)) {
    if (!/^\d+\.json$/.test(f)) continue; const d = readJson(path.join(SESS, f));
    if (d && !d[BRIDGE_TAG] && d.name === name && isAlive(d.pid)) return d.pid;
  }
  return 0;
}

// 活着的真 Claude 会话：name → { sock, at }
function liveSessions() {
  const out = [];
  for (const f of fs.readdirSync(SESS)) {
    if (!/^\d+\.json$/.test(f)) continue; const d = readJson(path.join(SESS, f));
    if (!d || d[BRIDGE_TAG] || !d.messagingSocketPath || !isAlive(d.pid)) continue;
    out.push({ name: d.name || `Claude ${d.pid}`, sock: d.messagingSocketPath, updatedAt: d.updatedAt || 0 });
  }
  return out;
}

function peerToken(sock) {
  const h = sha(sock.toLowerCase());
  const k = fs.readdirSync(SESS).find((f) => f.endsWith(`.${h}.key`));
  if (!k) return "";
  return readJson(path.join(SESS, k))?.peerToken || "";
}

const bridges = new Map(); // role → { name, sock, token, server, holder, regId, started, partners: Map(sock → {name, at}) }

function sendToSession(b, targetSock, text) {
  const tok = peerToken(targetSock);
  const frame = { msgV: 1, msg_id: crypto.randomUUID(), type: "user",
    message: { role: "user", content: `<cross-session-message from="uds:${b.sock}" from-name="${b.name}" from-mode="bypass">\n${text}\n</cross-session-message>` },
    priority: "next", from: `uds:${b.sock}` };
  return new Promise((resolve) => {
    const c = net.createConnection(targetSock, () => {
      if (tok) c.write(JSON.stringify({ type: "auth", token: tok }) + "\n");
      c.write(JSON.stringify(frame) + "\n");
      setTimeout(() => { c.end(); resolve(true); }, 400);
    });
    c.on("error", (e) => { log(`送出失败 ${b.name} → ${targetSock}：${e.message}`); resolve(false); });
  });
}

function aSession() { return liveSessions().filter((s) => MASTER_NAME_RE.test(s.name)).sort((x, y) => y.updatedAt - x.updatedAt)[0]; }

function resolveTarget(b, to) {
  if (to === "主控" || to.toLowerCase() === "master") {
    const live = [...b.partners.entries()].filter(([, p]) => Date.now() - p.at < 3600_000).sort((x, y) => y[1].at - x[1].at);
    if (live.length) return { sock: live[0][0], name: live[0][1].name };
    const a = aSession(); return a ? { sock: a.sock, name: a.name } : null;
  }
  const s = liveSessions().find((x) => x.name === to);
  return s ? { sock: s.sock, name: s.name } : null;
}

// ---------- 进来 ----------
function onFrame(b, f, authed) {
  if (f.type !== "user") return;
  const raw = f?.message?.content;
  const content = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((p) => p?.text || "").join("") : "";
  const m = /^<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>$/.exec(content.trim());
  const attrs = m ? m[1] : "";
  const body = (m ? m[2] : content).trim();
  const fromName = /from-name="([^"]+)"/.exec(attrs)?.[1] || "某个 Claude 会话";
  const fromSock = /\bfrom="uds:([^"]+)"/.exec(attrs)?.[1] || (typeof f.from === "string" ? f.from.replace(/^uds:/, "") : "");
  if (fromSock) b.partners.set(fromSock, { name: fromName, at: Date.now() });
  log(`收到 ${fromName} → ${b.role}${authed ? "" : "（未带令牌）"}：${body.slice(0, 80).replace(/\n/g, " ")}`);
  if (!body) return;
  const r = roles()[b.role];
  const isA = MASTER_NAME_RE.test(fromName);
  if (!busy(b.role) && isA && r && !r.disabled) {
    const p = spawn(process.execPath, [path.join(BIN_DIR, "agy-send.mjs"), b.role, body], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", () => { log(`派单 ${b.role}：${out.trim().slice(0, 200)}`); if (fromSock) sendToSession(b, fromSock, `[系统] ${out.trim().slice(0, 600) || "已派"}`); });
    return;
  }
  appendMsg(fromName, b.role, "reply", body);
  if (!busy(b.role) && !isA && fromSock) sendToSession(b, fromSock, `[系统] ${b.role} 现在空闲，消息已记进它的收件箱，但只有主控会话能直接派活。要它干活请找「主控会话」。`);
}

function makeServer(b) {
  return net.createServer((conn) => {
    let buf = "", authed = false;
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buf += chunk; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let f; try { f = JSON.parse(line); } catch { continue; }
        if (f.type === "auth") { authed = f.token === b.token; continue; }
        if (!authed) { log(`拒收 ${b.role}：令牌不对`); continue; }
        try { onFrame(b, f, authed); } catch (e) { log(`处理出错 ${b.role}：${e.message}`); }
      }
    });
    conn.on("error", () => {});
  });
}

// ---------- 登记 ----------
function files(b) { return { json: path.join(SESS, `${b.holder.pid}.json`), key: path.join(SESS, `${b.holder.pid}.${sha(b.sock.toLowerCase())}.key`) }; }

function writeReg(b) {
  if (!b.holder?.pid || !b.procStart) return;
  const now = Date.now(), st = busy(b.role) ? "busy" : "idle";
  const { json } = files(b);
  const reg = { pid: b.holder.pid, sessionId: b.regId, cwd: JOBS, startedAt: b.started, procStart: b.procStart, version: VERSION,
    peerProtocol: 1, peerFeatures: [], kind: "interactive", entrypoint: "cli", pidDomain: PID_DOMAIN, asksForConvertedSkills: false,
    messagingSocketPath: b.sock, name: b.name, nameSource: "user", nameSince: b.started, updatedAt: now,
    status: st, statusUpdatedAt: b.lastStatus === st ? b.statusAt : (b.statusAt = now), [BRIDGE_TAG]: true, bridgePid: process.pid };
  b.lastStatus = st;
  writeAtomic(json, JSON.stringify(reg));
}

function unregister(b) {
  if (!b.holder?.pid) return;
  const { json, key } = files(b);
  for (const f of [json, key]) { try { fs.rmSync(f, { force: true }); } catch {} }
}

function startHolder(b) {
  // 占位进程：只提供一个活着的 pid；99999 秒后自己退，退了重起并重新登记
  const p = spawn(path.join(process.env.SystemRoot || process.env.WINDIR, "System32", "waitfor.exe"), ["/t", "99999", `agenthub${b.role}${hex16().slice(0, 6)}`], { stdio: "ignore", windowsHide: true });
  b.holder = p; b.procStart = null;
  p.on("exit", () => {
    if (b.holder !== p || stopping) return;
    unregister(b); b.holder = null;
    log(`${b.role} 占位进程退出，重起`);
    setTimeout(() => { if (bridges.get(b.role) === b && !stopping) { startHolder(b); fillProcStart([b]); } }, 2000);
  });
}

function fillProcStart(list) {
  const need = list.filter((b) => b.holder?.pid && !b.procStart);
  if (!need.length) return;
  let t = {}; try { t = fileTimes(need.map((b) => b.holder.pid)); } catch (e) { log("取进程时间失败：" + e.message); }
  for (const b of need) {
    const ft = t[String(b.holder.pid)]; if (!ft) continue;
    b.procStart = ft;
    writeAtomic(files(b).key, JSON.stringify({ peerToken: b.token, procStartFt: ft, pidDomain: PID_DOMAIN }));
    writeReg(b);
  }
}

function addBridge(role) {
  if (realSessionNamed(role)) { log(`不登记 ${role}：已有真 Claude 会话叫这个名字`); return null; }
  const b = { role, name: role, sock: `\\\\.\\pipe\\LOCAL\\cc-msg-${hex16()}`, token: hex16(), regId: crypto.randomUUID(), started: Date.now(), partners: new Map() };
  b.server = makeServer(b);
  b.server.on("error", (e) => log(`${role} 管道出错：${e.message}`));
  b.server.listen(b.sock);
  startHolder(b);
  bridges.set(role, b);
  return b;
}

function removeBridge(role) {
  const b = bridges.get(role); if (!b) return;
  bridges.delete(role);
  unregister(b);
  try { b.holder?.kill(); } catch {}
  try { b.server.close(); } catch {}
  log(`${role} 已撤下`);
}

function wanted() {
  const all = roles();
  return Object.entries(all).filter(([k, r]) => KINDS.has(r.kind) && !r.disabled && (!ONLY || k === ONLY)).map(([k]) => k);
}

function sync() {
  const want = new Set(wanted());
  const added = [];
  for (const r of want) if (!bridges.has(r)) { const b = addBridge(r); if (b) added.push(b); }
  for (const r of [...bridges.keys()]) if (!want.has(r)) removeBridge(r);
  if (added.length) setTimeout(() => { fillProcStart(added); log(`已登记 ${added.map((b) => b.role).join("、")}`); }, 300);
  for (const b of bridges.values()) { if (!b.procStart) fillProcStart([b]); else writeReg(b); }
}

// ---------- 出去：盯收件箱 ----------
// 已推过 / 启动前就有的消息 id：归档把收件箱变小后要从头重读，靠它不重推旧消息
const seen = new Set();
function seedSeen() {
  try { for (const l of fs.readFileSync(INBOX, "utf8").split("\n")) { try { const id = JSON.parse(l).id; if (id) seen.add(id); } catch {} } } catch {}
}
let inboxPos = 0;
function resetInbox() { seen.clear(); seedSeen(); inboxPos = fs.existsSync(INBOX) ? fs.statSync(INBOX).size : 0; }
resetInbox();
async function pollInbox() {
  let st; try { st = fs.statSync(INBOX); } catch { return; }
  if (st.size < inboxPos) { inboxPos = 0; log("收件箱变小（归档），从头重读，已推过的跳过"); }
  if (st.size === inboxPos) return;
  const fd = fs.openSync(INBOX, "r"); const buf = Buffer.alloc(st.size - inboxPos);
  fs.readSync(fd, buf, 0, buf.length, inboxPos); fs.closeSync(fd);
  const text = buf.toString("utf8"); const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return;                          // 半行，等写完
  inboxPos += Buffer.byteLength(text.slice(0, lastNl + 1));
  for (const line of text.slice(0, lastNl).split("\n")) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id) { if (seen.has(m.id)) continue; seen.add(m.id); if (seen.size > 50_000) { seen.clear(); seedSeen(); } }
    const b = bridges.get(m.from); if (!b) continue;
    const to = String(m.to ?? "主控");
    if (bridges.has(to) || to === "系统") continue;   // 员工之间的消息 hub 自己管
    const target = resolveTarget(b, to);
    if (!target) { log(`${m.from} → ${to}：没有对应的 Claude 会话在线，留在收件箱`); continue; }
    const head = `[${m.type}${m.status ? " · " + m.status : ""}]`;
    const ok = await sendToSession(b, target.sock, `${head} ${m.text}`);
    log(`${m.from} → ${target.name}（${m.type}）${ok ? "已推送" : "推送失败，留在收件箱"}`);
  }
}

// ---------- 启动 ----------
let stopping = false;
fs.mkdirSync(SESS, { recursive: true });
const VERSION = ccVersion();
function shutdown() { if (stopping) return; stopping = true; for (const r of [...bridges.keys()]) removeBridge(r); setTimeout(() => process.exit(0), 200); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown); process.on("SIGBREAK", shutdown);
process.on("exit", () => { for (const b of bridges.values()) { unregister(b); try { b.holder?.kill(); } catch {} } });
process.on("uncaughtException", (e) => log("未捕获错误：" + (e.stack || e.message)));

fs.mkdirSync(DIR, { recursive: true });
// 单实例：已有一份桥在跑就等它退了再接手（开机自启和手动起的不会撞车）
const LOCK = path.join(DIR, ".hub-bridge.lock");
function lockOwner() { const o = readJson(LOCK); return o?.pid && o.pid !== process.pid && isAlive(o.pid) ? o.pid : 0; }
function boot() {
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }));
  process.on("exit", () => { try { if (readJson(LOCK)?.pid === process.pid) fs.rmSync(LOCK, { force: true }); } catch {} });
  sweepStale();
  log(`hub-bridge 启动 pid=${process.pid} Claude ${VERSION}${ONLY ? " 只登记 " + ONLY : ""}`);
  sync();
  setInterval(sync, 30_000);
  setInterval(() => { pollInbox().catch((e) => log("盯收件箱出错：" + e.message)); }, 1500);
}
if (ONLY || !lockOwner()) boot();
else {
  log(`已有一份桥在跑（pid ${lockOwner()}），等它退出再接手`);
  const t = setInterval(() => { if (!lockOwner()) { clearInterval(t); resetInbox(); boot(); } }, 10_000);
}
