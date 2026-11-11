#!/usr/bin/env node
// agent-hub 自检：按反重力和 Claude Code 配置里登记的命令把 MCP 拉起来，逐个工具测一遍
// 测试消息写到临时目录（HUB_DIR），不碰正式收件箱，不花模型额度
// 用法：node doctor.mjs [--no-mcp] [--no-launchd]
//   --no-mcp      不测 MCP（没注册 MCP 的演练环境用）
//   --no-launchd  不查常驻和 4646（没装常驻的演练环境用）
// 没装的员工类型（config.json 里对应路径留空）标「没装，跳过」，不算失败
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS, configPath, readConfig, detectTool, isExe } from "./toolpaths.mjs";


if (process.platform === "win32") {
  await import("./windows-doctor.mjs");
} else {

const HOME = process.env.HOME || homedir();
const NO_MCP = process.argv.includes("--no-mcp");
const NO_LAUNCHD = process.argv.includes("--no-launchd");
const CFG = readConfig(HOME);
// 实际能用的工具路径：config.json 里填了且存在就用它，否则现场找一遍（config.json 还没生成时也不会误报「没装」）
const effective = (t) => (CFG[t] && isExe(CFG[t]) ? CFG[t] : detectTool(t, HOME));
const results = [];
const ok = (side, item, pass, note = "") => results.push({ side, item, pass, note });

function loadConfigs() {
  const out = [];
  if (NO_MCP) { ok("MCP", "MCP 注册与工具", true, "跳过（--no-mcp）"); return out; }
  const agy = join(HOME, ".gemini", "config", "mcp_config.json");
  if (existsSync(agy)) {
    const c = JSON.parse(readFileSync(agy, "utf8")).mcpServers?.["agent-hub"];
    if (c) out.push({ side: "反重力", ...c });
    else ok("反重力", "配置里有 agent-hub", false, agy);
  } else ok("反重力", "配置文件存在", false, agy);
  const cc = join(HOME, ".claude.json");
  if (existsSync(cc)) {
    const c = JSON.parse(readFileSync(cc, "utf8")).mcpServers?.["agent-hub"];
    if (c) out.push({ side: "Claude Code", ...c });
    else ok("Claude Code", "配置里有 agent-hub", false, "~/.claude.json 用户级");
  }
  return out;
}

// 起一个 MCP 客户端会话：按行收发 JSON-RPC
function session(cfg, dir) {
  const p = spawn(cfg.command, cfg.args ?? [], { env: { ...process.env, ...(cfg.env ?? {}), HUB_DIR: dir }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  let buf = "", nextId = 1, stderr = "";
  p.stderr.on("data", (b) => (stderr += b));
  p.stdout.on("data", (b) => {
    buf += b;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); } catch { /* 非 JSON 行 */ }
    }
  });
  const req = (method, params, timeoutMs = 15000) => new Promise((resolve) => {
    const id = nextId++;
    const t = setTimeout(() => { waiting.delete(id); resolve({ timeout: true }); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const raw = (s) => p.stdin.write(s + "\n");
  const call = async (name, args, timeoutMs) => {
    const m = await req("tools/call", { name, arguments: args }, timeoutMs);
    return { text: m.result?.content?.[0]?.text ?? m.error?.message ?? (m.timeout ? "超时" : ""), isError: !!(m.result?.isError || m.error || m.timeout) };
  };
  return { req, notify, raw, call, close: () => p.stdin.end(), proc: p, stderr: () => stderr };
}

async function testSide(cfg) {
  const S = cfg.side;
  const dir = mkdtempSync(join(tmpdir(), "hub-doctor-"));
  const s = session(cfg, dir);
  const t0 = Date.now();
  const init = await s.req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "doctor", version: "1" } });
  ok(S, "能启动、握手", !!init.result, init.result ? `${init.result.serverInfo.name} ${init.result.serverInfo.version}，${Date.now() - t0} ms` : `启动失败：${s.stderr().slice(0, 200) || "没有响应"}`);
  if (!init.result) return s.close();
  s.notify("notifications/initialized", {});
  const tools = (await s.req("tools/list", {})).result?.tools?.map((t) => t.name) ?? [];
  const master = cfg.env?.HUB_SIDE === "master";
  const want = master ? ["list_agents", "send_message", "read_messages", "wait_for_task", "dispatch_task", "stop_agent"] : ["list_agents", "send_message", "read_messages", "wait_for_task"];
  const missing = want.filter((w) => !tools.includes(w));
  const leaked = !master && tools.some((t) => t === "dispatch_task" || t === "stop_agent");
  ok(S, `工具齐全（${master ? "主控" : "员工"}侧）`, !missing.length && !leaked, missing.length ? `缺 ${missing.join("、")}` : leaked ? "员工侧不该看到派活 / 停活" : tools.join("、"));

  const la = await s.call("list_agents", {});
  ok(S, "list_agents 看团队", !la.isError && la.text.includes("员工"), la.text.split("\n")[0].slice(0, 60));

  const me = master ? "主控" : "doctor-a";
  const peer = master ? "doctor-b" : "主控";
  const sm = await s.call("send_message", { me, to: peer, type: "note", text: "自检消息" });
  ok(S, "send_message 发消息", !sm.isError && sm.text.includes("已发给"), sm.text);
  const sm2 = await s.call("send_message", { me: peer, to: me, type: "reply", text: "自检回复" });
  const rm = await s.call("read_messages", { me });
  ok(S, "read_messages 收到回复", rm.text.includes("自检回复"), rm.text.split("\n")[0]);
  const rm2 = await s.call("read_messages", { me });
  ok(S, "读过的不重复", rm2.text === "没有新消息", rm2.text);
  void sm2;

  // 等活：先挂上，2 秒后另一路发 task，看多久返回
  const w0 = Date.now();
  const waitP = s.call("wait_for_task", { me: "doctor-w", timeout_seconds: 20 }, 30000);
  setTimeout(() => s.call("send_message", { me: "主控", to: "doctor-w", type: "note", text: "自检派活" }), 2000);
  const w = await waitP;
  ok(S, "wait_for_task 收到新活", w.text.includes("自检派活"), `${((Date.now() - w0) / 1000).toFixed(1)} 秒返回`);

  // 取消：取消后的那条消息不能被吃掉
  const cId = 999;
  s.raw(JSON.stringify({ jsonrpc: "2.0", id: cId, method: "tools/call", params: { name: "wait_for_task", arguments: { me: "doctor-c", timeout_seconds: 20 } } }));
  await new Promise((r) => setTimeout(r, 500));
  s.notify("notifications/cancelled", { requestId: cId });
  await new Promise((r) => setTimeout(r, 2500));
  await s.call("send_message", { me: "主控", to: "doctor-c", type: "note", text: "取消后到的消息" });
  const rc = await s.call("read_messages", { me: "doctor-c" });
  ok(S, "取消等活不丢消息", rc.text.includes("取消后到的消息"), rc.text.split("\n")[0]);

  const bad1 = await s.call("send_message", { type: "note", text: "x" });
  const bad2 = await s.req("tools/call", { name: "no_such_tool", arguments: {} });
  s.raw("{这不是 JSON");
  const after = await s.call("list_agents", {});
  ok(S, "出错时报清楚、不崩", bad1.isError && !!bad2.error && !after.isError, `缺 me：${bad1.text}；坏 JSON 后仍可用`);
  s.close();
}

// 11-07：ListAgents 联动体检（peer-bridge）
const TESTED_CLAUDE = "2.1.285"; // 会话登记格式在这个版本实测过；版本变了要复测
async function checkPeers() {
  const { readFileSync, readdirSync, existsSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const H = process.env.HOME, S = "联动";
  const sess = `${H}/.claude/sessions`;
  let roles = {}; try { roles = JSON.parse(readFileSync(`${H}/.config/agy-team/roles.json`, "utf8")); } catch {}
  // 员工类型需要的本机工具：没装的类型标「没装，跳过」，不算失败（desktop 靠反重力桌面端本身，不需要命令行）
  const needTool = { codex: "codex", devin: "devin", cursor: "cursor-agent", tmux: "tmux" };
  const have = (kind) => !needTool[kind] || !!effective(needTool[kind]);
  const bridged = [];
  for (const [k, r] of Object.entries(roles)) {
    if (!["desktop", "codex", "devin", "cursor", "tmux"].includes(r.kind)) continue;
    if (have(r.kind)) bridged.push(k);
    else ok(S, `${k} 在 ListAgents 里`, true, `没装，跳过（${r.kind} 没找到，装好后重跑 agent-hub install）`);
  }
  const claudeBin = effective("claude");
  let ver = ""; try { if (claudeBin) ver = execFileSync(claudeBin, ["--version"], { encoding: "utf8" }).trim().split(" ")[0]; } catch {}
  if (!claudeBin) ok(S, "Claude Code 版本", true, "没装，跳过");
  else ok(S, "Claude Code 版本", ver === TESTED_CLAUDE, ver === TESTED_CLAUDE ? ver : `现在 ${ver || "查不到"}，实测过的是 ${TESTED_CLAUDE}：升级了，要复测员工还在不在 ListAgents`);
  let settings = {}; try { settings = JSON.parse(readFileSync(`${H}/.claude/settings.json`, "utf8")); } catch {}
  ok(S, "会话间消息直接送达", settings.crossSessionInbound === "accept", `crossSessionInbound = ${settings.crossSessionInbound ?? "没设（权限模式不同会被扣住）"}`);
  const regs = (existsSync(sess) ? readdirSync(sess) : []).filter((f) => f.endsWith(".json")).map((f) => { try { return JSON.parse(readFileSync(`${sess}/${f}`, "utf8")); } catch { return null; } }).filter(Boolean);
  for (const name of bridged) {
    if (NO_LAUNCHD) { ok(S, `${name} 在 ListAgents 里`, true, "跳过（--no-launchd，没有常驻的桥）"); continue; }
    const r = regs.find((d) => d.name === name && (() => { try { process.kill(d.pid, 0); return true; } catch { return false; } })());
    const sock = r?.messagingSocketPath;
    const key = sock && existsSync(`${sess}/${r.pid}.${createHash("sha256").update(sock).digest("hex")}.key`);
    ok(S, `${name} 在 ListAgents 里`, !!(r && sock && existsSync(sock) && key), r ? `pid ${r.pid}${key ? "" : "，缺 key 文件"}${sock && existsSync(sock) ? "" : "，通道不在"}` : "没登记（看 ~/agy-logs/bridges/" + name + ".log）");
  }
}

// 本机：config.json 里的路径都存在、常驻在跑、看板 4646 能打开
async function checkLocal() {
  const S = "本机";
  const cfgFile = configPath(HOME);
  if (!existsSync(cfgFile)) ok(S, "config.json 存在", false, `${cfgFile} 不存在，跑一次 agent-hub install`);
  else {
    for (const t of TOOLS) {
      const v = CFG[t];
      if (!v) ok(S, `${t} 路径`, t !== "node", t === "node" ? "没填，跑一次 agent-hub install" : "没装，跳过");
      else ok(S, `${t} 路径`, isExe(v), isExe(v) ? v : `${v} 不存在或不可执行`);
    }
  }
  // 桌面悬浮窗：编译不出来（没装命令行工具）算「没装，跳过」，不算失败
  const floatExe = join(HOME, "Applications", "Agent Hub.app", "Contents", "MacOS", "AgentHub");
  ok(S, "桌面悬浮窗", true, existsSync(floatExe) ? `已编译：${join(HOME, "Applications", "Agent Hub.app")}` : "没装，跳过（没有命令行工具时 install 会跳过）");
  if (NO_LAUNCHD) { ok(S, "常驻在跑", true, "跳过（--no-launchd）"); ok(S, "看板 4646 能打开", true, "跳过（--no-launchd）"); return; }
  const { execFileSync } = await import("node:child_process");
  let launch = ""; try { launch = execFileSync("launchctl", ["list"], { encoding: "utf8" }); } catch {}
  const running = (labels) => labels.find((l) => new RegExp(`^\\d+\\s+\\S+\\s+${l.replace(/\./g, "\\.")}$`, "m").test(launch));
  const br = running(["dev.agent-hub.bridges", "dev.agent-hub-legacy-bridges"]);
  const bd = running(["dev.agent-hub.board", "dev.agent-hub-legacy-board"]);
  ok(S, "桥常驻在跑", !!br, br ? `launchd ${br}` : "launchd 里没有在跑的 dev.agent-hub.bridges（agent-hub install 会装）");
  ok(S, "看板常驻在跑", !!bd, bd ? `launchd ${bd}` : "launchd 里没有在跑的 dev.agent-hub.board（agent-hub install 会装）");
  try {
    const r = await fetch("http://127.0.0.1:4646/", { signal: AbortSignal.timeout(3000) });
    ok(S, "看板 4646 能打开", r.ok, `http://127.0.0.1:4646 返回 ${r.status}`);
  } catch (e) { ok(S, "看板 4646 能打开", false, `打不开：${e.cause?.code || e.message}`); }
}

// 收件箱多大、最老一条是哪天：太大的时候能看出来归档有没有在跑（超过 2MB 会在下一次收发时归档）
async function checkInbox() {
  const S = "本机";
  const file = join(HOME, "agy-logs", "inbox.jsonl");   // 正式收件箱，不用 MCP 会话的临时 HUB_DIR
  if (!existsSync(file)) return ok(S, "收件箱大小", true, "还没有收件箱");
  const { statSync, readFileSync } = await import("node:fs");
  const { msgTime, ARCHIVE_AT_BYTES } = await import("./inbox-archive.mjs");
  const size = statSync(file).size;
  let lines;
  try { lines = readFileSync(file, "utf8").split("\n"); } catch (e) { return ok(S, "收件箱大小", false, `读不出来：${file}（${e.code ?? e.message}）`); }
  let oldest = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    try { const t = msgTime(JSON.parse(l)); if (t && (!oldest || t < oldest)) oldest = t; } catch { /* 坏行跳过 */ }
  }
  let day = "看不出时间";
  if (oldest) {
    const d = new Date(oldest);
    day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const rows = lines.filter((l) => l.trim()).length;
  const over = size > ARCHIVE_AT_BYTES;
  ok(S, "收件箱大小", true, `${(size / 1024 / 1024).toFixed(1)} MB（${rows} 行），最老一条 ${day}${over ? "；超过 2MB，下次收发时归档" : ""}`);
}

// 反重力员工的对话有没有撑爆（未清理内容超过 30MB，之后每条消息都发不出去）；快撑爆的只提醒，不算失败
async function checkConversations() {
  const S = "对话";
  let roles = {}; try { roles = JSON.parse(readFileSync(join(HOME, ".config", "agy-team", "roles.json"), "utf8")); } catch {}
  const ds = Object.entries(roles).filter(([, r]) => r.kind === "desktop" && r.desktop_id);
  if (!ds.length) return ok(S, "对话没有撑爆", true, "没有登记桌面会话的员工，跳过");
  const { summaries, inspect } = await import("./desk.mjs");
  const { looksFailed, readHealth } = await import("./health.mjs");
  let sums; try { sums = await summaries(); } catch { return ok(S, "对话没有撑爆", true, "反重力桌面端没在运行，跳过"); }
  const bad = [], big = [];
  for (const [role, r] of ds) {
    const t = sums[r.desktop_id];
    if (!t) continue;
    if (looksFailed(t)) { try { if ((await inspect(r.desktop_id)).overflow) bad.push(role); } catch { /* 读不出来当没事 */ } }
    const h = readHealth(role);
    if (h?.state === "big") big.push(`${role} ${h.mb}MB`);
  }
  ok(S, "对话没有撑爆", !bad.length, bad.length ? `${bad.join("、")} 撑爆了（超过 30MB 上限）：agent-hub renew <员工号> 换新对话` : `${ds.length} 个桌面员工都正常${big.length ? `；快撑爆（上限 30MB）：${big.join("、")}` : ""}`);
}

const cfgs = loadConfigs();
for (const c of cfgs) await testSide(c);
await checkLocal();
await checkInbox();
await checkConversations();
await checkPeers();
const w = (t) => [...t].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (t, n) => t + " ".repeat(Math.max(1, n - w(t)));
for (const r of results) console.log(pad(r.pass ? "通" : "断", 4) + pad(r.side, 14) + pad(r.item, 26) + r.note);
const bad = results.filter((r) => !r.pass).length;
console.log(bad ? `\n${bad} 项不通` : `\n全部 ${results.length} 项都通`);
process.exit(bad ? 1 : 0);

}
