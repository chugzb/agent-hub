// Foreground supervisor for a hidden Windows logon task. No registration or settings writes here.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOME, DIR, alive } from "./bin/hub-lib.mjs";
import { archiveInbox } from "./windows-inbox-archive.mjs";
import { windowsHealth } from "./windows-health.mjs";
fs.mkdirSync(DIR,{recursive:true});
const stateFile=path.join(DIR,"services.json"), lock=path.join(DIR,".services.lock");
if(fs.existsSync(lock)) {
  let owner;try{owner=JSON.parse(fs.readFileSync(lock,"utf8"));}catch{}
  if(!owner?.pid || alive(owner.pid))throw new Error("常驻锁已占用，未启动第二份");
  fs.unlinkSync(lock);
}
fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:"wx"});
let board, timer, exiting=false, lastArchive=0;
function cleanup() {
  if(exiting)return;exiting=true;clearInterval(timer);
  if(board&&!board.killed)board.kill();
  try{if(JSON.parse(fs.readFileSync(lock,"utf8")).pid===process.pid)fs.unlinkSync(lock);}catch{}
  try{if(JSON.parse(fs.readFileSync(stateFile,"utf8")).pid===process.pid)fs.unlinkSync(stateFile);}catch{}
}
process.on("exit",cleanup);
for(const sig of ["SIGINT","SIGTERM"])process.on(sig,()=>{cleanup();process.exit(0);});
board=spawn(process.execPath,[fileURLToPath(new URL("./board.mjs",import.meta.url))],{windowsHide:true,stdio:"inherit",env:{...process.env,HUB_HOME:HOME}});
board.on("error",()=>{cleanup();process.exitCode=1;});
board.on("exit",()=>{if(!exiting){cleanup();process.exitCode=1;}});
fs.writeFileSync(stateFile,JSON.stringify({pid:process.pid,boardPid:board.pid,root:fileURLToPath(new URL(".",import.meta.url)),home:HOME,archivePaused:process.env.HUB_ARCHIVE_PAUSED==="1",at:Date.now()}));
function tick() {
  try {
    fs.writeFileSync(path.join(DIR,"windows-health.json"),JSON.stringify({at:Date.now(),workers:windowsHealth()}));
    // Old MCP clients must reconnect before archive resumes after switching installations.
    if(process.env.HUB_ARCHIVE_PAUSED!=="1" && Date.now()-lastArchive>=3600000) { const r=archiveInbox(DIR); lastArchive=Date.now(); if(r.archived)console.log(`归档 ${r.archived} 条`); }
  }catch{console.error("维护检查失败，请运行 doctor（未打印消息内容）");}
}
tick();timer=setInterval(tick,30000);
