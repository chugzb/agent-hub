#!/usr/bin/env node
// agent-hub 自检：按反重力和 Claude Code 配置里登记的命令把 MCP 拉起来，逐个工具测一遍
// 测试消息写到临时目录（HUB_DIR），不碰正式收件箱，不花模型额度
// 用法：node doctor.mjs
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { fileURLToPath } from "node:url";
import { HOME } from "./home.mjs";
import { msgTime } from "./windows-inbox-archive.mjs";
import { DIR, ROLES, JOBS, alive } from "./bin/hub-lib.mjs";
const ROOT = fileURLToPath(new URL(".",import.meta.url));
const results = [];
const ok = (side, item, pass, note = "") => results.push({ side, item, pass, note });

function loadConfigs() {
  return ["master","employee"].map(side=>({side:side==="master"?"主控":"员工",command:process.execPath,args:[fileURLToPath(new URL("./server.mjs",import.meta.url))],env:{HUB_SIDE:side}}));
}
function localChecks() {
  ok("Windows","Node 版本",Number(process.versions.node.split(".")[0])>=18,process.version);
  for(const f of ["server.mjs","board.mjs","health.mjs","services.mjs","windows-inbox-archive.mjs"]) {
    const p=spawnSync(process.execPath,["--check",fileURLToPath(new URL(f,import.meta.url))],{windowsHide:true,encoding:"utf8"});
    ok("Windows",f+" 语法",p.status===0);
  }
  let registered={};
  try{registered=JSON.parse(readFileSync(ROLES,"utf8").replace(/^\uFEFF/,""));ok("Windows","员工表可读",Object.keys(registered).length>0,`${Object.keys(registered).length} 名`);}catch{ok("Windows","员工表可读",false,"临时 home 尚未配置员工表");}
  const supported=["codex","codex-app","kiro","claude-ds","cursor"];
  const other=Object.entries(registered).filter(([,r])=>!supported.includes(r.kind));
  ok("Windows","员工类型",true,other.length?`未启用的类型 ${other.length} 名（看板显示不在）`:"5 类 Windows 员工均可保留");
  const inbox=join(DIR,"inbox.jsonl");
  if(!existsSync(inbox))ok("收件箱","收件箱大小",true,"还没有收件箱");
  else {
    const text=readFileSync(inbox,"utf8"),lines=text.split("\n");if(lines.at(-1)==="")lines.pop();
    const times=lines.flatMap(l=>{try{const t=msgTime(JSON.parse(l));return t?[t]:[];}catch{return [];}});
    const oldest=times.length?new Date(Math.min(...times)):null;
    const date=oldest?`${oldest.getFullYear()}-${String(oldest.getMonth()+1).padStart(2,"0")}-${String(oldest.getDate()).padStart(2,"0")}`:"未知";
    ok("收件箱","收件箱大小",true,`${(statSync(inbox).size/1024/1024).toFixed(1)} MB，${lines.length} 行，最老一条 ${date}`);
  }
  ok("文件","看板素材",existsSync(join(ROOT,"board-assets","cut","kiro-working.webp")) && existsSync(join(ROOT,"board.html")));
  if(!process.argv.includes("--no-launchd")&&!process.argv.includes("--no-services")) {
    let st;try{st=JSON.parse(readFileSync(join(DIR,"services.json"),"utf8"));}catch{}
    const live=!!st?.pid && alive(st.pid) && alive(st.boardPid) && resolve(st.root||".")===resolve(ROOT);
    ok("Windows","常驻进程",live?true:process.argv.includes("--require-services")?false:null,live?`PID ${st.pid}`:"尚未启动；尚未注册登录任务");
    const q=spawnSync("schtasks.exe",["/Query","/TN","AgentHubWindows"],{windowsHide:true,encoding:"utf8"});
    // 计划任务需管理员被拒，改用「启动」文件夹快捷方式，两种都算登录自启
    const startup=join(process.env.APPDATA||join(HOME,"AppData","Roaming"),"Microsoft","Windows","Start Menu","Programs","Startup");
    let lnks=[];try{lnks=readdirSync(startup).filter(f=>/^agent-hub.*\.lnk$/i.test(f));}catch{}
    const auto=q.status===0||lnks.length>=2;
    ok("Windows","登录自启",auto?true:process.argv.includes("--require-scheduled-task")?false:null,q.status===0?"计划任务已注册":lnks.length?`启动文件夹 ${lnks.length} 个快捷方式`:"未设置");
    let bl;try{bl=JSON.parse(readFileSync(join(DIR,".hub-bridge.lock"),"utf8"));}catch{}
    const sessDir=join(HOME,".claude","sessions");
    let bridged=0;try{for(const f of readdirSync(sessDir).filter(f=>/^\d+\.json$/.test(f))){try{const d=JSON.parse(readFileSync(join(sessDir,f),"utf8"));if(d["agent-hub-bridge"]&&alive(d.pid))bridged++;}catch{}}}catch{}
    const bridgeLive=!!bl?.pid&&alive(bl.pid);
    ok("Windows","原生桥 hub-bridge",bridgeLive&&bridged>0?true:process.argv.includes("--require-services")?false:null,bridgeLive?`PID ${bl.pid}，${bridged} 个员工已登记为 Claude 会话`:"未运行");
  }
  for(const [name,file,needle] of [["Codex",join(HOME,".codex","config.toml"),"[mcp_servers.agent-hub]"],["Claude Code",join(HOME,".claude.json"),'"agent-hub"']]) {
    const present=existsSync(file)&&readFileSync(file,"utf8").includes(needle);
    ok(name,"MCP 配置登记",present?true:process.argv.includes("--require-registration")?false:null,present?"已登记（只读）":"未登记；doctor 用暂存 server 独立测试，不改配置");
  }
}

// 起一个 MCP 客户端会话：按行收发 JSON-RPC
function session(cfg, dir) {
  const p = spawn(cfg.command, cfg.args ?? [], { env: { ...process.env, ...(cfg.env ?? {}), HUB_DIR: dir }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  p.on("error",()=>{});
  p.stdin.on("error",()=>{});
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
  mkdirSync(HOME,{recursive:true});
  const dir = mkdtempSync(join(HOME, "hub-doctor-"));
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

localChecks();
const cfgs = process.argv.includes("--no-mcp") ? [] : loadConfigs();
for (const c of cfgs) await testSide(c);
const w = (t) => [...t].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (t, n) => t + " ".repeat(Math.max(1, n - w(t)));
for (const r of results) console.log(pad(r.pass ? "通" : r.pass===null ? "待" : "断", 4) + pad(r.side, 14) + pad(r.item, 26) + r.note);
const bad = results.filter((r) => r.pass===false).length;
const pending=results.filter(r=>r.pass===null).length;
console.log(bad ? `\n${bad} 项不通，${pending} 项待启用` : `\n${results.filter(r=>r.pass===true).length} 项通过，${pending} 项待主控切换时启用`);
process.exit(bad ? 1 : 0);
