// B2：收件箱超过 2MB 时把 30 天前的消息挪进 inbox-archive/YYYY-MM.jsonl，游标行号跟着换算。
// 全部用临时目录，不碰真实的 ~/agy-logs/inbox.jsonl 和 cursors。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const A = await import("../inbox-archive.mjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 24 * 60 * 60_000;

// 固定「现在」：2026-11-08 12:00 本地时间，测试里所有相对日期都按它算
const NOW = new Date(2026, 10, 8, 12, 0).getTime();
const msg = (o) => JSON.stringify({ id: Math.random().toString(16).slice(2, 10), type: "task", ...o });
const at = (daysAgo) => NOW - daysAgo * DAY;

test("msgTime：跟看板一个口径——有 at/ts 用时间戳，没有就把「MM-DD HH:MM」按今年补，补成未来的算去年", () => {
  assert.equal(A.msgTime({ at: 1_700_000_000 }, NOW), 1_700_000_000_000, "秒级时间戳");
  assert.equal(A.msgTime({ ts: 1_700_000_000_000 }, NOW), 1_700_000_000_000, "毫秒时间戳");
  assert.equal(A.msgTime({ at: "2026-10-01T00:00:00Z" }, NOW), Date.parse("2026-10-01T00:00:00Z"), "at 是能 Date.parse 的字符串");
  assert.equal(A.msgTime({ time: "2026-10-01T00:00:00Z" }, NOW), 0, "time 只认「MM-DD HH:MM」——跟看板一样");
  assert.equal(A.msgTime({ time: "10-01 10:30" }, NOW), new Date(2026, 9, 1, 10, 30).getTime());
  // 12 月的消息在 11 月看到：只能是去年的
  assert.equal(A.msgTime({ time: "12-20 10:00" }, NOW), new Date(2025, 11, 20, 10, 0).getTime());
  assert.equal(A.msgTime({ time: "乱七八糟" }, NOW), 0);
  assert.equal(A.msgTime({}, NOW), 0);
});

test("planArchive：只搬 30 天前的消息行，空行、坏行、没有时间的行留着", () => {
  const lines = [
    msg({ time: "10-01 10:00", text: "老一" }),   // 38 天前
    msg({ time: "11-07 09:00", text: "新的" }),
    "不是 JSON",
    "",
    msg({ time: "09-20 08:00", text: "老二" }),   // 49 天前
    msg({ text: "没有时间" }),
  ];
  const { removed, kept } = A.planArchive(lines, { now: NOW });
  assert.deepEqual(removed.map((r) => [r.line, r.month, JSON.parse(r.text).text]), [[1, "2026-10", "老一"], [5, "2026-09", "老二"]]);
  assert.deepEqual(kept, [lines[1], lines[2], lines[3], lines[5]], "剩下的保持原顺序、原文");
});

test("remapLine：减去被搬走的、行号不大于它的行数，不会算成负数", () => {
  const removed = [{ line: 1, month: "2026-10", text: "" }, { line: 2, month: "2026-10", text: "" }];
  assert.equal(A.remapLine(1, removed), 0, "只读过老行");
  assert.equal(A.remapLine(2, removed), 0);
  assert.equal(A.remapLine(3, removed), 1, "刚好读到最后一条老行");
  assert.equal(A.remapLine(5, removed), 3);
  assert.equal(A.remapLine(0, removed), 0);
});

/** 造一个收件箱目录：inbox.jsonl、cursors/*.json */
function setup(lines, cursors = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-arch-"));
  fs.writeFileSync(path.join(dir, "inbox.jsonl"), lines.join("\n"));
  if (Object.keys(cursors).length) {
    fs.mkdirSync(path.join(dir, "cursors"), { recursive: true });
    for (const [me, line] of Object.entries(cursors)) fs.writeFileSync(path.join(dir, "cursors", `${me}.json`), JSON.stringify({ line }));
  }
  return dir;
}
const readCursors = (dir) => {
  const d = path.join(dir, "cursors");
  if (!fs.existsSync(d)) return {};
  return Object.fromEntries(fs.readdirSync(d).map((f) => [f.replace(/\.json$/, ""), JSON.parse(fs.readFileSync(path.join(d, f), "utf8")).line]));
};

test("archiveInbox：按月归档、收件箱换成剩下的、换 inode、游标按位置换算", () => {
  const L = [
    msg({ at: at(38), text: "老一" }),
    msg({ at: at(40), text: "老二" }),
    msg({ at: at(1), text: "新的" }),
    msg({ at: at(0), text: "最新" }),
    "坏行",
  ];
  const dir = setup(L, { a: 1, b: 2, c: 3, d: 5 });
  const before = fs.statSync(path.join(dir, "inbox.jsonl")).ino;

  const r = A.archiveInbox(dir, { now: NOW, maxBytes: 10 });   // 文件很小，把阈值调低
  assert.deepEqual(r, { archived: 2, kept: 3, months: ["2026-10", "2026-09"], cursors: 4 });

  // 归档文件按月份装原文，顺序不乱
  const sep = fs.readFileSync(path.join(dir, "inbox-archive", "2026-09.jsonl"), "utf8").split("\n").filter(Boolean);
  const oct = fs.readFileSync(path.join(dir, "inbox-archive", "2026-10.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.deepEqual([...oct, ...sep], [L[0], L[1]]);

  // 收件箱只剩近期消息，坏行没动
  const left = fs.readFileSync(path.join(dir, "inbox.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.deepEqual(left, [L[2], L[3], L[4]]);
  assert.notEqual(fs.statSync(path.join(dir, "inbox.jsonl")).ino, before, "inode 变了，看板的尾部索引会重扫");

  // 游标：a、b 只读过老行 → 0；c 读过最后一条老行（旧 2）→ 1；d 读到坏行 → 3
  assert.deepEqual(readCursors(dir), { a: 0, b: 0, c: 1, d: 3 });

  // 换算后：a 还欠「新的」「最新」，c 只欠「最新」，d 不欠
  // 跟 readInbox 一样：坏行占行号但不算消息
  const unreadAfter = (cur) => left.map((l, i) => [l, i + 1]).filter(([l, n]) => n > cur && (() => { try { JSON.parse(l); return true; } catch { return false; } })()).map(([, n]) => n);
  assert.deepEqual(unreadAfter(readCursors(dir).a), [1, 2], "不会漏收近期消息（坏行不算消息）");
  assert.deepEqual(unreadAfter(readCursors(dir).c), [2]);
  assert.deepEqual(unreadAfter(readCursors(dir).d), []);
});

test("archiveInbox：没到阈值不动；没有老消息不动（inode 不变）", () => {
  const dir = setup([msg({ at: at(1), text: "新的" })], { a: 1 });
  const ino = fs.statSync(path.join(dir, "inbox.jsonl")).ino;
  assert.deepEqual(A.archiveInbox(dir, { now: NOW }), { skipped: "small", size: fs.statSync(path.join(dir, "inbox.jsonl")).size });
  assert.equal(fs.statSync(path.join(dir, "inbox.jsonl")).ino, ino);
  const text = fs.readFileSync(path.join(dir, "inbox.jsonl"), "utf8");
  assert.deepEqual(A.archiveInbox(dir, { now: NOW, force: true }), { skipped: "nothing-old", size: text.length });
  assert.equal(fs.statSync(path.join(dir, "inbox.jsonl")).ino, ino, "没得搬就不改写文件");
  assert.equal(readCursors(dir).a, 1, "游标不动");
});

test("archiveInbox：别的进程正在归档（锁还在）就跳过；锁过期了能接管", () => {
  const dir = setup([msg({ at: at(40), text: "老的" }), msg({ at: at(1), text: "新的" })]);
  const lock = path.join(dir, ".inbox-archive.lock");
  fs.writeFileSync(lock, "999");
  assert.deepEqual(A.archiveInbox(dir, { now: NOW, force: true }), { skipped: "locked" });
  assert.ok(fs.existsSync(lock), "不是自己加的锁不删");
  const old = Date.now() - 5 * 60_000;
  fs.utimesSync(lock, old / 1000, old / 1000);   // 1 分钟前的锁当崩了留下的
  const r = A.archiveInbox(dir, { now: NOW, force: true });
  assert.equal(r.archived, 1);
  assert.ok(!fs.existsSync(lock), "干完把锁收掉");
});

// ---------------------------------------------------------------- 经 server.mjs 走一遍
/** 起一个 server.mjs 调一个工具，拿返回文字 */
function toolCall(env, name, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, "server.mjs")], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("error", reject);
    p.on("close", () => {
      try { resolve(JSON.parse(out.trim().split("\n")[0]).result.content[0].text); } catch { reject(new Error(`server 没回话：${out} ${err}`)); }
    });
    p.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
}

/** 临时 HOME + HUB_DIR；HUB_ARCHIVE_AT_BYTES 调得很小，让 2MB 阈值在测试里能触发 */
function setupHub(cursorLine) {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-hub-"));
  const DIR = path.join(HOME, "agy-logs");
  fs.mkdirSync(path.join(DIR, "cursors"), { recursive: true });
  const lines = [
    msg({ at: at(40), to: "t1", from: "主控", text: "老单" }),
    msg({ at: at(1), to: "t1", from: "主控", text: "旧活" }),
    msg({ at: at(0), to: "t1", from: "主控", text: "新活" }),
  ];
  fs.writeFileSync(path.join(DIR, "inbox.jsonl"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(DIR, "cursors", "t1.json"), JSON.stringify({ line: cursorLine }));
  const ENV = { ...process.env, HOME, HUB_DIR: DIR, HUB_SIDE: "employee", HUB_ARCHIVE_AT_BYTES: "10" };
  delete ENV.HUB_ME;
  return { HOME, DIR, ENV, lines };
}

test("端到端：读过老单的员工再读收件箱，不重收旧活、不漏收新活，老单进按月归档", async () => {
  const h = setupHub(2);   // 只读到「旧活」（老单 + 旧活都读过）
  const r1 = await toolCall(h.ENV, "read_messages", { me: "t1" });
  assert.ok(r1.includes("新活"), r1);
  assert.ok(!r1.includes("旧活") && !r1.includes("老单"), "读过的不重复：" + r1);
  const archived = fs.readdirSync(path.join(h.DIR, "inbox-archive"));
  assert.equal(archived.length, 1, "按月份一个文件");
  assert.deepEqual(fs.readFileSync(path.join(h.DIR, "inbox-archive", archived[0]), "utf8").trim(), h.lines[0]);
  // 归档把游标从 2 换算到 1，读完「新活」（新行号 2）又写成 2
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.DIR, "cursors", "t1.json"), "utf8")).line, 2, "游标换算了");
  const r2 = await toolCall(h.ENV, "read_messages", { me: "t1" });
  assert.equal(r2, "没有新消息");
});

test("端到端：游标停在被挪走的最后一条上，归档后剩下的都要收到（不漏）", async () => {
  const h = setupHub(1);   // 只读过老单
  const r = await toolCall(h.ENV, "read_messages", { me: "t1" });
  assert.ok(r.includes("旧活") && r.includes("新活"), r);
  assert.ok(!r.includes("老单"), "读过的不重复：" + r);
});

test("端到端：没到归档阈值就什么也不动", async () => {
  const h = setupHub(2);
  h.ENV.HUB_ARCHIVE_AT_BYTES = String(1024 * 1024);
  await toolCall(h.ENV, "read_messages", { me: "t1" });
  assert.ok(!fs.existsSync(path.join(h.DIR, "inbox-archive")), "没归档");
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.DIR, "cursors", "t1.json"), "utf8")).line, 3, "游标还是物理行号");
});
