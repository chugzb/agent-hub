#!/usr/bin/env node
// agent-hub：主控和各 agent 之间的联动 MCP（stdio，零依赖）
// 收件箱 ~/agy-logs/inbox.jsonl、员工表 ~/.config/agy-team/roles.json，跟 agy-send / agy-reply / agy-agents 同一套数据
// 环境变量：HUB_SIDE=master（主控，多出派活 / 停活）或 employee（默认）；HUB_ME=调用方名字（可选，不填就每次传 me）
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
const deskCall = async () => { throw new Error("Windows 未启用反重力桌面适配器，请使用 CLI 员工或 Codex app 员工"); };

import { HOME } from "./home.mjs";
import { archiveInbox, ARCHIVE_AT_BYTES } from "./windows-inbox-archive.mjs";
import { withInboxLock } from "./inbox-lock.mjs";
// HUB_DIR 只给测试用，正式都用 ~/agy-logs
const DIR = process.env.HUB_DIR ?? join(HOME, "agy-logs");
const INBOX = join(DIR, "inbox.jsonl");
const CURSORS = join(DIR, "cursors");
const PRESENCE = join(DIR, "presence");
const ROLES = process.env.HUB_ROLES ?? join(HOME, ".config", "agy-team", "roles.json");
const BIN = join(HOME, ".local", "bin");
const WIN = process.platform === "win32";
// Windows：命令是本目录 bin 下的 node 脚本（agy-send.mjs 等），员工是 Codex / Kiro
const WIN_BIN = join(dirname(fileURLToPath(import.meta.url)), "bin");
const SIDE = process.env.HUB_SIDE === "master" ? "master" : "employee";
const MASTER = "主控";
const MASTER_ALIASES = new Set(["主控", "master", "leader"]);
const ENV = { ...process.env, PATH: WIN ? process.env.PATH : `${BIN}:${process.env.PATH ?? "/usr/bin:/bin"}` };

const canon = (n) => {
  const s = String(n ?? "").trim();
  return MASTER_ALIASES.has(s.toLowerCase()) || MASTER_ALIASES.has(s) ? MASTER : s;
};
const now = () => {
  const d = new Date(), p = (x) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const roles = () => {
  try { return JSON.parse(readFileSync(ROLES, "utf8")); } catch { return {}; }
};

const ARCHIVE_AT = Number(process.env.HUB_ARCHIVE_AT_BYTES) || ARCHIVE_AT_BYTES;
const ARCHIVE_CHECK_MS = 10 * 60_000;
let lastArchiveCheck = 0;

/** 收件箱大了就把 30 天前的挪进归档。十分钟最多看一次；出什么错都不能影响收发 */
function maybeArchive() {
  const t = Date.now();
  if (t - lastArchiveCheck < ARCHIVE_CHECK_MS) return;
  lastArchiveCheck = t;
  try {
    const r = archiveInbox(DIR, { maxBytes: ARCHIVE_AT });
    if (r.archived) console.error(`收件箱归档：${r.archived} 条挪进 ${r.months.join("、")}，${r.cursors} 个游标已换算`);
  } catch (e) {
    console.error(`收件箱归档失败：${String(e.message).slice(0, 200)}`);
  }
}

function readInbox() {
  maybeArchive();
  if (!existsSync(INBOX)) return [];
  const out = [];
  readFileSync(INBOX, "utf8").split("\n").forEach((l, i) => {
    if (!l.trim()) return;
    try {
      const d = JSON.parse(l);
      // 老消息没有 to，都是发给主控的；没有 id 就用行号
      out.push({ ...d, to: canon(d.to ?? MASTER), from: canon(d.from), id: d.id ?? `L${i + 1}`, line: i + 1 });
    } catch { /* 坏行跳过 */ }
  });
  return out;
}
const cursorFile = (me) => join(CURSORS, `${encodeURIComponent(me)}.json`);
const getCursor = (me) => { try { return JSON.parse(readFileSync(cursorFile(me), "utf8")).line ?? 0; } catch { return 0; } };
const setCursor = (me, line) => { mkdirSync(CURSORS, { recursive: true }); writeFileSync(cursorFile(me), JSON.stringify({ line })); };

function run(cmd, args, { detached = false, env = ENV } = {}) {
  return new Promise((resolve) => {
    // detached：agy-send 在后台起的 agy 不跟着 MCP 进程组一起被杀
    const p = WIN
      ? spawn(process.execPath, [join(WIN_BIN, `${cmd}.mjs`), ...args], { env, detached, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(join(BIN, cmd), args, { env, detached, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("error", (e) => resolve({ code: -1, out: "", err: e.message }));
    p.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

// 桌面端员工的在线状态：waiting 等活 / working 干活；beat 是最近一次心跳
const setPresence = (me, state, extra = {}) => {
  mkdirSync(PRESENCE, { recursive: true });
  const p = join(PRESENCE, `${encodeURIComponent(me)}.json`);
  let old = {};
  try { old = JSON.parse(readFileSync(p, "utf8")); } catch { /* 第一次 */ }
  const since = old.state === state ? old.since : Date.now();
  writeFileSync(p, JSON.stringify({ ...old, ...extra, state, since, beat: Date.now() }));
};
const appendMsg = (msg) => {
  mkdirSync(DIR, { recursive: true });
  withInboxLock(DIR, () => appendFileSync(INBOX, JSON.stringify(msg) + "\n"));
};
const newMsg = (from, to, type, text) => ({ id: randomBytes(4).toString("hex"), time: now(), from, to, type, text: text.slice(0, 4000) });
const fmt = (m) => `[${m.time}] ${m.from} → ${m.to} · ${m.type}${m.status ? ` · ${m.status}` : ""}\n${m.text}`;
// 桌面端员工：反重力桌面会话（desktop）或老板的 Codex 客户端对话（codex-app），都靠挂着 wait_for_task 收活
const isDesktop = (role) => ["desktop", "codex-app"].includes(roles()[role]?.kind);
const isCodexApp = (role) => roles()[role]?.kind === "codex-app";

// 桌面端员工：直接往它的桌面会话里发一条消息把它叫醒（会话号记在 roles.json 的 desktop_id）
async function desktopStatus(role) {
  const id = roles()[role]?.desktop_id;
  if (!id) return { id, status: "没登记会话" };
  const r = await deskCall("GetAllCascadeTrajectories", {});
  const t = r.data.trajectorySummaries?.[id];
  return { id, status: t ? t.status.replace("CASCADE_RUN_STATUS_", "") : "找不到会话", steps: t?.stepCount, modified: t?.lastModifiedTime };
}
async function wakeDesktop(role, task) {
  const msg = newMsg(MASTER, role, "task", task);
  appendMsg(msg);
  // 主路：员工挂着 wait_for_task，一写进收件箱它就收到
  let pres = {};
  try { pres = JSON.parse(readFileSync(join(PRESENCE, `${encodeURIComponent(role)}.json`), "utf8")); } catch { /* 没上过线 */ }
  if (pres.state === "waiting" && Date.now() - (pres.beat ?? 0) < 60_000) return `已派给 ${role}（${isCodexApp(role) ? "Codex 客户端" : "桌面端"}正在等活，马上开工）`;
  if (isCodexApp(role)) {
    if (pres.state === "working" && Date.now() - (pres.beat ?? 0) < 6 * 3600_000) return `${role}（Codex 客户端）正在干上一单，任务已记进收件箱，它做完回去等活时会收到`;
    return `已记进 ${role} 的收件箱，但 Codex 客户端现在没挂着等活：请老板在 Codex 客户端那个对话里说一句「接着等活」（让它调 wait_for_task，me=${role}）`;
  }
  // 兜底：员工没在等，桌面会话空闲就直接叫醒
  let st;
  try { st = await desktopStatus(role); } catch (e) { return `已记进 ${role} 的收件箱，但它没在等活，桌面端也连不上（${e.message}）：请用户打开反重力桌面端`; }
  if (!st.id) return `已记进 ${role} 的收件箱，但它没在等活，roles.json 里也没登记桌面会话号（desktop_id）`;
  if (st.status === "RUNNING") return `${role} 正在干活，没打断；任务已记进收件箱，它回去等活时会收到`;
  if (st.status !== "IDLE") return `已记进收件箱，但 ${role} 的桌面会话状态是 ${st.status}，没叫醒`;
  await deskCall("SendUserCascadeMessage", { cascadeId: st.id, items: [{ text: `【主控派活 ${msg.id}】\n先调 read_messages（me=${role}）收下这条任务（避免重复），然后照做：\n${task}\n\n做完用 send_message（me=${role}，type=done）回报主控，再回去调 wait_for_task（me=${role}）接着等活。` }] });
  return `${role} 没在等活，已直接叫醒它开工`;
}

// 客户端取消的请求（notifications/cancelled），等活的轮询看到就停，不吃掉消息
const cancelled = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const who = (args) => canon(args.me ?? process.env.HUB_ME ?? "");

const TOOLS = [
  {
    name: "list_agents",
    description: "列出团队：hub 员工（Windows 上是 Codex cx1～ / Kiro kr1～，在忙还是空闲、跑了多久、最近一行日志），以及本机不经 hub 在跑的 Codex / Kiro 任务。派活前先看谁空闲。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await run("agy-agents", []);
      return r.code === 0 ? r.out : `查不到：${r.err || r.out}`;
    },
  },
  {
    name: "send_message",
    description: "给另一个 agent 发消息（异步，进共享收件箱）。员工找主控：to 填「主控」，type 用 help（卡住或要拍板，写清问题、选项、你先按哪个做，然后继续干活别停）或 progress（完成一个大阶段，一句话）。主控回员工：to 填员工号（如 3a），type 用 reply。",
    inputSchema: {
      type: "object",
      properties: {
        me: { type: "string", description: "你自己的名字，比如 3a、3b、主控；桌面端没有员工号就填「桌面」" },
        to: { type: "string", description: "收件人，默认「主控」" },
        type: { type: "string", enum: ["help", "progress", "done", "reply", "note"], description: "消息类型；桌面端做完一单要自己发 done" },
        text: { type: "string", description: "消息内容，写短" },
      },
      required: ["type", "text"],
      additionalProperties: false,
    },
    handler: async (a) => {
      const from = who(a);
      if (!from) throw new Error("缺少 me：告诉我你是谁（比如 3a）");
      const text = String(a.text ?? "").trim();
      if (!text) throw new Error("text 不能为空");
      const msg = newMsg(from, canon(a.to ?? MASTER), a.type, text);
      appendMsg(msg);
      if (a.type === "done" && isDesktop(from)) setPresence(from, "idle");
      return `已发给 ${msg.to}（消息 ${msg.id}）${a.type === "done" && isDesktop(from) ? "。接着调 wait_for_task 等下一单" : ""}`;
    },
  },
  {
    name: "read_messages",
    description: "读发给你的消息。默认只返回上次读过之后的新消息并记住读到哪；all=true 连旧的一起看最近 limit 条。员工每接一单开始时、每做完一个大阶段时读一次，主控的回复会在这里。",
    inputSchema: {
      type: "object",
      properties: {
        me: { type: "string", description: "你自己的名字，比如 3a、主控" },
        all: { type: "boolean", description: "包括已读，默认 false" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "最多几条，默认 20" },
      },
      additionalProperties: false,
    },
    handler: async (a) => {
      const me = who(a);
      if (!me) throw new Error("缺少 me：告诉我你是谁（比如 3a）");
      const limit = a.limit ?? 20;
      return withInboxLock(DIR, () => {
      const all = readInbox();
      const cur = getCursor(me);
      let mine = all.filter((m) => m.to === me && (a.all || m.line > cur));
      if (!a.all && all.length) setCursor(me, all[all.length - 1].line);
      mine = mine.slice(-limit);
      if (!mine.length) return a.all ? "没有发给你的消息" : "没有新消息";
      return mine.map(fmt).join("\n\n");
      });
    },
  },
  {
    name: "wait_for_task",
    description: "（桌面端员工用）挂着等主控派活或回复，有新消息立刻返回；到时间还没有就返回「还没有新活」，再调一次接着等。收到 task 就开工，做完用 send_message 发 done 给主控，然后回来接着等。",
    inputSchema: {
      type: "object",
      properties: {
        me: { type: "string", description: "你的员工号，比如 3c" },
        timeout_seconds: { type: "integer", minimum: 10, maximum: 540, description: "最多等几秒，默认 240" },
      },
      required: ["me"],
      additionalProperties: false,
    },
    handler: async (a, reqId) => {
      const me = who(a);
      if (!me) throw new Error("缺少 me");
      const end = Date.now() + (a.timeout_seconds ?? 240) * 1000;
      setPresence(me, "waiting");
      while (Date.now() < end) {
        if (cancelled.has(reqId)) { cancelled.delete(reqId); return "已取消"; }
        const received = withInboxLock(DIR, () => {
        const all = readInbox();
        const cur = getCursor(me);
        const mine = all.filter((m) => m.to === me && m.line > cur);
        if (mine.length) {
          setCursor(me, all[all.length - 1].line);
          const task = mine.find((m) => m.type === "task");
          if (task) setPresence(me, "working", { task: task.text.slice(0, 80) });
          return mine.map(fmt).join("\n\n");
        }
        return null;
        });
        if (received !== null) return received;
        setPresence(me, "waiting");
        await sleep(2000);
      }
      return "还没有新活，接着调 wait_for_task 等";
    },
  },
  {
    name: "dispatch_task",
    description: "（只给主控）派活。Windows 上：给 Codex（cx1～）或 Kiro（kr1～）员工开一个任务目录（由 HUB_JOBS 配置），任务写进 PROMPT.md 后台跑，做完自动往收件箱发 done（带 REPORT.md 开头和最后回复）。员工在忙会被拒，先 list_agents 看状态。task 写清楚目标、范围、交付；长任务可以写「先读 <任务单路径>」。",
    master: true,
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "员工号，比如 3a、3b" },
        task: { type: "string", description: "任务内容，最好指向任务单文件" },
        model: { type: "string", description: "临时换模型（可选，只对 Codex 生效），比如 gpt-6.1-sol" },
      },
      required: ["role", "task"],
      additionalProperties: false,
    },
    handler: async (a) => {
      if (!roles()[a.role]) throw new Error(`没有员工 ${a.role}，现有：${Object.keys(roles()).join("、")}`);
      if (roles()[a.role].disabled) throw new Error(`${a.role} 已停用：${roles()[a.role].disabledReason || "停用"}`);
      if (isDesktop(a.role)) return wakeDesktop(a.role, String(a.task));
      const env = a.model ? { ...ENV, AGY_MODEL: a.model } : ENV;
      const r = await run("agy-send", [a.role, a.task], { detached: true, env });
      return r.code === 0 ? r.out : `没派出去（${r.code}）：${r.out || r.err}`;
    },
  },
  {
    name: "stop_agent",
    description: "（只给主控）停掉员工正在跑的这一单：只按记录的 PID 杀它自己的进程树，任务目录保留。",
    master: true,
    inputSchema: {
      type: "object",
      properties: { role: { type: "string", description: "员工号，比如 3a" } },
      required: ["role"],
      additionalProperties: false,
    },
    handler: async (a) => {
      if (!roles()[a.role]) throw new Error(`没有员工 ${a.role}`);
      if (isDesktop(a.role)) return isCodexApp(a.role) ? "Codex 客户端停不了，请老板在客户端那个对话里点停止" : "桌面端停不了，请用户在桌面端点停止";
      const r = await run("agy-stop", [a.role]);
      return r.out || r.err || `退出码 ${r.code}`;
    },
  },
];

const visible = TOOLS.filter((t) => SIDE === "master" || !t.master);

const INSTRUCTIONS = SIDE === "master"
  ? "你是主控。list_agents 看团队，dispatch_task 派活，read_messages(me=主控) 收员工的求助和进度，send_message 回复员工。"
  : WIN
  ? "团队联动（你是主控派来的 Codex / Kiro 员工，员工号看 PROMPT.md 开头）：卡住或要拍板时用 send_message（me=你的员工号，type=help）发给主控，写清问题、选项、你先按哪个做，然后按默认继续干，别停；完成大阶段发 progress。每做完一个大阶段用 read_messages（me=你的员工号）看主控有没有回复。整单做完不用发 done，系统会自动发。"
  : "团队联动：桌面端员工开工前和做完一单后都调 wait_for_task 等活，做完自己发 done。所有员工：卡住或要拍板时用 send_message 发 help 给主控，然后按你的默认选项继续干活；完成大阶段发 progress。每接一单开始和每个大阶段结束时用 read_messages 看主控有没有回复。整单做完不用发 done，系统会自动发。";

// ---- MCP stdio（每行一条 JSON-RPC）----
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params = {} } = msg;
  const isReq = id !== undefined && id !== null;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-hub", version: "0.3.0" },
        instructions: INSTRUCTIONS,
      });
    case "notifications/cancelled":
      if (params.requestId !== undefined) cancelled.add(params.requestId);
      return;
    case "ping":
      return isReq && reply(id, {});
    case "tools/list":
      return reply(id, { tools: visible.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const t = visible.find((x) => x.name === params.name);
      if (!t) return fail(id, -32602, `没有这个工具：${params.name}`);
      try {
        const text = await t.handler(params.arguments ?? {}, id);
        return reply(id, { content: [{ type: "text", text: String(text) }] });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    default:
      if (isReq) fail(id, -32601, `不支持：${method}`);
  }
}

let buf = "";
const pending = new Set();
const track = (m) => { const p = handle(m); pending.add(p); p.finally(() => pending.delete(p)); };
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } }); continue; }
    if (Array.isArray(msg)) msg.forEach(track); else track(msg);
  }
});
// 客户端关了输入，等手上的请求做完再退
process.stdin.on("end", () => Promise.allSettled([...pending]).then(() => process.exit(0)));
