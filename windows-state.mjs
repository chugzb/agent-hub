// Windows roles, job folders, shared inbox, client presence and native Claude session registry.
// Never calls busy(): a board refresh must not clear a dead worker's running record.
import fs from "node:fs";
import path from "node:path";
import { HOME, DIR, INBOX, JOBS, roles, getRun, alive, mtime, readText } from "./bin/hub-lib.mjs";
export const redact = (s) => String(s ?? "").replace(/(?:sk\x2d[\w-]{8,}|gh[pousr]_[\w]{10,}|(?:["']?(?:password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+)/gi, "[已隐藏]");
const read = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f,"utf8").replace(/^\uFEFF/,"")); } catch { return d; } };
const clip = (s,n=400) => redact(s).slice(0,n);
const recent = (t,n=600000) => Number.isFinite(Number(t)) && Date.now()-Number(t)<n;
function latest(role, r) {
  const base = r.jobs || JOBS;
  try { const names=fs.readdirSync(base).filter(x=>x.startsWith(role+"-")&&!x.endsWith("-home")&&fs.statSync(path.join(base,x)).isDirectory()).sort(); return names.length?path.join(base,names.at(-1)):null; } catch {return null;}
}
export function avatar(role, kind) {
  if (/^(cx|cd)/.test(role)) return "codex";
  if (/^(kr|kv)/.test(role)) return "kiro";
  if (/^ds/.test(role)) return "deepseek";
  if (/^cu/.test(role)) return "cursor";
  return ({codex:"codex","codex-app":"codex",kiro:"kiro","claude-ds":"deepseek",cursor:"cursor"})[kind] || "claude";
}
export function windowsAgents() {
  const pending=new Map();
  for(const line of readText(INBOX,400000).split('\n')) {
    try { const m=JSON.parse(line); if(m.type==='help')pending.set(m.from,m.text); else if(m.type==='done')pending.delete(m.from); else if(m.type==='reply'||m.type==='task')pending.delete(m.to); } catch {}
  }
  return Object.entries(roles()).filter(([,r])=>!r.disabled).map(([id,r])=> {
    const run=getRun(id), live=run && alive(run.pid);
    const pres=read(path.join(DIR,"presence",encodeURIComponent(id)+".json"),{});
    const dir=live?run.dir:latest(id,r);
    const logAt=dir?Math.max(mtime(path.join(dir,"run.log")),mtime(path.join(dir,"kiro.log"))):0;
    let state="idle", since=run?.start || pres.since, lastMove=logAt;
    if (r.kind==="codex-app") {
      state=pres.state==="waiting" && recent(pres.beat,60000)?"idle":pres.state==="working" && recent(pres.beat,6*3600000)?"working":pres.state==="idle" && recent(pres.beat)?"idle":"offline";
      lastMove=Number(pres.beat)||0;
    } else if (live) state=logAt && Date.now()-Math.max(logAt,run.start||0)>15*60000?"stuck":"working";
    else if (run) state="error";
    const supported=["codex","codex-app","kiro","claude-ds","cursor"].includes(r.kind);
    if (!supported) state="offline";
    const needsHelp=supported && pending.has(id);
    if (needsHelp) state="error";
    let task=live?run.task:pres.task;
    if (dir && !task) task=readText(path.join(dir,"PROMPT.md"),20000).split("## 任务").at(-1)?.trim();
    const report=dir?readText(path.join(dir,"REPORT.md"),6000):"";
    return {name:id,kind:r.kind,avatar:avatar(id,r.kind),windowsMapped:true,tool:({codex:"Codex","codex-app":"Codex",kiro:"Kiro",cursor:"Cursor","claude-ds":"Claude Code"})[r.kind]||r.kind,
      model:r.model||r.agent||"",group:r.group||({codex:"Codex","codex-app":"Codex",kiro:"Kiro",cursor:"Cursor","claude-ds":"DeepSeek"})[r.kind]||"",state,since,lastMove,where:clip(dir),doing:clip(needsHelp?pending.get(id):state==="error"?"上次任务进程已退出，请核对报告":task,600),said:clip(report,1200)};
  });
}
export function claudeAgents() {
  const dir=path.join(HOME,".claude","sessions");
  let files;try{files=fs.readdirSync(dir).filter(x=>x.endsWith(".json"));}catch{return [];}
  return files.flatMap(f=>{
    const d=read(path.join(dir,f));
    if(!d?.pid || !alive(d.pid) || d.entrypoint==="agent-hub-peer-bridge" || d["agent-hub-bridge"])return [];
    if(d.pidDomain && !d.pidDomain.toLowerCase().startsWith("win32:"))return [];
    const t=Number(d.statusUpdatedAt)||Number(d.updatedAt)||mtime(path.join(dir,f));
    const state=d.status==="busy"?(Date.now()-t>15*60000?"stuck":"working"):"idle";
    return [{name:clip(d.name||`Claude ${d.pid}`),avatar:"claude",windowsMapped:true,kind:"Claude Code",tool:"Claude Code",model:"Claude",state,since:t,lastMove:t,where:clip(d.cwd)}];
  });
}
