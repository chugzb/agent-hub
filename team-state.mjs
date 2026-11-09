// Shared read-only view for list_agents, /api/float and the native Windows window.
import path from 'node:path';
import { readText } from './bin/hub-lib.mjs';
import { windowsAgents, claudeAgents, redact } from './windows-state.mjs';
export const LABELS={working:'在干活',attention:'要处理',quota:'没额度',idle:'歇着'};
export function providerFailures(text) {
  const events=[];
  // Tool output, source diffs, prompts and assistant prose can quote error fixtures.
  // Only provider error envelopes or a standalone CLI diagnostic are evidence.
  const diagnostic=/^(?:(?:\d{4}-\d{2}-\d{2}[^A-Za-z]*|\[(?:ERROR|WARN)\]|kiro-cli(?:\.exe)?\s*:|(?:Error|ERROR|API Error|ClientError|Caused by)\s*[:：])\s*)*(?:UsageLimitReached\b|insufficient_quota\b|HTTP\s*40[12]\b|(?:You(?:['’]ve| have)\s+)?(?:hit|reached) your.{0,30}usage limit|usage limit (?:reached|exceeded)|quota (?:exceeded|exhausted)|insufficient balance\b|payment required\b|(?:You are )?not logged in\b|authentication required\b|unauthorized\b|session expired\b|余额不足|登录(?:已)?(?:失效|过期))/i;
  for(const line of String(text||'').split('\n')){
    const t=line.trim();
    try{
      const j=JSON.parse(t);
      const failed=j.type==='error'||j.type==='turn.failed'||j.type==='result'&&(j.is_error||j.error||/^error/.test(j.subtype||''));
      if(j.type==='turn.completed'||j.type==='result'&&!failed){events.length=0;continue;}
      if(failed){
        const message=j.error?.message||j.message||j.result||'';
        if(typeof message==='string')events.push(message);
      }
      continue;
    }catch{}
    if(t==='KIRO_JOB_DONE'){events.length=0;continue;}
    if(diagnostic.test(t))events.push(t);
  }
  return events.join('\n');
}
export function quotaReason(text, kind='') {
  const t=String(text||'');
  const rules=[
    [/UsageLimitReached|usage[_ -]?limit[_ -]?(?:reached|exceeded)|hit your usage limit|reached your.{0,30}usage limit|insufficient_quota|quota[_ -]?(?:exceeded|exhausted)|额度(?:已)?(?:用完|耗尽|不足)/i,'额度已用完'],
    [/(?:HTTP\s*402|status["'\s:=]+402\b|\b402\b.{0,50}(?:balance|payment|余额)|insufficient balance|余额不足|Payment Required)/i,'余额不足'],
    [/(?:not logged in|authentication required|login required|unauthenticated|unauthorized|session.{0,12}expired|invalid.{0,12}(?:api.?key|token)|HTTP\s*401|登录(?:已)?(?:失效|过期)|请(?:先)?登录)/i,'登录已失效'],
  ];
  let found=null;
  for(const [regex,reason]of rules){const re=new RegExp(regex.source,'ig');let m;while((m=re.exec(t))!==null)if(!found||m.index>found.index)found={index:m.index,reason};}
  if(!found)return '';
  // Earlier errors in the same job must not override a later confirmed successful turn.
  let offset=0,success=-1;
  for(const line of t.split('\n')){
    if(line.trim()==='KIRO_JOB_DONE')success=offset;
    try{const j=JSON.parse(line);if(j.type==='turn.completed'||j.type==='result'&&!j.is_error&&!j.error&&!rules.some(([r])=>r.test(String(j.result||''))))success=offset;}catch{}
    offset+=line.length+1;
  }
  return success>found.index?'':found.reason;
}
export function classifyAgent(agent, log='') {
  const reason=quotaReason(providerFailures(log),agent.kind);
  if(reason)return {group:'quota',reason};
  if(['error','stuck'].includes(agent.state))return {group:'attention',reason:''};
  return {group:agent.state==='working'?'working':'idle',reason:''};
}
export function teamState(agents=[...windowsAgents(),...claudeAgents()], now=Date.now()) {
  const counts={working:0,attention:0,quota:0,idle:0};
  const all=agents.map(a=>{
    const log=['codex','kiro','cursor','claude-ds'].includes(a.kind) && a.where ? [readText(path.join(a.where,'run.log'),200000),readText(path.join(a.where,'kiro.log'),200000)].join('\n') : '';
    const status=classifyAgent(a,log);counts[status.group]++;
    const tool=({codex:'Codex','codex-app':'Codex',kiro:'Kiro',cursor:'Cursor','claude-ds':'DS'})[a.kind]||'Claude';
    const since=Number(a.since);
    const minutes=Math.max(0,Math.floor((now-since)/60000));
    return {...a,...status,label:LABELS[status.group],tool,doing:redact(status.reason||a.doing||a.said||'').replace(/\s+/g,' ').slice(0,300),elapsed:!(since>0&&since<=now)?'—':minutes?`已干 ${minutes} 分钟`:'已干 刚刚'};
  });
  const order={quota:0,attention:1,working:2,idle:3};
  const rows=all.filter(a=>a.group!=='idle').sort((a,b)=>order[a.group]-order[b.group]||a.name.localeCompare(b.name));
  return {at:now,counts,summary:Object.entries(LABELS).map(([k,v])=>`${v} ${counts[k]}`).join(' · '),rows,all};
}
