// 后台跑一单：起 Codex 或 Kiro，等它结束，把结果作为 done 写进收件箱
// 用法（agy-send 脱离启动）：node hub-run.mjs <员工> <任务目录>
import { looksUnfinished, RESUME_MAX } from "../health.mjs";
import { HOME } from "../home.mjs";
import { startDeepSeekJob } from "./hub-claude-ds.mjs";
import { spawn } from "node:child_process";
import { openSync, writeFileSync, existsSync, readFileSync, mkdirSync, closeSync } from "node:fs";
import { join } from "node:path";
import { roles, appendMsg, clearRun, readText, BIN_DIR, MASTER, JOBS, INBOX } from "./hub-lib.mjs";

const [role, dir] = process.argv.slice(2);
const r0 = roles()[role];
if (!r0 || r0.disabled) process.exit(1);
// dispatch_task 临时换模型：只对 Codex 生效
const r = process.env.AGY_MODEL && (r0.kind === "codex" || r0.kind === "cursor") ? { ...r0, model: process.env.AGY_MODEL } : r0;
const prompt = join(dir, "PROMPT.md");

// Keep per-job temporary data separate from provider profiles and settings.
const employeeTemp = join(dir, "browser-temp");
const employeeNpmCache = process.env.HUB_NPM_CACHE || join(HOME, ".cache", "agent-hub", "npm");
mkdirSync(employeeTemp, { recursive: true });
mkdirSync(employeeNpmCache, { recursive: true });
const employeeEnv = {
  ...process.env,
  TEMP: employeeTemp,
  TMP: employeeTemp,
  TMPDIR: employeeTemp,
  NODE_COMPILE_CACHE: join(employeeTemp, "node-compile-cache"),
  npm_config_cache: employeeNpmCache,
};

let child, log, dsJob, continuation = 0, session = "", turnOffset = 0;
const knownMessages = new Set(readText(INBOX, 10_000_000).split("\n").flatMap(l => { try { return [JSON.parse(l).id]; } catch { return []; } }));
function replied() {
  return readText(INBOX, 10_000_000).split("\n").some(l => { try { const m = JSON.parse(l); return !knownMessages.has(m.id) && m.from === role && ["done", "help"].includes(m.type); } catch { return false; } });
}
function start() {
turnOffset = readText(join(dir, r.kind === "kiro" ? "kiro.log" : "run.log"), 10_000_000).length;
let descriptors = [];
const output = () => { const fd = openSync(log, "a"); descriptors.push(fd); return fd; };
const input = () => { const fd = openSync(continuation ? join(dir, "CONTINUE.md") : prompt, "r"); descriptors.push(fd); return fd; };
if (r.kind === "codex") {
  log = join(dir, "run.log");
  // 0.6.0: exec resume has no -s; use the shared config spelling, retaining bypass.
  const common = ["-m", r.model || "gpt-6.1-sol", "-c", `model_reasoning_effort=${r.effort || "high"}`,
    "-c", "sandbox_mode=danger-full-access", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--json", "-o", join(dir, "last.txt")];
  const command = continuation ? ["exec", "resume", ...common, session, "-"] : ["exec", ...common, "-C", dir, "-"];
  const fd = output();
  child = spawn("cmd.exe", ["/d", "/c", "codex.cmd", ...command], { cwd: dir, env: employeeEnv, stdio: [input(), fd, fd], windowsHide: true });
} else if (r.kind === "cursor") {
  // Cursor CLI（命令 agent）：headless 打印模式，危险命令由 ~/.cursor/cli-config.json deny 拦
  log = join(dir, "run.log");
  const rules = process.env.HUB_CURSOR_RULES_FILE;
  const ask = continuation ? `继续刚才那单，从断的地方接着做；先读 ${join(dir, "CONTINUE.md")}。` : `${rules ? `先完整读 ${rules} 并严格遵守；` : ""}完整读本任务的 ${join(dir, "PROMPT.md")}，按它做完。REPORT.md 写在 ${dir}。最后用中文简短总结结果。`;
  const extra = (r.add_dirs || []).flatMap((d) => ["--add-dir", d]);
  const args = ["/d", "/c", (process.env.HUB_CURSOR_CMD || join(process.env.LOCALAPPDATA || join(HOME, "AppData", "Local"), "cursor-agent", "agent.cmd")), "-p", "--force", "--trust", "--approve-mcps", "--workspace", dir, ...extra, "--model", r.model || "claude-opus-5-5-high-fast", "--output-format", "stream-json", ...(continuation ? ["--resume", session] : []), ask];
  const fd = output();
  child = spawn("cmd.exe", args, { cwd: dir, env: employeeEnv, stdio: ["ignore", fd, fd], windowsHide: true });
} else if (r.kind === "claude-ds") {
  log = join(dir, "run.log");
  try {
    dsJob = startDeepSeekJob({ role, dir, promptFd: openSync(prompt, "r"), log, parentEnv: employeeEnv, model: r.model });
    child = dsJob.child;
  } catch (error) {
    // Helper errors never contain credentials; avoid serializing environment or request headers.
    const message = String(error.message);
    writeFileSync(log, message + "\n");
    appendMsg(role, MASTER, "done", message + "，任务目录 " + dir, { status: "error", dir });
    clearRun(role, process.pid);
    process.exit(1);
  }
} else if (r.kind === "kiro") {
  log = join(dir, "kiro.log");
  const ps1 = process.env.HUB_KIRO_SCRIPT || join(BIN_DIR, "hub-kiro.ps1");
  child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Dir", dir, "-Log", log, "-Agent", r.agent || "default", "-HomeDir", r.home || join(JOBS, `${role}-home`)],
    { cwd: dir, env: employeeEnv, stdio: "ignore", windowsHide: true });
} else {
  appendMsg(role, MASTER, "done", `没派出去：员工 ${role} 的 kind 是「${r.kind}」，只支持 codex / cursor / kiro / claude-ds`, { status: "error" });
  process.exit(1);
}
for (const fd of descriptors) closeSync(fd);
if (child.pid) writeFileSync(join(dir, "child.pid"), String(child.pid));

child.on("close", (code) => {
  if (dsJob) {
    if (code === 0 && (!dsJob.state.sawResult || dsJob.state.isError || !existsSync(join(dir, "REPORT.md")))) code = 1;
    writeFileSync(join(dir, "model-evidence.json"), JSON.stringify({
      provider: "DeepSeek Anthropic compatible API", requestedModel: r.model || "deepseek-flash",
      responseModels: [...dsJob.state.models], resultSeen: dsJob.state.sawResult, resultError: dsJob.state.isError,
      exitCode: code, checkedAt: new Date().toISOString(),
    }, null, 2));
  }
  const last = dsJob ? dsJob.state.last : r.kind === "cursor" ? (() => { const ls = readText(log, 2_000_000).trim().split(/\r?\n/).reverse(); for (const l of ls) { try { const j = JSON.parse(l); if (j.type === "result") return String(j.result || "").slice(-1500); } catch {} } return ls.slice(0, 3).reverse().join(" / ").slice(-900); })() : existsSync(join(dir, "last.txt")) ? readText(join(dir, "last.txt")).trim() : "";
  const turn = readText(log, 10_000_000).slice(turnOffset);
  for (const line of turn.split("\n")) {
    try { const j = JSON.parse(line); const id = j.type === "thread.started" ? j.thread_id : j.session_id;
      if (typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id)) session = id;
    } catch {}
  }
  const finalText = r.kind === "kiro" ? turn.split("\n").map(l=>l.trim()).filter(l=>l && !/^\[(tool|hub|INFO|DEBUG)\]|^KIRO_JOB_DONE$/.test(l)).slice(-3).join(" ") : last;
  if (["codex", "cursor", "kiro"].includes(r.kind) && code === 0 && looksUnfinished(finalText)
      && !(r.kind === "kiro" && turn.includes("KIRO_JOB_DONE")) && !replied() && !roles()[role]?.disabled) {
    if (continuation < RESUME_MAX && (r.kind === "kiro" || session)) {
      continuation++;
      writeFileSync(join(dir, "CONTINUE.md"), `第 ${continuation} 次自动续上。继续刚才那单，从断的地方接着做；先读 PROMPT.md 和已有 REPORT.md，做过的不重做。命令等跑完再继续，全部完成再交卷。`);
      writeFileSync(join(dir, "continuation.json"), JSON.stringify({count:continuation, session, at:Date.now()}));
      start(); return;
    }
    code = 1;
    appendMsg(role, MASTER, "help", `半路收工：${session || r.kind === "kiro" ? `自动续了 ${continuation} 次仍未完成` : "没有取得准确会话号，未猜测最近会话"}，请核对 ${dir}`, {dir});
  }
  const rep = existsSync(join(dir, "REPORT.md")) ? readFileSync(join(dir, "REPORT.md"), "utf8").replace(/^﻿/, "").trim().slice(0, 700) : "";
  // Kiro 日志里 [tool] 开头的是过程行，回报时去掉
  const tail = last ? last.slice(-900) : readText(log).split("\n").map((l) => l.trim()).filter((l) => l && !/^\[(tool|hub|INFO|DEBUG|WARN|ERROR)\]|^\+ |^\(Use `node|^所在位置|^At line|NativeCommandError|RemoteException|^kiro-cli.exe : |^KIRO_JOB_DONE$|^[─━>~+\s]*$/.test(l)).slice(-3).join(" / ").slice(-900);
  const parts = [`退出码 ${code}，任务目录 ${dir}`];
  if (dsJob) parts.push(`响应 model：${[...dsJob.state.models].join("、") || "未取得（不能认定调用成功）"}`);
  if (rep) parts.push(`REPORT.md：${rep}`);
  if (tail) parts.push(`最后的回复：${tail}`);
  appendMsg(role, MASTER, "done", dsJob ? dsJob.redact(parts.join("\n")) : parts.join("\n"), { status: code === 0 ? "ok" : "error", dir });
  clearRun(role, process.pid);
  process.exit(0);
});
child.on("error", (e) => {
  appendMsg(role, MASTER, "done", `没起来：${e.message}，任务目录 ${dir}`, { status: "error", dir });
  clearRun(role, process.pid);
  process.exit(1);
});

}
start();
