#!/usr/bin/env node
// 反重力命令行员工跑完一轮后替它回报：命令行员工不能 SendMessage，agy-run 起 agy 后在后台起本脚本盯着它的 pid，
// 进程一结束就往 ~/agy-logs/inbox.jsonl 写一条（成功 type=done，出错 type=help），to=派活的主控；
// 主控是本机活着的 Claude 会话的话，同时以会话间消息直接送进去（跟 peer-bridge 同一种帧）。
// 用法：node cli-done.mjs <项目/员工> <pid> <实时日志> <本轮开始时日志的字节数> <主控名> <工作目录> <本轮开始的秒级时间戳>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { errorSay, roundOk } from "./cli-seats.mjs";

const [key, pidS, log, offS, masterArg, dir, startS] = process.argv.slice(2);
if (!key || !pidS || !log) { console.error("用法：node cli-done.mjs <项目/员工> <pid> <日志> <起始字节> <主控> <目录> <开始时间戳>"); process.exit(1); }
const HOME = os.homedir();
const DIR = process.env.HUB_DIR ?? path.join(HOME, "agy-logs");
const INBOX = path.join(DIR, "inbox.jsonl");
const SESS = path.join(HOME, ".claude", "sessions");
const pid = Number(pidS), offset = Number(offS) || 0, started = Number(startS) || Math.floor(Date.now() / 1000);
const master = !masterArg || masterArg === "unknown" ? "主控" : masterArg;
const clip = (s, n) => { s = String(s ?? "").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => { const d = new Date(), p = (x) => String(x).padStart(2, "0"); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

/** 本轮（offset 之后）的最后一个 result 和步数 */
function thisRound() {
  let b = Buffer.alloc(0);
  try { const st = fs.statSync(log); const len = Math.max(0, st.size - offset); b = Buffer.alloc(len); const fd = fs.openSync(log, "r"); fs.readSync(fd, b, 0, len, offset); fs.closeSync(fd); } catch {}
  let result = null, steps = 0, conv = "", lastStep = null;
  for (const l of b.toString("utf8").split("\n")) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.event === "step_update") { steps++; lastStep = e.step_update; conv ||= e.step_update?.conversation_id || ""; }
    if (e.event === "result") result = e.result;
    if (e.event === "init") conv ||= e.conversation_id || "";
  }
  return { result, steps, lastStep, conv: conv || result?.conversation_id || "" };
}

function commits() {
  if (!dir) return [];
  try {
    return execFileSync("git", ["-C", dir, "log", `--since=@${started}`, "--format=%h %s", "-n", "20"], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch { return []; }
}

/** 主控是本机活着的 Claude 会话（不是 peer-bridge 登记的桥）就直接送 */
function pushToSession(name, text) {
  let files = []; try { files = fs.readdirSync(SESS); } catch { return false; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let d; try { d = JSON.parse(fs.readFileSync(path.join(SESS, f), "utf8")); } catch { continue; }
    if (d.name !== name || !d.messagingSocketPath || !alive(d.pid)) continue;
    const sha = crypto.createHash("sha256").update(d.messagingSocketPath).digest("hex");
    let token = ""; const k = files.find((x) => x.endsWith(`.${sha}.key`));
    if (k) { try { token = JSON.parse(fs.readFileSync(path.join(SESS, k), "utf8")).peerToken || ""; } catch {} }
    const from = `/tmp/cc-socks/agy-cli-${process.pid}.sock`;
    const frame = { msgV: 1, msg_id: crypto.randomUUID(), type: "user", priority: "next", from: `uds:${from}`,
      message: { role: "user", content: `<cross-session-message from="uds:${from}" from-name="${key}" from-mode="bypass">\n${text}\n</cross-session-message>` } };
    return new Promise((resolve) => {
      const c = net.createConnection(d.messagingSocketPath, () => {
        if (token) c.write(JSON.stringify({ type: "auth", token }) + "\n");
        c.write(JSON.stringify(frame) + "\n");
        setTimeout(() => { c.end(); resolve(true); }, 500);
      });
      c.on("error", () => resolve(false));
    });
  }
  return false;
}

while (alive(pid)) await sleep(5000);
await sleep(1500);   // 等最后几行日志落盘
const { result, steps, lastStep, conv } = thisRound();
const ok = roundOk(result, lastStep);
const mins = Math.max(1, Math.round((Date.now() / 1000 - started) / 60));
const cs = commits();
const head = ok ? `${key} 这一轮做完了（${mins} 分钟，${steps} 步）` : `${key} 这一轮出错停下了（${mins} 分钟，${steps} 步）：${result ? `${errorSay(result.error || result.status)}\n原文：${clip(result.error || result.status, 300)}` : "进程退出，日志里没有结果"}`;
const text = [head,
  cs.length ? `新提交 ${cs.length} 个：\n${cs.map((x) => `- ${x}`).join("\n")}` : "这一轮没有新提交",
  result?.response ? `它最后说：${clip(result.response, 1500)}` : "",
  `接着派活：agy-run ${key.replace("/", " ")} "<提示词>" ${master === "主控" ? "" : master}`.trim() + (conv ? `（会话 ${conv.slice(0, 8)}）` : ""),
  `日志：${log.replace(HOME, "~")}`].filter(Boolean).join("\n");
const msg = { id: crypto.randomBytes(4).toString("hex"), time: now(), from: key, to: master, type: ok ? "done" : "help", text: text.slice(0, 4000) };
fs.mkdirSync(DIR, { recursive: true });
fs.appendFileSync(INBOX, JSON.stringify(msg) + "\n");
if (master !== "主控") await pushToSession(master, `[${msg.type}] ${msg.text}`);
