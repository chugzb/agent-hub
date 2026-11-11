import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIR, roles, getRun, alive, mtime } from "./bin/hub-lib.mjs";
// The Windows lane observes workers only: no auto-renew, model switch, restart or settings writes.
export function windowsHealth() {
  return Object.entries(roles()).map(([role,r]) => {
    const run=getRun(role), live=run && alive(run.pid);
    const at=run?.dir?Math.max(mtime(path.join(run.dir,"run.log")),mtime(path.join(run.dir,"kiro.log")),run.start||0):0;
    const presence=(()=>{try{return JSON.parse(fs.readFileSync(path.join(DIR,"presence",encodeURIComponent(role)+".json"),"utf8"));}catch{return {};}})();
    const state=r.kind==="codex-app" ? (Date.now()-(presence.beat||0)<60000?"ok":"offline") : run && !live ? "dead" : live && Date.now()-at>15*60000 ? "stale" : "ok";
    return {role,state,pid:run?.pid||null,at};
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(windowsHealth(),null,2));
}
