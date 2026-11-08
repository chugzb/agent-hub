// 主控侧 MCP 认出「我是哪个 Claude Code 会话」：沿父进程往上找 ~/.claude/sessions/<pid>.json，取里面的 name。
// 三个主控（master-a、master-b、master-c）派活、发消息时 from 写各自的真名，员工回复按 to 名字经 peer-bridge 推回那个会话。
// 找不到就返回 null，调用方退回「主控」这个老名字（读消息时也兼容发给「主控」的旧消息）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MAX_DEPTH = 16;

const psOne = (field, pid) => {
  try { return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).trim(); } catch { return ""; }
};
export const parentOf = (pid) => Number(psOne("ppid", pid)) || 0;
export const argsOf = (pid) => psOne("args", pid);

/** 从 pid 往上数的进程链（含自己），到 1 或循环为止 */
export function ancestors(pid, parent = parentOf) {
  const out = [];
  for (let p = pid; p > 1 && out.length < MAX_DEPTH && !out.includes(p); p = parent(p)) out.push(p);
  return out;
}

/** 进程链上第一个登记了会话名的 Claude Code 会话；peer-bridge 登记的不算（它是员工，不是主控） */
export function findSessionName(chain, { sessDir, args = argsOf } = {}) {
  for (const pid of chain) {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(sessDir, `${pid}.json`), "utf8")); } catch { continue; }
    if (!d?.name || (d.pid && d.pid !== pid)) continue;
    if (args(pid).includes("peer-bridge.mjs")) continue;
    return String(d.name);
  }
  return null;
}

let chain = null;
/** 本进程所属的 Claude Code 会话名；找不到返回 null。进程链只算一次，会话名每次现读（会话中途改名也跟得上） */
export function masterName(opts = {}) {
  const sessDir = opts.sessDir ?? path.join(process.env.HOME || os.homedir(), ".claude", "sessions");
  if (!chain || opts.pid) chain = ancestors(opts.pid ?? process.pid, opts.parentOf ?? parentOf);
  return findSessionName(chain, { sessDir, args: opts.args ?? argsOf });
}
