// 派活：node agy-send.mjs <员工> "任务"（Windows 版，员工是 Codex / Kiro）
// 建任务目录 → 写 PROMPT.md → 脱离启动 hub-run.mjs → 记 PID；员工在忙就拒绝
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { roles, busy, setRun, stamp, JOBS, BIN_DIR, ROLES } from "./hub-lib.mjs";

const [role, ...rest] = process.argv.slice(2);
const task = rest.join(" ").trim();
const all = roles();
if (!role || !task) { console.log("用法：agy-send <员工> \"任务\""); process.exit(1); }
const r = all[role];
if (!r) { console.log(`没有员工 ${role}，现有：${Object.keys(all).join("、")}（员工表 ${ROLES}）`); process.exit(1); }
if (r.disabled) { console.log(`${role} 已停用：${r.disabledReason || ""}。换一个空闲的 cx / kr 员工，或先在 roles.json 去掉 disabled`); process.exit(1); }
if (r.kind === "codex-app") {
  // Codex 客户端：任务写进收件箱，客户端那个对话挂着 wait_for_task 会马上收到
  const { appendMsg, MASTER } = await import("./hub-lib.mjs");
  const m = appendMsg(MASTER, role, "task", task);
  console.log(`已记进 ${role}（Codex 客户端）的收件箱（消息 ${m.id}）；它挂着等活就马上开工，没挂着就等老板在客户端里说「接着等活」`);
  process.exit(0);
}
if (!["codex", "cursor", "kiro", "claude-ds"].includes(r.kind)) { console.log(`${role} 的 kind 是「${r.kind}」，Windows 上只能派给 codex / cursor / kiro / claude-ds`); process.exit(1); }
const b = busy(role);
if (b) { console.log(`${role} 正在干活（${b.dir}，从 ${new Date(b.start).toLocaleTimeString("zh-CN")} 开始），没派。先 stop_agent 或换个空闲员工`); process.exit(2); }

const base = process.env.AGY_MODEL && (r.kind === "codex" || r.kind === "cursor") ? { ...r, model: process.env.AGY_MODEL } : r;
const dir = join(r.jobs || JOBS, `${role}-${stamp()}`);
mkdirSync(dir, { recursive: true });
const reply = `node "${join(BIN_DIR, "agy-reply.mjs")}" ${role}`;
const head = `# 你是 ${role}（${r.name || role}），由主控派活

- 卡住或者要拍板：运行 \`${reply} help "问题、选项、你先按哪个做"\` 发给主控，然后按你的默认选项继续干，别停下来等。
- 完成一个大阶段：\`${reply} progress "一句话"\`。
- 主控的回复：运行 \`node "${join(BIN_DIR, "agy-read.mjs")}" ${role}\` 查看（每做完一个大阶段看一次）。
- 做完：在本目录 REPORT.md 写结论（中文大白话，开头 3～5 行），系统会自动把结果发给主控。
- 不写任何密码 / key / token 进文件和日志。

## 任务

`;
const preamble = process.env.HUB_PREAMBLE_FILE ? readFileSync(process.env.HUB_PREAMBLE_FILE, "utf8").replace(/^\uFEFF/, "") + "\n\n" : "";
writeFileSync(join(dir, "PROMPT.md"), "\uFEFF" + preamble + head + task + "\n", "utf8");

const env = { ...process.env };
if (process.env.AGY_MODEL) env.AGY_MODEL = process.env.AGY_MODEL;
const p = spawn(process.execPath, [join(BIN_DIR, "hub-run.mjs"), role, dir], { detached: true, stdio: "ignore", windowsHide: true, env, cwd: dir });
p.unref();
setRun(role, { pid: p.pid, dir, start: Date.now(), task: task.slice(0, 80), kind: r.kind, model: base.model || base.agent });
const who = r.kind === "cursor" ? `Cursor ${base.model || "claude-opus-5-5-high-fast"}` : r.kind === "codex" ? `Codex ${base.model || "gpt-6.1-sol"} · ${r.effort || "high"}` : r.kind === "claude-ds" ? `Claude DS ${r.model || "deepseek-flash"}` : `Kiro ${r.agent || "default"}`;
console.log(`已派给 ${role}（${who}），任务目录 ${dir}；做完会自动发 done 给主控`);
