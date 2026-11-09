// All staged inbox writers and cursor readers share this short, synchronous critical section.
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
const pause = new Int32Array(new SharedArrayBuffer(4));
const held = new Set();
export function withInboxLock(dir, fn) {
  const file = path.join(dir, ".inbox-write.lock");
  if (held.has(file)) return fn();
  fs.mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + 10000;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(file, "wx"); fs.writeSync(fd, String(process.pid)); }
    catch (e) {
      // Windows can report a sharing violation while a closed lock is being deleted.
      if (!["EEXIST", "EPERM", "EACCES"].includes(e.code)) throw e;
      try {
        const pid = Number(fs.readFileSync(file, "utf8"));
        if (pid > 0) {
          try { process.kill(pid, 0); } catch (x) { if (x.code === "ESRCH") { fs.unlinkSync(file); continue; } }
        }
      } catch {}
      if (Date.now() > deadline) throw new Error("收件箱正忙，稍后重试（未修改数据）");
      Atomics.wait(pause, 0, 0, 20);
    }
  }
  held.add(file);
  try { recoverArchive(dir); return fn(); }
  finally { held.delete(file); fs.closeSync(fd); fs.unlinkSync(file); }
}

export const digest = (s) => createHash("sha256").update(s).digest("hex");
function recoverArchive(dir) {
  const journal=path.join(dir,".inbox-archive-transaction.json");
  if(!fs.existsSync(journal))return;
  const t=JSON.parse(fs.readFileSync(journal,"utf8"));
  const current=digest(fs.readFileSync(path.join(dir,"inbox.jsonl")));
  if(current===t.after) {
    for(const c of t.cursors) {
      if(path.basename(c.name)!==c.name || !c.name.endsWith(".json"))throw new Error("归档恢复记录无效");
      const file=path.join(dir,"cursors",c.name), tmp=file+`.recover-${process.pid}`;
      fs.writeFileSync(tmp,JSON.stringify(c.value));fs.renameSync(tmp,file);
    }
  } else if(current!==t.before) throw new Error("归档恢复遇到收件箱变更，请主控核对（未覆盖数据）");
  fs.unlinkSync(journal);
}
