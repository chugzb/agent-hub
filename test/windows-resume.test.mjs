import { test as nodeTest } from 'node:test';
const test = (name, fn) => nodeTest(name, {skip: process.platform !== 'win32'}, fn);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
function fixture(kind='codex', extra={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'hub-resume-win-'));
  const dir=path.join(home,'job'), bin=path.join(home,'fake-bin');
  for(const d of [dir,bin,path.join(home,'.config/agy-team')])fs.mkdirSync(d,{recursive:true});
  fs.writeFileSync(path.join(home,'.config/agy-team/roles.json'),JSON.stringify({fixture:{kind,model:'fixture-model',...extra}}));
  fs.writeFileSync(path.join(dir,'PROMPT.md'),'fixture task');
  const script=`import fs from 'node:fs';import assert from 'node:assert/strict';
const a=process.argv.slice(2),kind=process.env.FIXTURE_KIND;
let calls=[];try{calls=JSON.parse(fs.readFileSync('calls.json'));}catch{}
calls.push(a);fs.writeFileSync('calls.json',JSON.stringify(calls));
const n=calls.length;
if(kind==='codex'){
fs.readFileSync(0,'utf8');
assert.ok(a.includes('--dangerously-bypass-approvals-and-sandbox'));
assert.ok(a.includes('sandbox_mode=danger-full-access'));assert.ok(!a.includes('-s'));
if(n>1){assert.equal(a[1],'resume');assert.ok(a.includes('fixture-session'));assert.ok(!a.includes('-C'));}
if(process.env.FIXTURE_NO_SESSION!=='1')console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
}else{
if(n>1){assert.equal(a[a.indexOf('--resume')+1],'fixture-session');}
console.log(JSON.stringify({type:'system',session_id:'fixture-session'}));
}
const unfinished=process.env.FIXTURE_NEVER==='1'||n===1;
const text=unfinished?'Waiting for the background task. Will continue once it finishes.':'Done.';
if(kind==='codex')fs.writeFileSync(a[a.indexOf('-o')+1],text);
else console.log(JSON.stringify({type:'result',result:text}));
if(process.env.FIXTURE_HELP==='1'){
fs.mkdirSync(process.env.HUB_DIR,{recursive:true});
fs.appendFileSync(process.env.HUB_DIR+'/inbox.jsonl',JSON.stringify({id:'fixture-help',from:'fixture',to:'主控',type:'help',text:'fixture help'})+'\\n');
}
if(!unfinished)fs.writeFileSync('REPORT.md','fixture finished');`;
  fs.writeFileSync(path.join(bin,'fixture.mjs'),script);
  for(const cmd of ['codex.cmd','cursor.cmd'])fs.writeFileSync(path.join(bin,cmd),`@"${process.execPath}" "%~dp0fixture.mjs" %*\r\n`);
  const env={...process.env,HUB_HOME:home,HOME:home,HUB_DIR:path.join(home,'agy-logs'),HUB_ROLES:path.join(home,'.config/agy-team/roles.json'),HUB_JOBS:path.join(home,'jobs'),FIXTURE_KIND:kind,HUB_CURSOR_CMD:path.join(bin,'cursor.cmd'),PATH:bin+path.delimiter+process.env.PATH};
  return {home,dir,bin,env};
}
async function run(f,script='bin/hub-run.mjs',args=['fixture',f.dir]) {
  const p=spawn(process.execPath,[path.join(ROOT,script),...args],{env:f.env,windowsHide:true});
  let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);
  return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{p.kill();reject(new Error('fixture timeout'));},15000);p.on('error',reject);p.on('exit',code=>{clearTimeout(timer);resolve({code,output});});});
}
function messages(f){return fs.readFileSync(path.join(f.env.HUB_DIR,'inbox.jsonl'),'utf8').trim().split('\n').map(JSON.parse);}
for(const kind of ['codex','cursor'])test(`${kind}: exact session continuation, sandbox/bypass and stream-json done`,async()=>{
  const f=fixture(kind);const r=await run(f);assert.equal(r.code,0,r.output);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'calls.json'))).length,2);
  const rows=messages(f);assert.equal(rows.filter(x=>x.type==='done').length,1);assert.equal(rows.at(-1).status,'ok');
  assert.match(rows.at(-1).text,/fixture finished/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'continuation.json'))).count,1);
});
test('same job resumes at most twice, then help and error done',async()=>{
  const f=fixture();f.env.FIXTURE_NEVER='1';const r=await run(f);assert.equal(r.code,0,r.output);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'calls.json'))).length,3);
  const rows=messages(f);assert.equal(rows.filter(x=>x.type==='help').length,1);assert.equal(rows.at(-1).status,'error');
});
test('missing exact session goes to help, never resumes another session',async()=>{
  const f=fixture();f.env.FIXTURE_NO_SESSION='1';await run(f);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'calls.json'))).length,1);
  assert.equal(messages(f).at(-1).status,'error');assert.equal(messages(f).filter(x=>x.type==='help').length,1);
});
test('employee help suppresses automatic continuation',async()=>{
  const f=fixture();f.env.FIXTURE_HELP='1';await run(f);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'calls.json'))).length,1);
});
test('Kiro: same employee home, UTF-16 log, completion marker prevents another wake',async()=>{
  const f=fixture('kiro');
  const ps=path.join(f.bin,'fake-kiro.ps1');
  fs.writeFileSync(ps,`param($Dir,$Log,$Agent,$HomeDir)
$calls=Join-Path $Dir 'kiro-calls.txt'
Add-Content -LiteralPath $calls -Value $HomeDir
$n=@(Get-Content -LiteralPath $calls).Count
if($n -eq 1){Add-Content -LiteralPath $Log -Encoding Unicode -Value 'Waiting for the background task. Will continue once it finishes.'}
else{Set-Content -LiteralPath (Join-Path $Dir 'REPORT.md') -Value 'fixture kiro finished'; Add-Content -LiteralPath $Log -Encoding Unicode -Value 'KIRO_JOB_DONE'}
`);
  f.env.HUB_KIRO_SCRIPT=ps;const r=await run(f);assert.equal(r.code,0,r.output);
  const calls=fs.readFileSync(path.join(f.dir,'kiro-calls.txt'),'utf8').trim().split(/\r?\n/);
  assert.equal(calls.length,2);assert.equal(calls[0],calls[1]);assert.equal(messages(f).at(-1).status,'ok');
});
test('disabled workers refused by CLI and runner without creating a job',async()=>{
  const f=fixture('cursor',{disabled:true,disabledReason:'fixture disabled'});
  assert.equal((await run(f,'bin/agy-send.mjs',['fixture','fixture task'])).code,1);
  assert.equal((await run(f)).code,1);assert.ok(!fs.existsSync(path.join(f.dir,'calls.json')));
});
test('MCP also refuses disabled client workers that bypass agy-send',async()=>{
  const f=fixture('codex-app',{disabled:true});
  const p=spawn(process.execPath,[path.join(ROOT,'server.mjs')],{env:{...f.env,HUB_SIDE:'master'},windowsHide:true});
  let output='';p.stdout.on('data',b=>output+=b);
  const exited=new Promise(resolve=>p.on('exit',resolve));
  p.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'dispatch_task',arguments:{role:'fixture',task:'fixture task'}}})+'\n');
  await exited;
  const reply=JSON.parse(output.trim());assert.ok(reply.error || reply.result?.isError,output);
  assert.ok(!fs.existsSync(path.join(f.env.HUB_DIR,'inbox.jsonl')));
});
