// 收件箱归档：inbox.jsonl 超过 2MB 时，把 30 天前的消息挪进 inbox-archive/YYYY-MM.jsonl。
// 游标（cursors/*.json 里记的是物理行号）要跟着换算，不能让员工重复收或漏收。
// 收件箱用「写临时文件再改名」替换：inode 变了，看板按 inode + 文件大小做的尾部索引会认出来、从头扫。
import fs from "node:fs";
import path from "node:path";

export const ARCHIVE_AT_BYTES = 2 * 1024 * 1024;
export const ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60_000;
export const ARCHIVE_DIRNAME = "inbox-archive";
const LOCK_STALE_MS = 60_000;   // 锁文件超过 1 分钟当上次崩了留下的，接管

const pad = (n) => String(n).padStart(2, "0");

/** 消息的时间戳：口径跟看板补年份一样（只有「11-08 03:16」，按今年补，补出来比现在还晚一天以上就算去年） */
export function msgTime(m, now = Date.now()) {
  for (const k of ["at", "ts", "timestamp"]) {
    const v = m?.[k];
    if (typeof v === "number" && v > 0) return v < 1e12 ? v * 1000 : v;
    if (typeof v === "string" && Date.parse(v)) return Date.parse(v);
  }
  const x = /^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(String(m?.time ?? ""));
  if (!x) return 0;
  const d = new Date(new Date(now).getFullYear(), x[1] - 1, +x[2], +x[3], +x[4]);
  if (d.getTime() - now > 86_400_000) d.setFullYear(d.getFullYear() - 1);
  return d.getTime();
}

const monthOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

/**
 * 分出哪些物理行要挪走（纯函数，行号从 1 开始，跟 readInbox 的 line 一致）。
 * 空行、坏行、没有可信时间的行都留着：宁可占地方，也不能把分不清时间的消息挪错或删掉。
 * 返回 { removed: [{ line, month, text }], kept: [原文] }，kept 保持原顺序。
 */
export function planArchive(lines, { now = Date.now(), olderThanMs = ARCHIVE_AFTER_MS } = {}) {
  const cutoff = now - olderThanMs;
  const removed = [], kept = [];
  lines.forEach((raw, i) => {
    if (!raw.trim()) { kept.push(raw); return; }
    let m; try { m = JSON.parse(raw); } catch { kept.push(raw); return; }
    const t = msgTime(m, now);
    if (!t || t >= cutoff) { kept.push(raw); return; }
    removed.push({ line: i + 1, month: monthOf(t), text: raw });
  });
  return { removed, kept };
}

/** 旧行号换算成归档后的行号：减去「被挪走的、行号不大于它的」行数 */
export function remapLine(line, removed) {
  let moved = 0;
  for (const r of removed) if (r.line <= line) moved++;
  return Math.max(0, line - moved);
}

function acquireLock(dir) {
  const file = path.join(dir, ".inbox-archive.lock");
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      return { file, fd };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let old = false;
      try { old = Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS; } catch { /* 刚被别人删了 */ }
      if (!old) return null;
      try { fs.unlinkSync(file); } catch { return null; }   // 别人也在接管，让它先
    }
  }
  return null;
}

function releaseLock(lock) {
  try { fs.closeSync(lock.fd); } catch { /* 已经关了 */ }
  try { fs.unlinkSync(lock.file); } catch { /* 已经没了 */ }
}

/** 所有游标的行号跟着换算；没变的文件不重写 */
function remapCursors(dir, removed) {
  const cd = path.join(dir, "cursors");
  let files;
  try { files = fs.readdirSync(cd); } catch { return 0; }
  let changed = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const file = path.join(cd, f);
    let cur;
    try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (typeof cur.line !== "number") continue;
    const line = remapLine(cur.line, removed);
    if (line === cur.line) continue;
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...cur, line }));
    fs.renameSync(tmp, file);
    changed++;
  }
  return changed;
}

/**
 * 收件箱超过 maxBytes 就把老消息挪进归档。dir 是收件箱所在目录（正式是 ~/agy-logs，测试用临时目录）。
 * force=true 时不管多大都归档（测试用）。返回做了什么，方便测试和日志：
 *   { skipped: "no-inbox" | "small" | "locked" | "nothing-old" }
 *   { archived, kept, months, cursors }
 */
export function archiveInbox(dir, { now = Date.now(), maxBytes = ARCHIVE_AT_BYTES, olderThanMs = ARCHIVE_AFTER_MS, force = false } = {}) {
  const inbox = path.join(dir, "inbox.jsonl");
  let st;
  try { st = fs.statSync(inbox); } catch { return { skipped: "no-inbox" }; }
  if (!force && st.size <= maxBytes) return { skipped: "small", size: st.size };

  const lock = acquireLock(dir);
  if (!lock) return { skipped: "locked" };
  try {
    let text;
    try { text = fs.readFileSync(inbox, "utf8"); } catch { return { skipped: "no-inbox" }; }
    const { removed, kept } = planArchive(text.split("\n"), { now, olderThanMs });
    if (!removed.length) return { skipped: "nothing-old", size: text.length };

    // 1. 先追加到按月分的归档：这一步成功之后才动收件箱，最坏是归档里多一份，不会丢消息
    const ad = path.join(dir, ARCHIVE_DIRNAME);
    fs.mkdirSync(ad, { recursive: true });
    const byMonth = new Map();
    for (const r of removed) {
      if (!byMonth.has(r.month)) byMonth.set(r.month, []);
      byMonth.get(r.month).push(r.text);
    }
    for (const [month, rows] of byMonth) fs.appendFileSync(path.join(ad, `${month}.jsonl`), rows.join("\n") + "\n");

    // 2. 剩下的写临时文件再改名（inode 变，看板会重新扫）
    const tmp = `${inbox}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, kept.join("\n"));
    fs.renameSync(tmp, inbox);

    // 3. 游标换算到新行号
    const cursors = remapCursors(dir, removed);
    return { archived: removed.length, kept: kept.filter((l) => l.trim()).length, months: [...byMonth.keys()], cursors };
  } finally {
    releaseLock(lock);
  }
}
