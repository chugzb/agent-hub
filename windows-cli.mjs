#!/usr/bin/env node
// Windows entrypoint: child commands inherit the isolated home parsed by home.mjs.
import { HOME } from './home.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
const [command,...args]=process.argv.slice(2);
const targets={board:'board.mjs',doctor:'doctor.mjs',health:'windows-health.mjs',services:'services.mjs',agents:'bin/agy-agents.mjs',send:'bin/agy-send.mjs',reply:'bin/agy-reply.mjs',read:'bin/agy-read.mjs',stop:'bin/agy-stop.mjs'};
if(command === 'install') {
  const source = fileURLToPath(new URL('.', import.meta.url));
  const dest = path.join(HOME, '.local', 'share', 'agent-hub');
  if (path.resolve(source) !== path.resolve(dest)) {
    if (path.relative(source, dest).split(path.sep)[0] !== '..') throw new Error('安装目录不能在源代码目录内');
    fs.cpSync(source, dest, { recursive: true, filter: p => !['.git', 'node_modules', 'test'].includes(path.basename(p)) });
  }
  const roles = process.env.HUB_ROLES || path.join(HOME, '.config', 'agy-team', 'roles.json');
  fs.mkdirSync(path.dirname(roles), {recursive: true});
  if (!fs.existsSync(roles)) fs.copyFileSync(path.join(dest, 'windows-roles.example.json'), roles, fs.constants.COPYFILE_EXCL);
  console.log(`已安装到 ${dest}；员工表 ${roles}。运行 node "${path.join(dest, 'cli.mjs')}" services 启动看板，MCP 配置示例见 README。`);
} else if(!targets[command]){
  console.log('用法：node cli.mjs install|board|doctor|health|services|agents|send|reply|read|stop [参数] [--home 目录]');
  process.exitCode=command&&command!=='help'?1:0;
}else{
  const child=spawn(process.execPath,[fileURLToPath(new URL(targets[command],import.meta.url)),...args],{stdio:'inherit',windowsHide:true,env:process.env});
  child.on('error',()=>{console.error('命令未能启动');process.exitCode=1;});
  child.on('exit',code=>process.exitCode=code??1);
  for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>child.kill());
}
