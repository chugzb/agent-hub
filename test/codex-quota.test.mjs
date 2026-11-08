// 11-08：Codex / Devin 额度用完自动换模型重跑一轮（有 fallback_model 才换，没有就回派活人「额度用完」）。
// 用临时 HOME + 假的 codex 可执行文件跑真适配器，不碰真实收件箱和员工表。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 假 codex：按 -m 的模型名查 fake-behavior.json，照剧本写回复文件 / 打错误 / 设退出码；每次调用记下参数 */
const FAKE = `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
const HOME = process.env.HOME;
fs.appendFileSync(HOME + "/fake-calls.jsonl", JSON.stringify(argv) + "\\n");
const i = argv.indexOf("-m");
const model = i >= 0 ? argv[i + 1] : "";
const all = JSON.parse(fs.readFileSync(HOME + "/fake-behavior.json", "utf8"));
const b = all[model] ?? all.default ?? {};
if (b.err) fs.writeSync(2, b.err);
const o = argv.indexOf("-o");
if (b.text && o >= 0) fs.writeFileSync(argv[o + 1], b.text);
process.exit(b.code ?? 0);
`;

function setup(behavior, role = {}) {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-"));
  fs.mkdirSync(path.join(HOME, "agy-logs"), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".config", "agy-team"), { recursive: true });
  const bin = path.join(HOME, "fake-codex.mjs");
  fs.writeFileSync(bin, FAKE); fs.chmodSync(bin, 0o755);
  fs.writeFileSync(path.join(HOME, "fake-behavior.json"), JSON.stringify(behavior));
  fs.writeFileSync(path.join(HOME, ".config", "agy-team", "roles.json"), JSON.stringify({
    cx1: { kind: "codex", cwd: HOME, sandbox: "read-only", log: "cx1", ...role },
  }));
  fs.writeFileSync(path.join(HOME, "agy-logs", "inbox.jsonl"), JSON.stringify({
    id: "m1", at: Date.now(), time: "11-08 10:00", from: "kw-master", to: "cx1", type: "task", text: "跑一下单测",
  }) + "\n");
  return HOME;
}

function run(HOME) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, "adapters", "codex-run.mjs"), "cx1"], {
      env: { ...process.env, HOME, HUB_DIR: path.join(HOME, "agy-logs"), CODEX_BIN: path.join(HOME, "fake-codex.mjs"), DEVIN_BIN: path.join(HOME, "fake-codex.mjs") },
    });
    let out = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (out += b));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out }));
  });
}

const calls = (HOME) => fs.readFileSync(path.join(HOME, "fake-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const presence = (HOME) => JSON.parse(fs.readFileSync(path.join(HOME, "agy-logs", "presence", "cx1.json"), "utf8"));
const replies = (HOME) => fs.readFileSync(path.join(HOME, "agy-logs", "inbox.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.from === "cx1");

test("Codex 额度用完、员工表没写 fallback_model：回派活人「额度用完」，状态写 quota，只跑一次", async () => {
  const HOME = setup({ default: { err: "ERROR: 429 Too Many Requests (quota exceeded)\n", code: 1 } });
  const { code, out } = await run(HOME);
  assert.equal(code, 0, out);
  assert.equal(calls(HOME).length, 1, "没有备选就别重跑");
  const [r] = replies(HOME);
  assert.equal(r.to, "kw-master");
  assert.equal(r.type, "reply");
  assert.match(r.text, /额度用完了/);
  assert.match(r.text, /这一轮没做成/);
  assert.equal(presence(HOME).state, "quota", "退出后也别把 quota 盖回 idle");
});

test("Codex 额度用完、有 fallback_model：换模型重跑这一轮，回的是重跑的结果", async () => {
  const HOME = setup({
    default: { err: "RESOURCE_EXHAUSTED (code 429): Individual quota reached\n", code: 1 },
    "gpt-5.2-codex": { text: "测试跑完了，全过。", code: 0 },
  }, { fallback_model: "gpt-5.2-codex" });
  const { code, out } = await run(HOME);
  assert.equal(code, 0, out);
  const cs = calls(HOME);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].includes("-m"), false, "第一次用默认模型");
  assert.equal(cs[1][cs[1].indexOf("-m") + 1], "gpt-5.2-codex", "第二次换成 fallback_model");
  assert.match(cs[1].join(" "), /跑一下单测/, "重跑的是同一轮的活");
  const [r] = replies(HOME);
  assert.equal(r.text, "测试跑完了，全过。");
  assert.equal(presence(HOME).state, "idle");
});

test("Codex 换过之后还是额度用完：不再重跑，回「额度用完」", async () => {
  const HOME = setup({
    default: { err: "insufficient credits", code: 1 },
    "gpt-5.2-codex": { err: "429 rate limit exceeded", code: 1 },
  }, { fallback_model: "gpt-5.2-codex" });
  const { code, out } = await run(HOME);
  assert.equal(code, 0, out);
  assert.equal(calls(HOME).length, 2, "只换一次，不来回试");
  assert.match(replies(HOME)[0].text, /换成 gpt-5\.2-codex 也还是没额度/);
  assert.equal(presence(HOME).state, "quota");
});

test("输出里只是提了一句 rate limit、但正常答了：不重跑、不回「额度用完」", async () => {
  const HOME = setup({ default: { err: "note: rate limit is 60 req/min\n", text: "活干完了。", code: 0 } }, { fallback_model: "x" });
  const { code, out } = await run(HOME);
  assert.equal(code, 0, out);
  assert.equal(calls(HOME).length, 1);
  assert.equal(replies(HOME)[0].text, "活干完了。");
  assert.equal(presence(HOME).state, "idle");
});
