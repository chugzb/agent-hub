// B4：doctor 要报收件箱多大、最老一条是哪天。用临时 HOME 跑真 doctor，不碰真实收件箱。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 起一次 doctor（不测 MCP、不查常驻），拿整份输出 */
function runDoctor(HOME) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, "doctor.mjs"), "--no-mcp", "--no-launchd"], { env: { ...process.env, HOME } });
    let out = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (out += b));
    p.on("error", reject);
    p.on("close", () => resolve(out));
  });
}
const row = (out, item) => out.split("\n").find((l) => l.includes(item)) ?? "";

test("doctor：报出收件箱大小、行数和最老一条的日期", async () => {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-inbox-"));
  fs.mkdirSync(path.join(HOME, "agy-logs"), { recursive: true });
  const old = new Date(2026, 8, 20, 8, 0).getTime();   // 2026-09-20
  const inbox = [
    JSON.stringify({ id: "a", at: old, time: "09-20 08:00", from: "主控", to: "t1", type: "task", text: "老的" }),
    JSON.stringify({ id: "b", at: Date.now(), time: "11-08 10:00", from: "主控", to: "t1", type: "note", text: "新的" }),
    "坏行",
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(HOME, "agy-logs", "inbox.jsonl"), inbox);
  const out = await runDoctor(HOME);
  const r = row(out, "收件箱大小");
  assert.match(r, /^通/, r);
  assert.match(r, /最老一条 2026-09-20/, r);
  assert.match(r, /3 行/, "空行和坏行也算物理行：" + r);
  assert.match(r, new RegExp(`${(Buffer.byteLength(inbox) / 1024 / 1024).toFixed(1)} MB`), r);
});

test("doctor：还没有收件箱不算失败", async () => {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-inbox-"));
  const out = await runDoctor(HOME);
  const r = row(out, "收件箱大小");
  assert.match(r, /^通/, r);
  assert.match(r, /还没有收件箱/, r);
});
