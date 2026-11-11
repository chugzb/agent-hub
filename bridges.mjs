#!/usr/bin/env node
// 给 roles.json 里每个有桥的员工（kind=desktop / codex / tmux）起一个 peer-bridge，挂了 5 秒后自动拉起；roles.json 增删员工 30 秒内跟上。
// 由 launchd（~/Library/LaunchAgents/dev.agent-hub.bridges.plist）开机启动。
// 每 30 秒那一轮还会检查反重力员工的对话有没有撑爆（health.mjs）：撑爆了自动换新对话并通知主控。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { call as deskCall } from "./desk.mjs";
import { healthTick } from "./health.mjs";

const ROLES = path.join(os.homedir(), ".config", "agy-team", "roles.json");
const BRIDGE = path.join(path.dirname(new URL(import.meta.url).pathname), "peer-bridge.mjs");
const LOGDIR = path.join(os.homedir(), "agy-logs", "bridges");
fs.mkdirSync(LOGDIR, { recursive: true });
const kids = new Map();
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

const wanted = () => {
  try { return Object.entries(JSON.parse(fs.readFileSync(ROLES, "utf8"))).filter(([, r]) => ["desktop", "codex", "devin", "cursor", "tmux"].includes(r.kind)).map(([k]) => k); }
  catch { return []; }
};

function start(name) {
  const out = fs.openSync(path.join(LOGDIR, `${name}.log`), "a");
  const p = spawn(process.execPath, [BRIDGE, name], { stdio: ["ignore", out, out] });
  kids.set(name, p);
  log(`起 ${name}（pid ${p.pid}）`);
  p.on("exit", (code, sig) => {
    if (kids.get(name) !== p) return;
    kids.delete(name);
    log(`${name} 退出（${code ?? sig}），5 秒后重起`);
    setTimeout(() => { if (wanted().includes(name) && !kids.has(name)) start(name); }, 5000);
  });
}

// 反重力桌面端重开后，员工对话要按会话号读一次才会加载；没加载的先读一下，看板、状态表、推送才找得到
async function warmDesktop() {
  let roles = {}; try { roles = JSON.parse(fs.readFileSync(ROLES, "utf8")); } catch { return; }
  const ids = Object.entries(roles).filter(([, r]) => r.kind === "desktop" && r.desktop_id);
  if (!ids.length) return;
  let have = {}; try { have = (await deskCall("GetAllCascadeTrajectories", {})).data.trajectorySummaries ?? {}; } catch { return; }
  for (const [name, r] of ids) {
    if (have[r.desktop_id]) continue;
    try { await deskCall("GetCascadeTrajectory", { cascadeId: r.desktop_id }); log(`加载 ${name} 的桌面对话`); } catch (e) { log(`${name} 的桌面对话加载失败：${e.message.slice(0, 80)}`); }
  }
}

function sync() {
  warmDesktop().catch(() => {});
  healthTick(log).catch(() => {});   // 反重力对话撑爆了自动换新对话；快撑爆了预警（health.mjs）
  const want = new Set(wanted());
  for (const n of want) if (!kids.has(n)) start(n);
  for (const [n, p] of kids) if (!want.has(n)) { kids.delete(n); p.kill("SIGTERM"); log(`${n} 已不在名册，停掉`); }
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { for (const p of kids.values()) p.kill("SIGTERM"); process.exit(0); });
sync();
setInterval(sync, 30_000);
