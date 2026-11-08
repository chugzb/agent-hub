#!/usr/bin/env node
// Codex 员工适配器：有发给它的新消息，就接着它的 Codex 会话跑一轮；跑完把最后一条回复自动回给发件人。
// 同一员工同时只跑一轮（锁文件）；跑的时候来的新消息排队，跑完接着处理，直到没有新消息为止。
// 用法：node codex-run.mjs <员工>        （由 agent-hub send_message 在后台拉起）
// roles.json：{"cx1": {"kind": "codex", "session": "<会话 UUID，可空，第一次跑会自动记上>", "cwd": "<工作目录>",
//              "sandbox": "read-only|workspace-write", "effort": "high（可选）", "log": "cx1"}}
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { toolPath } from "../toolpaths.mjs";
import { isQuotaError } from "../desk.mjs";

const ROLE = process.argv[2];
if (!ROLE) { console.error("用法：node codex-run.mjs <员工>"); process.exit(1); }
const HOME = os.homedir();
const DIR = path.join(HOME, "agy-logs");
const INBOX = path.join(DIR, "inbox.jsonl");
const ROLES = path.join(HOME, ".config", "agy-team", "roles.json");
const PRES = path.join(DIR, "presence");
const LOCK = path.join(PRES, `${encodeURIComponent(ROLE)}.lock`);
const CUR = path.join(DIR, "cursors", `${encodeURIComponent(ROLE)}.json`);
const HUB = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "server.mjs");
const CODEX = toolPath("codex", "CODEX_BIN"); // 环境变量 > ~/.config/agent-hub/config.json > 自动找
const LOGDIR = path.join(HOME, "codex-logs");
fs.mkdirSync(PRES, { recursive: true }); fs.mkdirSync(path.dirname(CUR), { recursive: true }); fs.mkdirSync(LOGDIR, { recursive: true });

const roles = () => JSON.parse(fs.readFileSync(ROLES, "utf8"));
const role = () => roles()[ROLE] ?? {};
const logFile = path.join(LOGDIR, `${role().log || ROLE}.log`);
const log = (s) => fs.appendFileSync(logFile, `[${new Date().toISOString().slice(0, 19)}] ${s}\n`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// 锁：已经有一轮在跑就退出，新消息留在收件箱，跑着的那轮结束后会接着处理
try {
  const fd = fs.openSync(LOCK, "wx"); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
} catch {
  const other = Number(fs.readFileSync(LOCK, "utf8"));
  if (other && alive(other)) process.exit(0);
  fs.writeFileSync(LOCK, String(process.pid));
}
const presence = (state, extra = {}) => fs.writeFileSync(path.join(PRES, `${encodeURIComponent(ROLE)}.json`), JSON.stringify({ state, beat: Date.now(), kind: role().kind || "codex", ...extra }));
let exitState = null;   // 额度用完躺平时，退出别把 quota 盖回 idle（看板要显示「额度用完」）
process.on("exit", () => { try { if (Number(fs.readFileSync(LOCK, "utf8")) === process.pid) fs.rmSync(LOCK); } catch {} presence(exitState ?? "idle"); });

const getCursor = () => { try { return JSON.parse(fs.readFileSync(CUR, "utf8")).line ?? 0; } catch { return 0; } };
function newMessages() {
  if (!fs.existsSync(INBOX)) return { msgs: [], last: 0 };
  const lines = fs.readFileSync(INBOX, "utf8").split("\n");
  const cur = getCursor(); const msgs = [];
  lines.forEach((l, i) => { if (!l.trim() || i + 1 <= cur) return; try { const d = JSON.parse(l); if (d.to === ROLE && d.from !== ROLE) msgs.push(d); } catch {} });
  return { msgs, last: lines[lines.length - 1] === "" ? lines.length - 1 : lines.length };
}

function reply(to, text) {
  const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { me: ROLE, to, type: "reply", text } } });
  spawnSync(process.execPath, [HUB], { input: req + "\n", env: { ...process.env, HUB_SIDE: "employee" }, encoding: "utf8" });
}

// 11-07：Devin 员工（kind=devin）也走这个适配器：devin -p 接着它文件夹里的会话跑一轮，标准输出就是回复
const DEVIN = toolPath("devin", "DEVIN_BIN");
function latestDevinSession(cwd) {
  try {
    const out = spawnSync("sqlite3", [`file:${HOME}/.local/share/devin/cli/sessions.db?mode=ro`, `select id from sessions where working_directory='${cwd.replace(/'/g, "''")}' order by last_activity_at desc limit 1`], { encoding: "utf8" });
    return out.stdout.trim();
  } catch { return ""; }
}
// 会话在 Devin 桌面版里开着时会被占用（session_locked）：每 30 秒重试，最多 10 分钟
async function runDevin(prompt, model) {
  // 桌面版打开过的会话会一直被它占着（切走也不放）。等 1 分钟还锁着，就开新会话接着干，并记下新会话号
  for (let i = 0; i < 3; i++) {
    const r = await runDevinOnce(prompt, model);
    if (!/session_locked|already open in another process/.test(r.raw)) return r;
    if (i === 0) log("会话被 Devin 桌面版占着；等 1 分钟，还锁着就开新会话");
    presence("waiting", { task: "等桌面版放开会话", since: START });
    if (i < 2) await new Promise((res) => setTimeout(res, 30_000));
  }
  const all = roles(); log(`会话 ${all[ROLE].session} 一直被占用，开新会话`); delete all[ROLE].session; fs.writeFileSync(ROLES, JSON.stringify(all, null, 2));
  const r = await runDevinOnce(prompt, model);
  return { ...r, text: (r.text ? r.text + "\n\n" : "") + "（注：原会话在 Devin 桌面版里开着被占用，这一轮在新会话里做的，没带之前的上下文。）" };
}
function runDevinOnce(prompt, model) {
  const r = role(); const cwd = r.cwd || HOME;
  const args = ["-p", prompt, "--model", model || r.model || "swe-2-high", "--permission-mode", r.permission || "accept-edits", "--respect-workspace-trust", "false"];
  if (r.session) args.push("-r", r.session);
  return new Promise((resolve) => {
    const p = spawn(DEVIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; fs.appendFileSync(logFile, d); presence("working", { since: START }); });
    p.stderr.on("data", (d) => { err += d; fs.appendFileSync(logFile, d); });
    p.on("close", (code) => {
      if (!role().session) { const id = latestDevinSession(cwd); if (id) { const all = roles(); all[ROLE] = { ...all[ROLE], session: id }; fs.writeFileSync(ROLES, JSON.stringify(all, null, 2)); log(`记下会话 ${id}`); } }
      const text = out.split("\n").filter((l) => !/^\s*[✓▲]\s|warning: rejected a tool call/.test(l)).join("\n").trim();
      resolve({ code, text, raw: out + err });
    });
  });
}

function runCodex(prompt, model) {
  if (role().kind === "devin") return runDevin(prompt, model);
  const r = role();
  const out = path.join(PRES, `${encodeURIComponent(ROLE)}.last.txt`);
  try { fs.rmSync(out, { force: true }); } catch {}
  const common = ["--skip-git-repo-check", "-s", r.sandbox || "read-only", "-o", out, "--json"];
  if (r.effort) common.push("-c", `model_reasoning_effort=${r.effort}`);
  if (model) common.push("-m", model);
  const args = r.session ? ["exec", "resume", ...common, r.session, prompt] : ["exec", "-C", r.cwd || HOME, ...common, prompt];
  return new Promise((resolve) => {
    const p = spawn(CODEX, args, { cwd: r.cwd || HOME, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "", raw = "";
    p.stdout.on("data", (d) => {
      buf += d; raw += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line);
          const id = ev.thread_id || ev.session_id || ev.payload?.thread_id || ev.msg?.session_id;
          if (id && !role().session) { const all = roles(); all[ROLE] = { ...all[ROLE], session: id }; fs.writeFileSync(ROLES, JSON.stringify(all, null, 2)); log(`记下会话 ${id}`); }
          const t = ev.type || ev.msg?.type;
          if (t) presence("working", { last: t, since: START });
        } catch {}
      }
      fs.appendFileSync(logFile, d);
    });
    p.stderr.on("data", (d) => { raw += d; fs.appendFileSync(logFile, d); });
    p.on("close", (code) => { let text = ""; try { text = fs.readFileSync(out, "utf8").trim(); } catch {} resolve({ code, text, raw }); });
  });
}

/**
 * 额度用完：员工表有 fallback_model 就换它把这一轮重跑一次，没有就回派活人「额度用完」并把状态写成 quota。
 * 只在「没拿到回复」时才当成额度用完（CLI 偶尔往 stderr 打一句 rate limit，但最后正常答了，不算）。
 */
async function runWithFallback(prompt) {
  const kind = role().kind === "devin" ? "Devin" : "Codex";
  const res = await runCodex(prompt);
  if (!isQuotaError(res.raw) || res.text) return res;
  const fb = role().fallback_model;
  log(`额度用完${fb ? `，换 ${fb} 把这一轮重跑一次` : "，员工表没写 fallback_model"}`);
  if (fb) {
    const again = await runCodex(prompt, fb);
    if (!isQuotaError(again.raw) || again.text) return again;
  }
  exitState = "quota";
  presence("quota", { since: START, task: "额度用完" });
  return { code: res.code, text: `（${kind} 的额度用完了${fb ? `，换成 ${fb} 也还是没额度` : ""}，这一轮没做成。请等额度恢复后再派，或把活转给别人。）`, quota: true };
}

const START = Date.now();
for (let round = 1; round <= 20; round++) {
  const { msgs, last } = newMessages();
  if (!msgs.length) break;
  fs.writeFileSync(CUR, JSON.stringify({ line: last }));
  const sender = msgs[msgs.length - 1].from;
  const prompt = msgs.map((m) => `【${m.from} 的消息】${m.text}`).join("\n\n")
    + `\n\n（你是团队里的 ${role().kind === "devin" ? "Devin" : "Codex"} 员工 ${ROLE}。你这一轮的最后一条回复会自动发回给 ${sender}，写短、写清做了什么。部署、花钱、对外操作一律不做，需要时在回复里说明。）`;
  presence("working", { task: msgs[msgs.length - 1].text.slice(0, 80), since: Date.now() });
  log(`第 ${round} 轮，${msgs.length} 条消息，来自 ${[...new Set(msgs.map((m) => m.from))].join("、")}`);
  const { code, text } = await runWithFallback(prompt);
  log(`结束（退出码 ${code}）`);
  reply(sender, text || `（${role().kind === "devin" ? "Devin" : "Codex"} 这一轮没有回复，退出码 ${code}，日志在 ${logFile}）`);
}
process.exit(0);
