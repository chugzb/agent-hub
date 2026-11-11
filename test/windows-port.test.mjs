import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const test = (name, fn) => nodeTest(name, { skip: process.platform !== 'win32' }, fn);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent hub public-'));
  const dir = path.join(home, 'agy-logs');
  const roles = path.join(home, '.config', 'agy-team', 'roles.json');
  fs.mkdirSync(path.dirname(roles), {recursive: true});
  fs.mkdirSync(dir, {recursive: true});
  return {home, dir, roles, env: {...process.env, HUB_HOME: home, HOME: home,
    HUB_DIR: dir, HUB_ROLES: roles, HUB_JOBS: path.join(home, 'jobs')}};
}
function node(f, script, args = []) {
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000});
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
}

test('Windows installation uses a temporary home and preserves existing roles', () => {
  const f = fixture();
  node(f, 'cli.mjs', ['install', '--home', f.home]);
  const dest = path.join(f.home, '.local', 'share', 'agent-hub');
  assert.ok(fs.existsSync(path.join(dest, 'bin', 'hub-bridge.mjs')));
  assert.ok(!fs.existsSync(path.join(dest, '.git')));
  assert.ok(!fs.existsSync(path.join(dest, 'test')));
  const roles = JSON.parse(fs.readFileSync(f.roles, 'utf8'));
  assert.deepEqual(new Set(Object.values(roles).map(r => r.kind)), new Set(['codex','kiro','cursor','claude-ds','codex-app']));
  fs.writeFileSync(f.roles, '{"custom":{"kind":"codex-app"}}');
  node(f, 'cli.mjs', ['install', '--home', f.home]);
  assert.equal(fs.readFileSync(f.roles, 'utf8'), '{"custom":{"kind":"codex-app"}}');
  assert.ok(!fs.existsSync(path.join(f.dir, 'services.json')));
});

test('optional dispatch preamble and generic job defaults work with spaces in home', async () => {
  const f = fixture();
  delete f.env.HUB_JOBS;
  const bin = path.join(f.home, 'fake-bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'fixture.mjs'), `import fs from 'node:fs';fs.readFileSync(0,'utf8');fs.writeFileSync('REPORT.md','fixture completed');const a=process.argv;fs.writeFileSync(a[a.indexOf('-o')+1],'Done.');`);
  fs.writeFileSync(path.join(bin, 'codex.cmd'), `@"${process.execPath}" "%~dp0fixture.mjs" %*\r\n`);
  f.env.PATH = bin + path.delimiter + process.env.PATH;
  fs.writeFileSync(f.roles, '{"worker1":{"kind":"codex","model":"fixture-model"}}');
  const preamble = path.join(f.home, 'team rules.md'); fs.writeFileSync(preamble, '\uFEFFFixture public team rule.');
  f.env.HUB_PREAMBLE_FILE = preamble;
  node(f, 'bin/agy-send.mjs', ['worker1', 'fixture task']);
  const jobs = path.join(f.home, '.local', 'share', 'agent-hub', 'jobs');
  const job = path.join(jobs, fs.readdirSync(jobs)[0]);
  assert.match(fs.readFileSync(path.join(job, 'PROMPT.md'), 'utf8'), /^\uFEFFFixture public team rule\./);
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(path.join(f.dir, 'inbox.jsonl'))) {
      const rows = fs.readFileSync(path.join(f.dir, 'inbox.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      if (rows.some(r => r.type === 'done')) { assert.equal(rows.at(-1).status, 'ok'); return; }
    }
    await wait(100);
  }
  assert.fail('fixture CLI did not finish');
});

test('Startup installation only writes three shortcuts into the requested folder', () => {
  const f = fixture(), startup = path.join(f.home, 'startup');
  const r = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'install-startup.ps1'),'-HomeDir',f.home,'-StartupDir',startup], {env:f.env, encoding:'utf8', windowsHide:true, timeout:15000});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(startup).sort(), ['agent-hub-bridge.lnk','agent-hub-float.lnk','agent-hub-services.lnk']);
  assert.ok(!fs.existsSync(path.join(f.dir, 'services.json')));
  assert.ok(!fs.existsSync(path.join(f.dir, '.hub-bridge.lock')));
});

test('archive pause marker is respected and removing it resumes archiving', async () => {
  const f = fixture();
  const {archiveInbox} = await import('../windows-inbox-archive.mjs');
  fs.writeFileSync(path.join(f.dir,'inbox.jsonl'), JSON.stringify({at:Date.now()-40*86400000,text:'fixture old'})+'\n');
  const marker = path.join(f.dir,'ARCHIVE_PAUSED'); fs.writeFileSync(marker, '');
  assert.equal(archiveInbox(f.dir, {force:true}).skipped, 'paused');
  fs.unlinkSync(marker);
  assert.equal(archiveInbox(f.dir, {force:true}).archived, 1);
});

test('DeepSeek child config and streaming redaction remain isolated', async () => {
  const f = fixture();
  const {createDeepSeekEnv, redactingStream} = await import('../bin/hub-claude-ds.mjs');
  const value = crypto.randomBytes(24).toString('hex');
  const keyFile = path.join(f.home, 'fixture.env'); fs.writeFileSync(keyFile, 'DEEPSEEK_API_KEY='+value);
  const parentEnv = {ANTHROPIC_BASE_URL:'https://fixture.invalid', ANTHROPIC_AUTH_TOKEN:'fixture-old', CLAUDE_CODE_OAUTH_TOKEN:'fixture-oauth'};
  const before = {...parentEnv};
  const env = createDeepSeekEnv({parentEnv,keyFile,configDir:path.join(f.home,'config'),model:'flash'});
  assert.deepEqual(parentEnv,before);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN,value);
  assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in env));
  const stream = redactingStream(value); let output = '';
  stream.on('data', d => output += d); const ended = once(stream,'end');
  stream.write('fixture '+value.slice(0,12)); stream.end(value.slice(12)+' end'); await ended;
  assert.ok(!output.includes(value)); assert.match(output,/\[REDACTED\]/);
});

test('native bridge registers, authenticates, routes replies and withdraws disabled roles', async t => {
  const f = fixture();
  fs.writeFileSync(f.roles, '{"worker1":{"kind":"codex"}}');
  const sessions = path.join(f.home,'.claude','sessions'); fs.mkdirSync(sessions,{recursive:true});
  const sock = '\\\\.\\pipe\\LOCAL\\agenthub-fixture-'+crypto.randomUUID();
  let got = '';
  const server = net.createServer(c => c.on('data', d => got += d));
  server.listen(sock); await once(server,'listening'); t.after(() => server.close());
  fs.writeFileSync(path.join(sessions,process.pid+'.json'),JSON.stringify({pid:process.pid,name:'Fixture Master',messagingSocketPath:sock,updatedAt:Date.now(),version:'2.1.319'}));
  f.env.HUB_MASTER_SESSION = '^Fixture Master$';
  const child = spawn(process.execPath,[path.join(ROOT,'bin/hub-bridge.mjs')],{env:f.env,windowsHide:true,stdio:'ignore'});
  let reg, regFile;
  t.after(async () => {
    if (child.exitCode === null) { const stopped = once(child,'exit'); child.kill(); await stopped; }
    if (reg?.pid) { try { process.kill(reg.pid); } catch {} }
  });
  for(let i=0;i<100;i++) {
    for(const name of fs.readdirSync(sessions).filter(n=>/^\d+\.json$/.test(n))) {
      const d=JSON.parse(fs.readFileSync(path.join(sessions,name),'utf8'));
      if(d['agent-hub-bridge']) {reg=d;regFile=path.join(sessions,name);}
    }
    if(reg)break; await wait(100);
  }
  assert.ok(reg,'temporary native registration should appear');
  assert.match(reg.procStart,/^\d+$/); assert.equal(reg.name,'worker1');
  const keyName = fs.readdirSync(sessions).find(n=>n.startsWith(reg.pid+'.')&&n.endsWith('.key'));
  const key = JSON.parse(fs.readFileSync(path.join(sessions,keyName),'utf8'));
  const c=net.createConnection(reg.messagingSocketPath); await once(c,'connect');
  c.end(JSON.stringify({type:'auth',token:key.peerToken})+'\n'+JSON.stringify({type:'user',message:{content:'<cross-session-message from="uds:'+sock+'" from-name="Fixture Peer">\nfixture inbox message\n</cross-session-message>'}})+'\n');
  for(let i=0;i<50&&!fs.existsSync(path.join(f.dir,'inbox.jsonl'));i++) await wait(100);
  assert.match(fs.readFileSync(path.join(f.dir,'inbox.jsonl'),'utf8'),/fixture inbox message/);
  node(f,'bin/agy-reply.mjs',['worker1','progress','fixture outgoing reply']);
  for(let i=0;i<50&&!got.includes('fixture outgoing reply');i++)await wait(100);
  assert.match(got,/fixture outgoing reply/);
  fs.writeFileSync(f.roles,'{"worker1":{"kind":"codex","disabled":true}}');
  for(let i=0;i<350&&fs.existsSync(regFile);i++)await wait(100);
  assert.ok(!fs.existsSync(regFile),'disabled role must withdraw its registration');
  assert.ok(fs.existsSync(path.join(sessions,process.pid+'.json')),'real session file is preserved');
});
