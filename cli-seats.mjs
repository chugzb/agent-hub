// 反重力命令行员工（agy-run 派的活）在看板上的座位。11-09 用户：写稿、调研直接用 agy 命令行，每个项目、每个员工一个长期会话。
// 数据：
//   会话表 ~/.config/agy-team/cli-sessions.json   {"项目/员工": {dir, conversation, model, log}} —— 每一项一个座位
//   派活总账 ~/agy-logs/cli-runs.jsonl            每单一行 {time, project, role, branch, master, model, pid, task, ...}
//   实时日志 会话表里的 log（stream-json，step_update / result 事件）
//   命令行自己的日志 ~/.gemini/antigravity-cli/log/cli-*.log（里面写着「language server process with pid <pid>」，接口超时、503 重试记在这里）
// 状态：总账里这个座位最后一行的 pid 还活着 → 干活；活着但实时日志 8 分钟没长 → 卡住？；进程没了、最后一轮报错 → 出错（12 小时后不再挂红）；其余歇着
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
export const CLI_REG = path.join(HOME, ".config", "agy-team", "cli-sessions.json");
export const CLI_RUNS = path.join(HOME, "agy-logs", "cli-runs.jsonl");
export const CLI_LOGDIR = path.join(HOME, ".gemini", "antigravity-cli", "log");
export const CLI_STUCK_MIN = 8;
export const CLI_ERROR_SHOW_H = 12;

const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const clip = (s, n = 140) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
const isAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** 文件最后 n 字节，按行切开（第一行可能是半行，丢掉） */
export function tailLines(file, n = 96_000) {
  let st; try { st = fs.statSync(file); } catch { return { lines: [], mtime: 0, size: 0 }; }
  const len = Math.min(st.size, n); const b = Buffer.alloc(len);
  const fd = fs.openSync(file, "r"); fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd);
  const lines = b.toString("utf8").split("\n"); if (len < st.size) lines.shift();
  return { lines: lines.filter((l) => l.trim()), mtime: st.mtimeMs, size: st.size };
}

/** 总账里每个「项目/员工」最后一行 */
export function lastRuns(file = CLI_RUNS) {
  const m = new Map();
  let text = ""; try { text = fs.readFileSync(file, "utf8"); } catch { return m; }
  for (const l of text.split("\n")) { if (!l.trim()) continue; try { const r = JSON.parse(l); m.set(`${r.project}/${r.role}`, r); } catch {} }
  return m;
}

// 「2026-11-08 23:57」按本机时间
export const runStart = (t) => { const x = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(String(t || "")); return x ? new Date(+x[1], +x[2] - 1, +x[3], +x[4], +x[5]).getTime() : 0; };

const TOOL_SAY = { run_command: "在跑命令", write_to_file: "在写文件", replace_file_content: "在改文件", multi_replace_file_content: "在改文件", view_file: "在看文件",
  view_file_outline: "在看文件", list_dir: "在看目录", find_by_name: "在找文件", grep_search: "在搜内容", read_url_content: "在看网页", search_web: "在搜网页",
  call_mcp_tool: "在调工具", command_status: "在等命令跑完", browser_subagent: "在用浏览器", invoke_subagent: "在派子任务", generate_image: "在出图" };

/** 一个 step_update 写成一句人话 */
export function describeStep(su) {
  if (!su) return "";
  if (su.step_type === "tool") {
    const name = su.tool_name || su.tool_info?.name || "工具";
    const p = su.tool_info?.parameters || {};
    const arg = p.CommandLine || p.TargetFile || p.AbsolutePath || p.SearchPath || p.DirectoryPath || p.Query || p.Url || p.SearchDirectory || "";
    const say = TOOL_SAY[name] || `在用 ${name}`;
    return arg ? `${say}：${clip(String(arg).replace(HOME, "~"), 90)}` : say;
  }
  if (su.step_type === "agent_response") return "在想 / 回话";
  if (su.step_type === "error_message") return "接口报错，在重试";
  if (su.step_type === "user_input") return "收到任务";
  return "";
}

/** 实时日志里：最后一个 step_update、最后一个 result（只看本轮开始以后的） */
export function readStreamLog(file) {
  const { lines, mtime, size } = tailLines(file);
  let step = null, result = null;
  for (const l of lines.slice().reverse()) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (!step && e.event === "step_update") step = e.step_update;
    if (!result && e.event === "result") result = e.result;
    if (e.event === "init") break;   // 本轮开头；再往前是上一轮
    if (step && result) break;
  }
  return { step, result, mtime, size };
}

/** 这一轮算不算成功。11-09：result.error 会粘在会话上（上一轮 Flash 503 之后，换 Argon 正常回完，result 仍是 ERROR + 旧报错），
 *  所以只要本轮最后一步是做完的 agent_response 就算成功 */
export function roundOk(result, lastStep) {
  if (!result) return false;
  if (result.status === "SUCCESS" || result.status === "OK") return true;
  return lastStep?.step_type === "agent_response" && lastStep?.state === "DONE";
}

/** 命令行日志里这个 pid 最近一次重试原因（503 没容量、stream idle timeout） */
export function cliRetryNote(pid, dir = CLI_LOGDIR) {
  if (!pid) return "";
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.startsWith("cli-") && f.endsWith(".log")).map((f) => path.join(dir, f)); } catch { return ""; }
  files = files.map((f) => { try { return [f, fs.statSync(f).mtimeMs]; } catch { return [f, 0]; } }).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([f]) => f);
  for (const f of files) {
    let head = ""; try { const fd = fs.openSync(f, "r"); const b = Buffer.alloc(4096); const n = fs.readSync(fd, b, 0, 4096, 0); fs.closeSync(fd); head = b.toString("utf8", 0, n); } catch { continue; }
    if (!new RegExp(`with pid ${pid}\\b`).test(head)) continue;
    for (const l of tailLines(f, 24_000).lines.reverse()) {
      if (/idle timeout/.test(l)) return "接口 5 分钟没回，超时重试中";
      const m = /attempt (\d+) failed \((.*)\),? retrying/.exec(l) || /attempt (\d+) failed \((.*)\)/.exec(l);
      if (m) return /No capacity/i.test(m[2]) ? `模型没容量（503），第 ${m[1]} 次重试` : `接口出错，第 ${m[1]} 次重试：${clip(m[2], 60)}`;
    }
    return "";
  }
  return "";
}

/** 接口报错写成一句中文 */
export function errorSay(e) {
  const t = String(e || "");
  if (/No capacity|high traffic|\b503\b/i.test(t)) return "模型没容量（503），稍后再派";
  if (/idle timeout/i.test(t)) return "接口 5 分钟没回，超时";
  if (/quota|RESOURCE_EXHAUSTED|\b429\b/i.test(t)) return "额度用完或限流（429）";
  return clip(t, 80);
}

/** 看板座位。deps 只给测试用 */
export function cliSeats({ reg = CLI_REG, runs = CLI_RUNS, logDir = CLI_LOGDIR, now = Date.now(), alive = isAlive } = {}) {
  const sessions = readJson(reg, {}) || {};
  const last = lastRuns(runs);
  const out = [];
  for (const [key, s] of Object.entries(sessions)) {
    const r = last.get(key) || {};
    const model = r.model || s.model || "";
    const log = readStreamLog(s.log || r.log || "");
    const started = runStart(r.time);
    const running = alive(Number(r.pid));
    const lastMove = Math.max(log.mtime || 0, started);
    const task = clip(r.task, 90);
    const seat = { name: key, avatar: /claude|opus|sonnet/i.test(model) ? "claude" : "gemini", kind: `反重力 CLI · ${model}`, tool: "反重力 CLI", model,
      group: "反重力 CLI", since: started || lastMove, lastMove, where: (s.dir || "").replace(HOME, "~"), state: "idle", doing: "", said: "" };
    let stepSay = describeStep(log.step);
    if (running && log.step?.step_type === "error_message") stepSay = cliRetryNote(Number(r.pid), logDir) || stepSay;
    if (running) {
      const quietMin = Math.floor((now - lastMove) / 60_000);
      if (quietMin >= CLI_STUCK_MIN) {
        const note = cliRetryNote(Number(r.pid), logDir);
        seat.state = "stuck";
        seat.doing = `${task || "这一轮"}（日志 ${quietMin} 分钟没增长${note ? `，${note}` : ""}）`;
      } else {
        seat.state = "working";
        seat.doing = r.master ? `${r.master} 派的：${task}` : task;
      }
      seat.said = stepSay ? `最近：${stepSay}` : "";
    } else if (log.result && !roundOk(log.result, log.step) && now - lastMove < CLI_ERROR_SHOW_H * 3600_000 && (log.result.error || log.result.status)) {
      seat.state = "error";
      seat.doing = `这一轮出错停下：${errorSay(log.result.error || log.result.status)}`;
      seat.said = task ? `任务：${task}` : "";
    } else {
      seat.said = log.result?.response ? `上一轮：${clip(log.result.response, 120)}` : task ? `上一单：${task}` : "";
    }
    out.push(seat);
  }
  return out;
}
