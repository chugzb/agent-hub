import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {quotaReason,classifyAgent,teamState,providerFailures} from '../team-state.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
test('four provider failures have explicit quota/login reasons, ordinary logs do not',()=>{
  assert.equal(quotaReason('UsageLimitReached: usage limit reached','kiro'),'额度已用完');
  assert.equal(quotaReason('HTTP 402 insufficient balance','claude-ds'),'余额不足');
  assert.equal(quotaReason('You are not logged in. Authentication required.','cursor'),'登录已失效');
  assert.equal(quotaReason('You have hit your usage limit.','codex'),'额度已用完');
  assert.equal(quotaReason('Searching files, completed three tasks'),'');
});
test('later success clears earlier quota, transient rate throttling is not exhausted balance',()=>{
  assert.equal(quotaReason('UsageLimitReached\nKIRO_JOB_DONE\n'),'');
  assert.equal(quotaReason('insufficient_quota\n'+JSON.stringify({type:'turn.completed'})),'');
  assert.equal(quotaReason('HTTP 402\n'+JSON.stringify({type:'result',is_error:true,result:'insufficient balance'})),'余额不足');
  assert.equal(quotaReason('ClientThrottleError: retry in 90 seconds'),'');
});
test('four groups are exclusive, only active/help/quota rows shown',()=>{
  const agents=[{name:'w',state:'working'},{name:'h',state:'error'},{name:'s',state:'stuck'},{name:'i',state:'idle'},{name:'o',state:'offline'}];
  const s=teamState(agents,1000);assert.deepEqual(s.counts,{working:1,attention:2,quota:0,idle:2});
  assert.equal(s.summary,'在干活 1 · 要处理 2 · 没额度 0 · 歇着 2');assert.equal(s.rows.length,3);
  assert.equal(s.all[0].elapsed,'—','missing start time is unknown, not a fabricated recent start');
  assert.equal(classifyAgent({state:'working'},'UsageLimitReached').group,'quota');
});
test('quoted code, tool output, assistant text and successful results are not provider failures',()=>{
  for(const log of [
    "const fixture = 'UsageLimitReached';",
    "这次测试包括 Kiro UsageLimitReached 和 DeepSeek HTTP 402。",
    JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'UsageLimitReached'}}),
    JSON.stringify({type:'result',is_error:false,result:'测试 HTTP 402 已完成。'}),
    JSON.stringify({type:'assistant',message:{content:[{text:'insufficient_quota'}]}}),
  ]){assert.equal(providerFailures(log),'');assert.equal(classifyAgent({state:'working'},log).group,'working');}
});
test('real provider error envelopes and standalone diagnostics remain visible',()=>{
  for(const log of [
    JSON.stringify({type:'turn.failed',error:{message:"You've hit your usage limit."}}),
    JSON.stringify({type:'result',is_error:true,result:'API Error: 402 insufficient balance'}),
    JSON.stringify({type:'error',message:'Unauthorized'}),
    'kiro-cli.exe : Error: UsageLimitReached',
    'Error: You are not logged in.',
  ])assert.equal(classifyAgent({state:'idle'},log).group,'quota',log);
});
test('Windows UTF-16 Kiro log participates in the same summary',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quota-utf16-'));
  fs.writeFileSync(path.join(dir,'kiro.log'),'\ufeffUsageLimitReached','utf16le');
  const s=teamState([{name:'kr1',kind:'kiro',windowsMapped:true,where:dir,state:'idle'}]);
  assert.equal(s.counts.quota,1);assert.equal(s.rows[0].tool,'Kiro');
});
test('newest job, disabled tail, CLI and HTTP share exactly the same counts',{skip: process.platform !== 'win32'},async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'team-state-fixture-'));
  for(const sub of ['.config/agy-team','agy-logs','jobs'])fs.mkdirSync(path.join(home,sub),{recursive:true});
  const roles={kr1:{kind:'kiro'},cx1:{kind:'codex'},cu1:{kind:'cursor'},off1:{kind:'codex',disabled:true,disabledReason:'fixture disabled'}};
  fs.writeFileSync(path.join(home,'.config/agy-team/roles.json'),JSON.stringify(roles));
  for(const [role,stamp,text] of [['kr1','0001','UsageLimitReached'],['kr1','0002','KIRO_JOB_DONE'],['cx1','0001','insufficient_quota'],['cu1','0001','not logged in']]){
    const dir=path.join(home,'jobs',role+'-'+stamp);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'run.log'),text);
  }
  const env={...process.env,HUB_HOME:home,HOME:home,HUB_DIR:path.join(home,'agy-logs'),HUB_ROLES:path.join(home,'.config/agy-team/roles.json'),HUB_JOBS:path.join(home,'jobs')};
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const p=spawn(process.execPath,[path.join(ROOT,'board.mjs'),String(port)],{env,windowsHide:true,stdio:'ignore'});t.after(()=>p.kill());
  let state;for(let i=0;i<50;i++){try{state=await(await fetch(`http://127.0.0.1:${port}/api/float`)).json();break;}catch{await new Promise(r=>setTimeout(r,50));}}
  assert.deepEqual(state.counts,{working:0,attention:0,quota:2,idle:1});assert.equal(state.rows.length,2);
  assert.equal((await fetch(`http://127.0.0.1:${port}/float`)).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/float`,{headers:{origin:'https://fixture.invalid'}})).status,403);
  const cli=spawn(process.execPath,[path.join(ROOT,'bin/agy-agents.mjs')],{env,windowsHide:true});let output='';cli.stdout.on('data',b=>output+=b);await once(cli,'exit');
  assert.equal(output.split(/\r?\n/)[0],state.summary);
  assert.match(output,/\[没额度\] cx1/);assert.match(output,/\[没额度\] cu1/);
  assert.match(output.trim().split(/\r?\n/).at(-1),/\[停用\] off1/);
});
