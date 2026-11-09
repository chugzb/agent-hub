// 员工看主控发给自己的新消息：node agy-read.mjs <员工>（跟 MCP 的 read_messages 共用读到哪的记录）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { INBOX, DIR, MASTER } from "./hub-lib.mjs";

const me = process.argv[2];
if (!me) { console.log("用法：agy-read <员工>"); process.exit(1); }
import { withInboxLock } from "../inbox-lock.mjs";
withInboxLock(DIR, () => {
const CURSORS = join(DIR, "cursors");
const cf = join(CURSORS, `${encodeURIComponent(me)}.json`);
let cur = 0;
try { cur = JSON.parse(readFileSync(cf, "utf8")).line ?? 0; } catch { /* 第一次 */ }
const lines = existsSync(INBOX) ? readFileSync(INBOX, "utf8").split("\n") : [];
const mine = [];
lines.forEach((l, i) => {
  if (!l.trim() || i + 1 <= cur) return;
  try { const d = JSON.parse(l); if ((d.to ?? MASTER) === me) mine.push(d); } catch { /* 坏行 */ }
});
mkdirSync(CURSORS, { recursive: true });
let last = cur;
lines.forEach((l, i) => { if (l.trim()) last = Math.max(last, i + 1); });
writeFileSync(cf, JSON.stringify({ line: last }));
console.log(mine.length ? mine.map((m) => `[${m.time}] ${m.from} → ${m.to} · ${m.type}\n${m.text}`).join("\n\n") : "没有新消息");

});
