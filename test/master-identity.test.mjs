// B1：三个主控各用真名派活、发消息；员工回复按名字推回对应会话。node --test test/master-identity.test.mjs
// 用临时 HOME：假的 Claude 会话登记文件、假的会话 socket，不碰真实的收件箱、员工表、会话。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "master-id-"));
const SESS = path.join(HOME, ".claude", "sessions");
const INBOX = path.join(HOME, "agy-logs", "inbox.jsonl");
fs.mkdirSync(SESS, { recursive: true });
fs.mkdirSync(path.join(HOME, ".config", "agy-team"), { recursive: true });
fs.mkdirSync(path.dirname(INBOX), { recursive: true });
fs.writeFileSync(path.join(HOME, ".config", "agy-team", "roles.json"), JSON.stringify({ t1: { name: "t1", kind: "desktop", log: "t1" } }));
const ENV = { ...process.env, HOME };
delete ENV.HUB_DIR; delete ENV.HUB_ME;

const procs = [], servers = [];
after(() => { for (const p of procs) try { p.kill("SIGTERM"); } catch {} for (const s of servers) try { s.close(); } catch {} setTimeout(() => process.exit(0), 200).unref(); });

// 假的 Claude Code 会话：一个父进程（登记成会话 name）+ 它起的主控侧 MCP（server.mjs 沿父进程能找到这个登记）
function fakeMaster(name, sockPath) {
  const parent = spawn(process.execPath, ["-e", `const {spawn}=require("node:child_process");
    const c=spawn(process.execPath,[${JSON.stringify(path.join(ROOT, "server.mjs"))}],{stdio:"inherit",env:{...process.env,HUB_SIDE:"master"}});
    c.on("exit",()=>process.exit());`], { stdio: ["pipe", "pipe", "inherit"], env: ENV });
  procs.push(parent);
  fs.writeFileSync(path.join(SESS, `${parent.pid}.json`), JSON.stringify({ pid: parent.pid, name, kind: "interactive", messagingSocketPath: sockPath }));
  let buf = "", id = 0; const waiting = new Map();
  parent.stdout.on("data", (b) => { buf += b; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiting.get(m.id)?.(m); } catch {} } });
  const call = (tool, args) => new Promise((resolve) => {
    const n = ++id; waiting.set(n, (m) => resolve(m.result?.content?.[0]?.text ?? JSON.stringify(m)));
    parent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name: tool, arguments: args } }) + "\n");
  });
  return { name, pid: parent.pid, call };
}

// 假会话的收件 socket：把收到的帧记下来
function listen(sockPath) {
  const got = [];
  const srv = net.createServer((c) => { let b = ""; c.on("data", (d) => { b += d; }); c.on("end", () => got.push(b)); c.on("error", () => {}); });
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });
  srv.listen(sockPath); servers.push(srv);
  return got;
}
const readInbox = () => fs.readFileSync(INBOX, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SOCKS = fs.mkdtempSync(path.join("/tmp", "mid-socks-"));
const scSock = path.join(SOCKS, "sc.sock"), adSock = path.join(SOCKS, "ad.sock");
const scGot = listen(scSock), adGot = listen(adSock);
const sc = fakeMaster("master-a", scSock), ad = fakeMaster("master-b", adSock);

test("两个主控各自派活，收件箱里 from 是各自的会话名，不再是「主控」", async () => {
  await sc.call("dispatch_task", { role: "t1", task: "a 的活" });
  await ad.call("dispatch_task", { role: "t1", task: "b 的活" });
  const tasks = readInbox().filter((m) => m.type === "task");
  assert.deepEqual(tasks.map((m) => [m.from, m.to, m.text]), [["master-a", "t1", "a 的活"], ["master-b", "t1", "b 的活"]]);
});

test("主控用 me=主控 发消息，from 也写真名", async () => {
  await sc.call("send_message", { me: "主控", to: "t1", type: "reply", text: "sc 补一句" });
  const m = readInbox().filter((x) => x.type === "reply").pop();
  assert.equal(m.from, "master-a"); assert.equal(m.to, "t1");
});

test("read_messages(me=主控)：读到发给自己的，兼容发给「主控」的旧消息，不读别的主控的", async () => {
  const add = (o) => fs.appendFileSync(INBOX, JSON.stringify({ id: Math.random().toString(16).slice(2, 10), time: "11-08 03:00", type: "done", ...o }) + "\n");
  add({ from: "t1", to: "主控", text: "旧消息（发给主控）" });
  add({ from: "t1", to: "master-a", text: "给 a 的" });
  add({ from: "t1", to: "master-b", text: "给 b 的" });
  const r1 = await sc.call("read_messages", { me: "主控" });
  assert.ok(r1.includes("旧消息（发给主控）") && r1.includes("给 a 的"), r1);
  assert.ok(!r1.includes("给 b 的"), "不能读到别的主控的消息");
  assert.equal(await sc.call("read_messages", { me: "主控" }), "没有新消息", "读过的不重复");
  const r2 = await ad.call("read_messages", { me: "主控" });
  assert.ok(r2.includes("给 b 的") && !r2.includes("给 a 的"), r2);
});

test("员工回复：to 写哪个主控的名字，就经 peer-bridge 推给哪个会话", async () => {
  const bridge = spawn(process.execPath, [path.join(ROOT, "peer-bridge.mjs"), "t1"], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(bridge);
  for (let i = 0; i < 40 && !fs.readdirSync(SESS).some((f) => f.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(SESS, f), "utf8")).name === "t1"); i++) await sleep(250);
  const sendAsT1 = (to, text) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, "server.mjs")], { env: { ...ENV, HUB_SIDE: "employee" }, stdio: ["pipe", "pipe", "ignore"] });
    p.stdout.on("data", () => { p.stdin.end(); resolve(); });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { me: "t1", to, type: "done", text } } }) + "\n");
  });
  await sendAsT1("master-a", "做完了-给a");
  await sendAsT1("master-b", "做完了-给b");
  for (let i = 0; i < 20 && (scGot.length < 1 || adGot.length < 1); i++) await sleep(500);
  assert.equal(scGot.length, 1, "master-a 的会话收到 1 条"); assert.ok(scGot[0].includes("做完了-给a") && !scGot[0].includes("给b"));
  assert.equal(adGot.length, 1, "master-b 的会话收到 1 条"); assert.ok(adGot[0].includes("做完了-给b") && !adGot[0].includes("给a"));
});

test("找不到会话登记时退回「主控」（比如不在 Claude Code 里跑）", async () => {
  const lone = spawn(process.execPath, [path.join(ROOT, "server.mjs")], { env: { ...ENV, HUB_SIDE: "master" }, stdio: ["pipe", "pipe", "ignore"] });
  procs.push(lone);
  const out = await new Promise((resolve) => { lone.stdout.once("data", (b) => resolve(String(b))); lone.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "dispatch_task", arguments: { role: "t1", task: "无名的活" } } }) + "\n"); });
  assert.ok(out.includes("t1"), out);
  const m = readInbox().filter((x) => x.type === "task").pop();
  assert.equal(m.from, "主控");
});

test("identity：进程链上找会话名；peer-bridge 登记的不算；链上没有就是 null", async () => {
  const I = await import("../identity.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idn-"));
  fs.writeFileSync(path.join(dir, "300.json"), JSON.stringify({ pid: 300, name: "master-c" }));
  fs.writeFileSync(path.join(dir, "200.json"), JSON.stringify({ pid: 200, name: "3a" }));   // 假装是 peer-bridge 登记的员工
  const parent = new Map([[500, 400], [400, 300], [300, 100], [100, 1], [900, 200], [200, 1]]);
  const args = (pid) => (pid === 200 ? "node /x/peer-bridge.mjs 3a" : "claude");
  assert.deepEqual(I.ancestors(500, (p) => parent.get(p) ?? 0), [500, 400, 300, 100]);
  assert.equal(I.masterName({ pid: 500, sessDir: dir, parentOf: (p) => parent.get(p) ?? 0, args }), "master-c");
  assert.equal(I.masterName({ pid: 900, sessDir: dir, parentOf: (p) => parent.get(p) ?? 0, args }), null, "只有 peer-bridge 的登记，不能当成主控");
  assert.equal(I.masterName({ pid: 77, sessDir: dir, parentOf: () => 0, args }), null);
});
