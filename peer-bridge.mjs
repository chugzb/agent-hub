#!/usr/bin/env node
// peer-bridge：让一个反重力员工（如 3a）以 Claude Code 原生会话的身份出现在 ListAgents 里。
// 用法：node peer-bridge.mjs <员工名>
//   - 进来：Claude 会话 SendMessage(to=<员工名>) → 本进程的收件通道 → agent-hub send_message（记收件箱；员工在干活就推进对话，停着就叫醒）
//   - 出去：员工用 agent-hub send_message(to=<会话名>) 回复 → 本进程盯 inbox.jsonl → 以 cross-session-message 送进那个会话；
//           to 写「主控」的，送给 60 分钟内通过本桥给它发过消息的会话
// 登记格式按 Claude Code 2.1.285 本机实测 + farizap/pi-claude-peer（MIT）反推；不是公开接口，升级后可能失效。
// to 写「主控」时只转「经过本桥发起的对话」，别的主控通过老路派的活不碰。
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

const NAME = process.argv[2];
if (!NAME) { console.error("用法：node peer-bridge.mjs <员工名>"); process.exit(1); }
const pid = process.pid;
const SOCK_DIR = "/tmp/cc-socks";
const sock = `${SOCK_DIR}/${pid}.sock`;
const sessDir = path.join(os.homedir(), ".claude", "sessions");
const inbox = path.join(os.homedir(), "agy-logs", "inbox.jsonl");
const HUB = path.join(path.dirname(new URL(import.meta.url).pathname), "server.mjs");
const ROLES = path.join(os.homedir(), ".config", "agy-team", "roles.json");
const desktopRoles = () => { try { return new Set(Object.entries(JSON.parse(fs.readFileSync(ROLES, "utf8"))).filter(([, r]) => ["desktop", "codex", "devin", "cursor", "tmux"].includes(r.kind)).map(([k]) => k)); } catch { return new Set(); } };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const procStart = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, TZ: "UTC" } }).toString().trim();
const token = crypto.randomBytes(16).toString("hex");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const jsonFile = path.join(sessDir, `${pid}.json`);
const keyFile = path.join(sessDir, `${pid}.${sha(sock)}.key`);
const version = (() => { try { return JSON.parse(fs.readFileSync(path.join(sessDir, fs.readdirSync(sessDir).find((f) => f.endsWith(".json"))), "utf8")).version; } catch { return "2.1.285"; } })();

function register(status = "idle") {
  const now = Date.now();
  const reg = { pid, sessionId: REG_ID, cwd: os.homedir(), startedAt: STARTED, procStart, version, peerProtocol: 1, peerFeatures: [],
    kind: "interactive", entrypoint: "cli", pidDomain: "darwin", messagingSocketPath: sock, name: NAME, nameSource: "user",
    nameSince: STARTED, updatedAt: now, status, statusUpdatedAt: now };
  fs.writeFileSync(jsonFile + ".tmp", JSON.stringify(reg)); fs.renameSync(jsonFile + ".tmp", jsonFile);
}
const REG_ID = crypto.randomUUID(), STARTED = Date.now();

// 谁通过本桥给员工发过消息：socket → { name, at }
const partners = new Map();

function cleanup() { for (const f of [jsonFile, keyFile, sock]) { try { fs.rmSync(f, { force: true }); } catch {} } }
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(0));

// ---------- 进来 ----------
function handleUserFrame(frame) {
  const raw = frame?.message?.content;
  const content = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((p) => p?.text || "").join("") : "";
  const m = /^<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>$/.exec(content.trim());
  const attrs = m ? m[1] : "";
  const body = m ? m[2] : content;
  const fromName = /from-name="([^"]+)"/.exec(attrs)?.[1] || "某个 Claude 会话";
  const fromSock = (/\bfrom="uds:([^"]+)"/.exec(attrs)?.[1]) || (typeof frame.from === "string" ? frame.from.replace(/^uds:/, "") : "");
  if (fromSock) partners.set(fromSock, { name: fromName, at: Date.now() });
  log(`收到 ${fromName} → ${NAME}：${body.slice(0, 80).replace(/\n/g, " ")}`);
  // 交给 agent-hub：记收件箱 + 推进或叫醒（发件人写成 Claude 会话名，员工回复时 to 填它）
  const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { me: fromName, to: NAME, type: "reply", text: body } } });
  const p = spawn(process.execPath, [HUB], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HUB_SIDE: "employee" } });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.on("close", () => { try { log("hub:", JSON.parse(out.trim().split("\n").pop()).result.content[0].text); } catch { log("hub 无回执:", out.slice(0, 200)); } });
  p.stderr.on("data", (d) => log("hub 错误:", d.toString().trim()));
  p.stdin.end(req + "\n");
}

const server = net.createServer((conn) => {
  // 只收不回：不写回、不主动断开（否则发件方会报 success:false）
  let buf = "";
  conn.setEncoding("utf8");
  conn.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let f; try { f = JSON.parse(line); } catch { continue; }
      if (f.type === "user") handleUserFrame(f);
      else if (f.type !== "auth") log("忽略帧类型", f.type);
    }
  });
  conn.on("error", () => {});
});

// ---------- 出去 ----------
function sendToSession(targetSock, text) {
  const key = fs.readdirSync(sessDir).find((f) => f.endsWith(`.${sha(targetSock)}.key`));
  let peerToken = "";
  if (key) { try { peerToken = JSON.parse(fs.readFileSync(path.join(sessDir, key), "utf8")).peerToken || ""; } catch {} }
  const frame = { msgV: 1, msg_id: crypto.randomUUID(), type: "user",
    message: { role: "user", content: `<cross-session-message from="uds:${sock}" from-name="${NAME}" from-mode="bypass">\n${text}\n</cross-session-message>` },
    priority: "next", from: `uds:${sock}` };
  const c = net.createConnection(targetSock, () => {
    if (peerToken) c.write(JSON.stringify({ type: "auth", token: peerToken }) + "\n");
    c.write(JSON.stringify(frame) + "\n");
    setTimeout(() => c.end(), 500);
  });
  c.on("error", (e) => log("送出失败", targetSock, e.message));
}

// to 是活着的 Claude 会话名 → 直接送；to 是「主控」→ 送给 60 分钟内经本桥找过它的会话；to 是桌面端员工 → 不管（agent-hub 推）
// 退信给员工本人：走 agent-hub（记收件箱 + 推进或叫醒），发件人写「系统」
function bounce(text) {
  const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { me: "系统", to: NAME, type: "note", text } } });
  const p = spawn(process.execPath, [HUB], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, HUB_SIDE: "employee" } });
  p.stdin.end(req + "\n");
}

// 名字防撞车：本机已有活着的 Claude 会话（不是桥）叫这个名字，就不登记，免得消息送错人
function nameTaken() {
  for (const f of fs.readdirSync(sessDir)) {
    if (!f.endsWith(".json") || f === `${pid}.json`) continue;
    let d; try { d = JSON.parse(fs.readFileSync(path.join(sessDir, f), "utf8")); } catch { continue; }
    if (d.name !== NAME || !d.pid) continue;
    try { process.kill(d.pid, 0); } catch { continue; }
    let args = ""; try { args = execFileSync("ps", ["-o", "args=", "-p", String(d.pid)], { encoding: "utf8" }); } catch {}
    if (!args.includes("peer-bridge.mjs")) return d.pid;
  }
  return 0;
}

function resolveTarget(to) {
  if (to === "主控" || to.toLowerCase() === "master") {
    const live = [...partners.entries()].filter(([, p]) => Date.now() - p.at < 60 * 60 * 1000).sort((a, b) => b[1].at - a[1].at);
    return live.length ? { sock: live[0][0], name: live[0][1].name } : null;
  }
  if (desktopRoles().has(to)) return null;
  for (const f of fs.readdirSync(sessDir)) {
    if (!f.endsWith(".json")) continue;
    let d; try { d = JSON.parse(fs.readFileSync(path.join(sessDir, f), "utf8")); } catch { continue; }
    if (d.name !== to || !d.messagingSocketPath || d.pid === pid) continue;
    try { process.kill(d.pid, 0); } catch { continue; }
    return { sock: d.messagingSocketPath, name: to };
  }
  return null;
}

let inboxPos = fs.existsSync(inbox) ? fs.statSync(inbox).size : 0;
function pollInbox() {
  let st; try { st = fs.statSync(inbox); } catch { return; }
  if (st.size < inboxPos) inboxPos = 0;
  if (st.size === inboxPos) return;
  const fd = fs.openSync(inbox, "r"); const b = Buffer.alloc(st.size - inboxPos);
  fs.readSync(fd, b, 0, b.length, inboxPos); fs.closeSync(fd); inboxPos = st.size;
  for (const line of b.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.from !== NAME) continue;
    const target = resolveTarget(String(m.to ?? "主控"));
    if (!target) {
      const to = String(m.to ?? "主控");
      // 发给别的员工（agent-hub 自己推）、发给「主控」但不是经过本桥的对话（别的主控按老办法读收件箱）：不转，也不退
      if (to === "主控" || to.toLowerCase() === "master" || desktopRoles().has(to) || to === "系统") continue;
      log(`退信：没有叫 ${to} 的会话`);
      bounce(`你刚才发给「${to}」的消息没送到：本机现在没有叫这个名字的会话（可能已经关了，或改了名）。用 list_agents 看现在有谁，换个名字重发，或者发给「主控」。原文：${String(m.text).slice(0, 300)}`);
      continue;
    }
    log(`${NAME} → ${target.name}（${m.type}）：${String(m.text).slice(0, 80).replace(/\n/g, " ")}`);
    sendToSession(target.sock, `[${m.type}] ${m.text}`);
  }
}

fs.mkdirSync(SOCK_DIR, { recursive: true });
try { fs.rmSync(sock, { force: true }); } catch {}
const clash = nameTaken();
if (clash) {
  log(`不登记：本机已有一个叫「${NAME}」的 Claude 会话（pid ${clash}），换个员工名或让那个会话改名。60 秒后再查`);
  setTimeout(() => process.exit(3), 60_000);
} else server.listen(sock, () => {
  fs.chmodSync(sock, 0o600);
  fs.writeFileSync(keyFile, JSON.stringify({ peerToken: token, procStart, pidDomain: "darwin" }), { mode: 0o600 });
  register();
  setInterval(() => register(), 30_000);
  setInterval(pollInbox, 1500);
  log(`${NAME} 已登记为本机会话：pid=${pid} socket=${sock}`);
});
