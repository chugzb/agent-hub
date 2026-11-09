import { test as nodeTest } from 'node:test';
const test = (name, fn) => nodeTest(name, {skip: process.platform !== 'win32'}, fn);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { archiveInbox } from '../windows-inbox-archive.mjs';
import { withInboxLock, digest } from '../inbox-lock.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function fixture() {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'windows-hub-'));
  for(const sub of ['agy-logs/running','agy-logs/presence','.config/agy-team','jobs','.claude/sessions','fake-bin'])fs.mkdirSync(path.join(home,sub),{recursive:true});
  const roles={cx1:{kind:'codex',model:'fixture-model'},kr1:{kind:'kiro'},kv1:{kind:'kiro'},cd1:{kind:'codex-app'},ds1:{kind:'claude-ds'},cu1:{kind:'cursor'},unused:{kind:'tmux'}};
  fs.writeFileSync(path.join(home,'.config/agy-team/roles.json'),JSON.stringify(roles));
  const env={...process.env,HOME:home,HUB_HOME:home,HUB_DIR:path.join(home,'agy-logs'),HUB_ROLES:path.join(home,'.config/agy-team/roles.json'),HUB_JOBS:path.join(home,'jobs'),HUB_SIDE:'master'};
  return {home,env,dir:env.HUB_DIR};
}
function mcp(f,side='master') {
  const p=spawn(process.execPath,[path.join(ROOT,'server.mjs'),'--home',f.home],{env:{...f.env,HUB_SIDE:side},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let seq=0,buf='',err='';const pending=new Map();
  p.stderr.on('data',b=>err+=b);
  p.stdout.on('data',b=>{buf+=b;let i;while((i=buf.indexOf('\n'))>=0){const s=buf.slice(0,i);buf=buf.slice(i+1);try{const j=JSON.parse(s);pending.get(j.id)?.(j);}catch{}}});
  const req=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timeout=setTimeout(()=>reject(new Error('MCP timeout '+err)),10000);pending.set(id,j=>{clearTimeout(timeout);pending.delete(id);resolve(j);});p.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  return {p,req,call:async(name,args)=>{const r=await req('tools/call',{name,arguments:args});assert.ok(!r.error && !r.result?.isError,JSON.stringify(r));return r.result.content[0].text;},close:()=>p.stdin.end()};
}
test('隔离 home：看板读取全部员工、Windows Claude 格式、头像、状态和本机访问限制',async t=>{
  const f=fixture();
  const dir=path.join(f.env.HUB_JOBS,'cx1-fixture');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'run.log'),'fixture log');
  fs.writeFileSync(path.join(f.dir,'running/cx1.json'),JSON.stringify({pid:process.pid,dir,start:Date.now(),task:'fixture task'}));
  fs.writeFileSync(path.join(f.dir,'presence/cd1.json'),JSON.stringify({state:'waiting',beat:Date.now()}));
  fs.writeFileSync(path.join(f.dir,'inbox.jsonl'),JSON.stringify({from:'cu1',to:'主控',type:'help',text:'fixture needs review'})+'\n');
  fs.writeFileSync(path.join(f.home,'.claude/sessions/fixture.json'),JSON.stringify({pid:process.pid,pidDomain:'win32:fixture',name:'Fixture Claude',status:'busy',statusUpdatedAt:Date.now(),cwd:f.home,messagingSocketPath:'\\\\.\\pipe\\LOCAL\\cc-msg-fixture'}));
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const p=spawn(process.execPath,[path.join(ROOT,'board.mjs'),String(port),'--home',f.home],{env:f.env,windowsHide:true,stdio:['ignore','pipe','pipe']});t.after(()=>p.kill());
  const url=`http://127.0.0.1:${port}`;
  let res;for(let i=0;i<50;i++){try{res=await fetch(url+'/api/state');break;}catch{await wait(100);}}
  assert.equal(res?.status,200);const d=await res.json();assert.equal(d.agents.length,8);
  const by=Object.fromEntries(d.agents.map(x=>[x.name,x]));
  for(const [id,av]of Object.entries({cx1:'codex',cd1:'codex',kr1:'kiro',kv1:'kiro',ds1:'deepseek',cu1:'cursor','Fixture Claude':'claude'}))assert.equal(by[id].avatar,av);
  assert.equal(by.cx1.state,'working');assert.equal(by.cd1.state,'idle');assert.equal(by.unused.state,'offline');
  assert.equal(by.cu1.state,'error');assert.equal(by.cu1.doing,'fixture needs review');
  const hostileStatus=await new Promise((resolve,reject)=>{const r=http.get(url,{headers:{host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);});
  assert.equal(hostileStatus,403);
  assert.equal((await fetch(url+'/api/state',{headers:{origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await fetch(url+'/api/state',{method:'POST'})).status,405);
  assert.equal((await fetch(url+'/not-found')).status,404);
  assert.equal((await fetch(url+'/assets/cut/kiro-working.webp')).status,200);
  const stream=await fetch(url+'/events');const reader=stream.body.getReader();const chunk=await reader.read();assert.match(new TextDecoder().decode(chunk.value),/^data: /);await reader.cancel();
  assert.ok(fs.existsSync(path.join(f.dir,'running/cx1.json')),'看板只读，不清理 running');
});

test('真 Windows 派活链：假 codex.cmd → hub-run → REPORT → done，全程临时 home',async t=>{
  const f=fixture(),bin=path.join(f.home,'fake-bin');
  fs.writeFileSync(path.join(bin,'fixture.mjs'),`import fs from 'node:fs';import path from 'node:path';fs.readFileSync(0,'utf8');fs.writeFileSync('REPORT.md','fixture task completed');const a=process.argv;const o=a.indexOf('-o');if(o>=0)fs.writeFileSync(a[o+1],'fixture done');console.log('fixture finished');`);
  fs.writeFileSync(path.join(bin,'codex.cmd'),`@"${process.execPath}" "%~dp0fixture.mjs" %*\r\n`);
  f.env.PATH=bin+path.delimiter+process.env.PATH;
  const c=mcp(f);t.after(c.close);
  const init=await c.req('initialize',{});assert.ok(init.result);
  const sent=await c.call('dispatch_task',{role:'cx1',task:'fixture task; no model calls'});assert.match(sent,/已派给/);
  let done;
  for(let i=0;i<100;i++){
    const rows=fs.existsSync(path.join(f.dir,'inbox.jsonl'))?fs.readFileSync(path.join(f.dir,'inbox.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
    done=rows.find(x=>x.type==='done'&&x.from==='cx1');if(done)break;await wait(100);
  }
  assert.ok(done,'收到 done');assert.equal(done.status,'ok');assert.ok(done.dir.startsWith(f.home));assert.match(done.text,/fixture task completed/);
  assert.ok(!fs.existsSync(path.join(f.dir,'running/cx1.json')),'完成后清理自己记录');
  const e=mcp(f,'employee');t.after(e.close);const tools=(await e.req('tools/list',{})).result.tools.map(x=>x.name);assert.ok(!tools.includes('dispatch_task')&&!tools.includes('stop_agent'));
});

test('Codex 客户端的等活、回 done 与防重收',async t=>{
  const f=fixture(),master=mcp(f),worker=mcp(f,'employee');t.after(master.close);t.after(worker.close);
  const pending=worker.call('wait_for_task',{me:'cd1',timeout_seconds:10});await wait(200);
  await master.call('dispatch_task',{role:'cd1',task:'fixture client task'});
  assert.match(await pending,/fixture client task/);
  await worker.call('send_message',{me:'cd1',to:'主控',type:'done',text:'fixture client completed'});
  assert.match(await master.call('read_messages',{me:'主控'}),/fixture client completed/);
  assert.equal(await master.call('read_messages',{me:'主控'}),'没有新消息');
});

test('归档与多个独立写入进程并发：新旧消息总数守恒、游标不漏读',async()=>{
  const f=fixture();fs.mkdirSync(path.join(f.dir,'cursors'));
  const old=JSON.stringify({id:'old',at:Date.now()-40*86400000,to:'cx1',text:'old'});
  fs.writeFileSync(path.join(f.dir,'inbox.jsonl'),old+'\n');fs.writeFileSync(path.join(f.dir,'cursors/cx1.json'),' {"line":1}');
  const code=`import {appendMsg} from ${JSON.stringify(new URL('../bin/hub-lib.mjs',import.meta.url).href)};for(let i=0;i<50;i++)appendMsg('fixture','cx1','note',process.pid+':'+i);`;
  const procs=Array.from({length:4},()=>spawn(process.execPath,['--input-type=module','-e',code],{env:f.env,windowsHide:true,stdio:'ignore'}));
  const endings=procs.map(p=>once(p,'exit'));
  for(let i=0;i<8;i++){archiveInbox(f.dir,{force:true});await wait(20);}
  const exits=await Promise.all(endings);for(const [code]of exits)assert.equal(code,0);
  const lines=fs.readFileSync(path.join(f.dir,'inbox.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length,200);assert.equal(new Set(lines.map(x=>x.text)).size,200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'cursors/cx1.json'))).line,0);
  const archive=fs.readdirSync(path.join(f.dir,'inbox-archive')).flatMap(n=>fs.readFileSync(path.join(f.dir,'inbox-archive',n),'utf8').trim().split('\n'));
  assert.deepEqual(archive,[old]);
});

test('中断恢复：替换 inbox 后尚未换算游标，下一次读写先恢复再继续',()=>{
  const f=fixture();fs.mkdirSync(path.join(f.dir,'cursors'));
  const before='old\nnew\n',after='new\n';
  fs.writeFileSync(path.join(f.dir,'inbox.jsonl'),after);fs.writeFileSync(path.join(f.dir,'cursors/cx1.json'),'{"line":2}');
  fs.writeFileSync(path.join(f.dir,'.inbox-archive-transaction.json'),JSON.stringify({before:digest(before),after:digest(after),cursors:[{name:'cx1.json',value:{line:1}}]}));
  withInboxLock(f.dir,()=>assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'cursors/cx1.json'))).line,1));
  assert.ok(!fs.existsSync(path.join(f.dir,'.inbox-archive-transaction.json')));
});
