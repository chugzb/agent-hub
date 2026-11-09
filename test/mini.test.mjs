// 桌面悬浮窗的精简页：/mini 得能打开、跟看板是同一份数据流，别把首页顶掉
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 找个空闲端口（board.mjs 只接固定端口，不能传 0） */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/** 起一个演示模式的看板，等到能打开为止 */
async function startBoard() {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mini-board-"));
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(ROOT, "board.mjs"), String(port)], {
    env: { ...process.env, HOME, BOARD_DEMO: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  p.stderr.on("data", (b) => (err += b));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + "/mini", { signal: AbortSignal.timeout(500) }); return { base, proc: p, kill: () => p.kill() }; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  p.kill();
  throw new Error(`看板没起来：${err.slice(0, 300)}`);
}

test("/mini 能打开、顶行四个数和给小程序的那几个钩子在", async () => {
  const b = await startBoard();
  try {
    const r = await fetch(b.base + "/mini");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(r.headers.get("cache-control"), "no-store", "悬浮窗每次都要拿最新的页面");
    const html = await r.text();
    for (const w of ["在干活", "要处理", "没额度", "歇着"]) assert.ok(html.includes(w), `少了「${w}」：${html.slice(0, 200)}`);
    assert.ok(html.includes("__miniStats"), "小程序靠 window.__miniStats 读人数");
    assert.ok(html.includes("/events"), "数据走看板的 /events，不另算一套快照");
  } finally { b.kill(); }
});

test("/mini 不占首页：/ 还是完整看板", async () => {
  const b = await startBoard();
  try {
    const home = await (await fetch(b.base + "/")).text();
    assert.ok(home.includes("id=\"scene\"") || home.includes("Agent Hub"), "首页应当是完整看板");
    assert.ok(!home.includes("__miniStats"), "首页不该变成精简页");
  } finally { b.kill(); }
});

test("/events 推的是同一份数据，字段能算出四个数", async () => {
  const b = await startBoard();
  try {
    const ctrl = new AbortController();
    const r = await fetch(b.base + "/events", { signal: ctrl.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = r.body.getReader();
    let buf = "";
    const t0 = Date.now();
    while (!buf.includes("\n\n") && Date.now() - t0 < 10000) buf += new TextDecoder().decode((await reader.read()).value, { stream: true });
    ctrl.abort();
    const data = /^data: (.+)$/m.exec(buf)?.[1];
    assert.ok(data, `没收到数据：${buf.slice(0, 200)}`);
    const d = JSON.parse(data);
    assert.ok(Array.isArray(d.agents) && d.agents.length, "要有员工");
    const states = new Set(d.agents.map((a) => a.state));
    for (const s of states) assert.ok(["working", "stuck", "error", "idle", "quota", "offline", "waiting", "unknown"].includes(s), `没见过的状态：${s}`);
  } finally { b.kill(); }
});
