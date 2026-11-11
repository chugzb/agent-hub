// 停活：node agy-stop.mjs <员工>。只按记录的 PID 杀整棵进程树，绝不按名字或时间批量杀
import { execFileSync } from "node:child_process";
import { getRun, clearRun, alive, appendMsg, roles, MASTER } from "./hub-lib.mjs";

const role = process.argv[2];
if (!role) { console.log("用法：agy-stop <员工>"); process.exit(1); }
if (!roles()[role]) { console.log(`没有员工 ${role}`); process.exit(1); }
const r = getRun(role);
if (!r || !alive(r.pid)) { clearRun(role); console.log(`${role} 没在跑`); process.exit(0); }
try { execFileSync("taskkill", ["/PID", String(r.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 已经退了 */ }
clearRun(role, r.pid);
appendMsg(role, MASTER, "note", `主控停了这单（任务目录 ${r.dir}），做到哪看目录里的 REPORT.md 和日志`, { status: "stopped", dir: r.dir });
console.log(`已停 ${role}（PID ${r.pid}，任务目录 ${r.dir}）`);
