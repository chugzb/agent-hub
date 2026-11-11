#!/usr/bin/env node
// agent-hub：主控和各 agent 之间的联动 MCP（stdio，零依赖）
// 收件箱 ~/agy-logs/inbox.jsonl、员工表 ~/.config/agy-team/roles.json，跟 agy-send / agy-reply / agy-agents 同一套数据
// 环境变量：HUB_SIDE=master（主控，多出派活 / 停活）或 employee（默认）；HUB_ME=调用方名字（可选，不填就每次传 me）
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { call as deskCall, wake as deskWake } from "./desk.mjs";
import { toolPath } from "./toolpaths.mjs";
import { masterName } from "./identity.mjs";
import { archiveInbox, ARCHIVE_AT_BYTES } from "./inbox-archive.mjs";


if (process.platform === "win32") {
  await import("./windows-server.mjs");
} else {

const HOME = homedir();
// HUB_DIR 只给测试用，正式都用 ~/agy-logs
const DIR = process.env.HUB_DIR ?? join(HOME, "agy-logs");
const INBOX = join(DIR, "inbox.jsonl");
const CURSORS = join(DIR, "cursors");
const PRESENCE = join(DIR, "presence");
const ROLES = join(HOME, ".config", "agy-team", "roles.json");
const BIN = join(HOME, ".local", "bin");
const SIDE = process.env.HUB_SIDE === "master" ? "master" : "employee";
const MASTER = "主控";
const MASTER_ALIASES = new Set(["主控", "master", "leader"]);
const ENV = { ...process.env, PATH: `${BIN}:${process.env.PATH ?? "/usr/bin:/bin"}` };

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

// 收件箱超过 2MB 就归档：HUB_ARCHIVE_AT_BYTES 只给测试用，跟 HUB_DIR 一个性质
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
  maybeArchive();   // 先归档再读：这样读出来的行号跟刚换算过的游标是一套
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
    const p = spawn(join(BIN, cmd), args, { env, detached, stdio: ["ignore", "pipe", "pipe"] });
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
  appendFileSync(INBOX, JSON.stringify(msg) + "\n");
  maybeArchive();   // 写进来之后也看一眼：收件箱刚过阈值时能及时归档
};
const newMsg = (from, to, type, text) => ({ id: randomBytes(4).toString("hex"), time: now(), from, to, type, text: text.slice(0, 4000) });
const fmt = (m) => `[${m.time}] ${m.from} → ${m.to} · ${m.type}${m.status ? ` · ${m.status}` : ""}\n${m.text}`;
const isDesktop = (role) => roles()[role]?.kind === "desktop";
// 11-07：通用适配器。有桥的员工类型：desktop（反重力桌面端）、codex（Codex CLI）、tmux（任何跑在 tmux 里的终端 agent）
const kindOf = (role) => roles()[role]?.kind;
const BRIDGED = new Set(["desktop", "codex", "devin", "cursor", "tmux"]);
const TMUX = toolPath("tmux", "TMUX_BIN"); // 环境变量 TMUX_BIN > ~/.config/agent-hub/config.json > 自动找
const runAbs = (bin, args) => new Promise((resolve) => {
  const p = spawn(bin, args, { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  let err = ""; p.stderr.on("data", (d) => (err += d));
  p.on("error", (e) => resolve({ code: -1, err: e.message })); p.on("close", (code) => resolve({ code, err: err.trim() }));
});
const ADAPTERS = join(new URL(".", import.meta.url).pathname, "adapters");
async function deliver(role, from, text) {
  const k = kindOf(role);
  if (k === "desktop") return deliverToDesktop(role, from, text);
  if (k === "codex" || k === "devin" || k === "cursor") {
    // 后台拉起一轮；已经在跑的话它自己会退出，消息留在收件箱，跑着的那轮结束后接着处理
    const p = spawn(process.execPath, [join(ADAPTERS, "codex-run.mjs"), role], { detached: true, stdio: "ignore", env: ENV });
    p.unref();
    return `，${k === "devin" ? "Devin" : k === "cursor" ? "Cursor" : "Codex"} 已开跑这一轮（在跑的话排队，跑完接着处理），回复会自动发回`;
  }
  if (k === "tmux") {
    const target = roles()[role]?.tmux;
    if (!target) return "，roles.json 里没写 tmux 目标（比如 gem1:0.0），没推送";
    const body = `【${from} 的消息】${text}${from === "系统" ? "" : `（回复用 agent-hub send_message：me=${role}，to=${from}）`}`.replace(/\n/g, " ");
    // 用「贴缓冲区」而不是 send-keys：只要有人以只读方式挂着 tmux（tmux attach -r），send-keys 会被整台 tmux 拒绝（client is read-only）
    const buf = `hub-${role}`;
    const a = await runAbs(TMUX, ["set-buffer", "-b", buf, body]);
    const b = a.code === 0 ? await runAbs(TMUX, ["paste-buffer", "-d", "-b", buf, "-t", target]) : a;
    if (b.code !== 0) return `，打进 tmux 失败（${b.err || b.code}）`;
    await sleep(400);
    // 回车单独贴一次，避免终端 agent 把整段当成粘贴不提交
    await runAbs(TMUX, ["set-buffer", "-b", buf, "\r"]);
    await runAbs(TMUX, ["paste-buffer", "-d", "-r", "-b", buf, "-t", target]);
    return `，已打进它的 tmux 窗口（${target}）`;
  }
  return "";
}

// 桌面端员工：直接往它的桌面会话里发一条消息把它叫醒（会话号记在 roles.json 的 desktop_id）
async function desktopStatus(role) {
  const id = roles()[role]?.desktop_id;
  if (!id) return { id, status: "没登记会话" };
  const r = await deskCall("GetAllCascadeTrajectories", {});
  let t = r.data.trajectorySummaries?.[id];
  // 11-07：桌面端重开后，员工对话要先按会话号读一次才会加载进来；没加载就先读，再查一次
  if (!t) {
    try { await deskCall("GetCascadeTrajectory", { cascadeId: id }); } catch { /* 会话号不对就照旧报找不到 */ }
    t = (await deskCall("GetAllCascadeTrajectories", {})).data.trajectorySummaries?.[id];
  }
  return { id, status: t ? t.status.replace("CASCADE_RUN_STATUS_", "") : "找不到会话", steps: t?.stepCount, modified: t?.lastModifiedTime };
}
// 11-07：员工不再循环 wait_for_task。发给桌面端员工的消息：在干活就推进对话（不打断），停着就叫醒
async function deliverToDesktop(role, from, text) {
  const id = roles()[role]?.desktop_id;
  if (!id) return "";
  let st;
  try { st = await desktopStatus(role); } catch (e) { return `，推送失败（${e instanceof Error ? e.message : e}），它下次读消息时会看到`; }
  const head = `【${from} 的消息】`;
  const tail = from === "系统" ? "" : `\n\n（回复用 send_message：me=${role}，to=${from}。处理完就结束这一轮，不要循环 wait_for_task，有新消息会自动推给你或叫醒你。）`;
  try {
    if (st.status === "IDLE") { await deskWake(id, head + text + tail); return "，它停着，已叫醒"; }
    await deskCall("SendAgentMessage", { recipient: id, displayTitle: `${from} 的消息`, content: head + text + tail });
    return "，已直接推进它的对话";
  } catch (e) { return `，推送失败（${e instanceof Error ? e.message : e}），它下次读消息时会看到`; }
}
async function wakeDesktop(role, task) {
  const boss = selfMaster() ?? MASTER;   // 派活人记真名，员工做完回报给他
  const msg = newMsg(boss, role, "task", task);
  appendMsg(msg);
  // 主路：员工挂着 wait_for_task，一写进收件箱它就收到
  let pres = {};
  try { pres = JSON.parse(readFileSync(join(PRESENCE, `${encodeURIComponent(role)}.json`), "utf8")); } catch { /* 没上过线 */ }
  if (pres.state === "waiting" && Date.now() - (pres.beat ?? 0) < 60_000) return `已派给 ${role}（桌面端正在等活，马上开工）`;
  // 兜底：员工没在等，桌面会话空闲就直接叫醒
  let st;
  try { st = await desktopStatus(role); } catch (e) { return `已记进 ${role} 的收件箱，但它没在等活，桌面端也连不上（${e.message}）：请用户打开反重力桌面端`; }
  if (!st.id) return `已记进 ${role} 的收件箱，但它没在等活，roles.json 里也没登记桌面会话号（desktop_id）`;
  if (st.status === "RUNNING") return `${role} 正在干活，没打断；任务已记进收件箱，它回去等活时会收到`;
  if (st.status !== "IDLE") return `已记进收件箱，但 ${role} 的桌面会话状态是 ${st.status}，没叫醒`;
  await deskWake(st.id, `【${boss === MASTER ? "主控" : boss}派活 ${msg.id}】\n先调 read_messages（me=${role}）收下这条任务（避免重复），然后照做：\n${task}\n\n做完用 send_message（me=${role}，to=${boss}，type=done）回报${boss}，然后结束这一轮，不要循环 wait_for_task，有新活会自动叫醒你。`);
  return `${role} 没在等活，已直接叫醒它开工`;
}

// 客户端取消的请求（notifications/cancelled），等活的轮询看到就停，不吃掉消息
const cancelled = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 11-08：「主控」就是调用方自己所属的那个 Claude Code 会话（master-a / master-b / master-c 各是各的）。
// 找得到会话名就用真名（派活、发消息的 from 写它，员工回复按 to 推回那个会话）；找不到才写「主控」。
const selfMaster = () => { try { return masterName(); } catch { return null; } };
// 11-09：反重力命令行员工（agy-run 派的）调本工具时，模型会照着任务原文自称「3a」之类。本进程是 agy 直接拉起的，
// 父进程命令行里有 --conversation，工作目录就是座位目录：据此在 cli-sessions.json 里认出「项目/员工」，强制用它当身份
const cliSeat = (() => {
  if (process.env.HUB_DIR) return null;   // 测试环境不认
  try {
    const args = execFileSync("ps", ["-o", "args=", "-p", String(process.ppid)], { encoding: "utf8" }).trim();
    if (!/^(\S*\/)?agy\s/.test(args)) return null;
    const conv = /--conversation\s+(\S+)/.exec(args)?.[1] || "";
    const reg = JSON.parse(readFileSync(join(HOME, ".config", "agy-team", "cli-sessions.json"), "utf8"));
    const cwd = process.cwd();
    return Object.keys(reg).find((k) => conv && reg[k].conversation === conv) || Object.keys(reg).find((k) => reg[k].dir === cwd) || null;
  } catch { return null; }
})();
const who = (args) => {
  if (cliSeat) return cliSeat;
  const c = canon(args.me ?? process.env.HUB_ME ?? "");
  return c === MASTER ? (selfMaster() ?? MASTER) : c;
};

const TOOLS = [
  {
    name: "list_agents",
    description: "列出团队里的 agent：反重力员工（模型、忙/空闲/卡住、最近动作）和正在运行的 Claude Code 会话。派活前先看谁空闲。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await run("agy-agents", []);
      return r.code === 0 ? r.out : `查不到：${r.err || r.out}`;
    },
  },
  {
    name: "send_message",
    description: "给另一个 agent 发消息（异步，进共享收件箱）。to 可以填 Claude 会话名（如 ai-f2、3d，消息开头会写是谁发来的），会直接送进那个会话；也可以填别的员工号（如 3b）。员工找主控：to 填「主控」或派活人的会话名，type 用 help（卡住或要拍板，写清问题、选项、你先按哪个做，然后继续干活别停）或 progress（完成一个大阶段，一句话）。主控回员工：to 填员工号（如 3a），type 用 reply。",
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
      // 主控发给桌面端员工：同时直接推进它正在跑的对话（高优先级系统消息），不靠员工自己记得去读
      let pushed = "";
      if (BRIDGED.has(kindOf(msg.to)) && from !== msg.to) pushed = await deliver(msg.to, from, text);
      if (a.type === "done" && isDesktop(from)) setPresence(from, "idle");
      return `已发给 ${msg.to}（消息 ${msg.id}）${pushed}${a.type === "done" && isDesktop(from) ? "。这一单结束，直接停下，有新活会自动叫醒你" : ""}`;
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
      const all = readInbox();
      // 主控：me 是自己的会话名；发给「主控」的旧消息也算（11-08 以前都记成「主控」）。第一次用真名读时，游标从「主控」的游标接着走
      const legacy = me !== MASTER && me === selfMaster();
      const cur = legacy && !existsSync(cursorFile(me)) ? getCursor(MASTER) : getCursor(me);
      let mine = all.filter((m) => (m.to === me || (legacy && m.to === MASTER)) && (a.all || m.line > cur));
      if (!a.all && all.length) setCursor(me, all[all.length - 1].line);
      mine = mine.slice(-limit);
      if (!mine.length) return a.all ? "没有发给你的消息" : "没有新消息";
      return mine.map(fmt).join("\n\n");
    },
  },
  {
    name: "wait_for_task",
    description: "（桌面端员工用，少用）只在你发了 help、确实要等某条回复才能继续时调一次。平时不要循环调它：做完一单就结束这一轮，有新活、新消息会自动推进你的对话或叫醒你。",
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
        const all = readInbox();
        const cur = getCursor(me);
        const mine = all.filter((m) => m.to === me && m.line > cur);
        if (mine.length) {
          setCursor(me, all[all.length - 1].line);
          const task = mine.find((m) => m.type === "task");
          if (task) setPresence(me, "working", { task: task.text.slice(0, 80) });
          return mine.map(fmt).join("\n\n");
        }
        setPresence(me, "waiting");
        await sleep(2000);
      }
      return "还没有新消息。不要再等，直接结束这一轮；有新活或回复时会自动推给你或叫醒你。";
    },
  },
  {
    name: "dispatch_task",
    description: "（只给主控）给反重力员工派活：接着该员工的长期会话在后台跑，做完自动往收件箱发 done。员工在忙会被拒，先 list_agents 看状态。",
    master: true,
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "员工号，比如 3a、3b" },
        task: { type: "string", description: "任务内容，最好指向任务单文件" },
        model: { type: "string", description: "临时换模型（可选），比如 gemini-4-argon-medium" },
      },
      required: ["role", "task"],
      additionalProperties: false,
    },
    handler: async (a) => {
      if (!roles()[a.role]) throw new Error(`没有员工 ${a.role}，现有：${Object.keys(roles()).join("、")}`);
      if (isDesktop(a.role)) return wakeDesktop(a.role, String(a.task));
      const env = { ...ENV, ...(a.model ? { AGY_MODEL: a.model } : {}), HUB_MASTER: selfMaster() ?? "" };
      const r = await run("agy-send", [a.role, a.task], { detached: true, env });
      return r.code === 0 ? r.out : `没派出去（${r.code}）：${r.out || r.err}`;
    },
  },
  {
    name: "stop_agent",
    description: "（只给主控）停掉反重力员工正在跑的活，会话保留，下次派活接着做。",
    master: true,
    inputSchema: {
      type: "object",
      properties: { role: { type: "string", description: "员工号，比如 3a" } },
      required: ["role"],
      additionalProperties: false,
    },
    handler: async (a) => {
      if (!roles()[a.role]) throw new Error(`没有员工 ${a.role}`);
      if (isDesktop(a.role)) return "桌面端停不了，请用户在桌面端点停止";
      const r = await run("agy-stop", [a.role]);
      return r.out || r.err || `退出码 ${r.code}`;
    },
  },
];

const visible = TOOLS.filter((t) => SIDE === "master" || !t.master);

const INSTRUCTIONS = SIDE === "master"
  ? "你是主控。list_agents 看团队，dispatch_task 派活，read_messages(me=主控) 收员工的求助和进度，send_message 回复员工。"
  : "团队联动：桌面端员工不要循环调 wait_for_task 等活——做完一单发 done 后直接结束这一轮，有新活、新消息会自动推进你的对话或叫醒你。消息开头会写是谁发来的，回复时 send_message 的 to 填那个名字。所有员工：卡住或要拍板时用 send_message 发 help 给派活给你的人（消息开头写着是谁，to 填那个名字；没人派过活就填「主控」），然后按你的默认选项继续干活；完成大阶段发 progress。每接一单开始和每个大阶段结束时用 read_messages 看派活人有没有回复。整单做完不用发 done，系统会自动发。";

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
        serverInfo: { name: "agent-hub", version: "0.4.0" },
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

}
