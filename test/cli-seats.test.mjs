// 反重力命令行座位：会话表每项一个座位；pid 活着算干活，日志 8 分钟没长算卡住；进程没了、最后一轮报错算出错，12 小时后不再挂红
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliSeats, describeStep, runStart } from "../cli-seats.mjs";

function setup({ events, pid = 4242, time = "2026-11-09 10:00", mtimeAgoMin = 1, now }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cli-seats-"));
  const log = path.join(d, "p-a.jsonl");
  fs.writeFileSync(log, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const t = (now - mtimeAgoMin * 60_000) / 1000; fs.utimesSync(log, t, t);
  fs.writeFileSync(path.join(d, "reg.json"), JSON.stringify({ "proj/cli-a": { dir: "/x", conversation: "c1", model: "gemini-3.8-flash-high", log } }));
  fs.writeFileSync(path.join(d, "runs.jsonl"), JSON.stringify({ time, project: "proj", role: "cli-a", master: "km", model: "gemini-3.8-flash-high", pid, task: "写稿：第 1 篇" }) + "\n");
  return { reg: path.join(d, "reg.json"), runs: path.join(d, "runs.jsonl"), logDir: path.join(d, "nolog") };
}
const init = { event: "init", conversation_id: "c1" };
const tool = { event: "step_update", step_update: { state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "git commit -m x" } } } };

test("进程活着、日志刚动过：干活，气泡是派活人和任务，最近动作是最后一步", () => {
  const now = runStart("2026-11-09 10:05");
  const [a] = cliSeats({ ...setup({ events: [init, tool], now }), now, alive: () => true });
  assert.equal(a.name, "proj/cli-a"); assert.equal(a.tool, "反重力 CLI"); assert.equal(a.group, "反重力 CLI");
  assert.equal(a.state, "working"); assert.equal(a.doing, "km 派的：写稿：第 1 篇");
  assert.equal(a.said, "最近：在跑命令：git commit -m x");
});

test("进程活着但日志 8 分钟没长：卡住？", () => {
  const now = runStart("2026-11-09 10:30");
  const [a] = cliSeats({ ...setup({ events: [init, tool], now, mtimeAgoMin: 9 }), now, alive: () => true });
  assert.equal(a.state, "stuck"); assert.match(a.doing, /日志 9 分钟没增长/);
});

test("进程没了、本轮报错：出错；超过 12 小时就当歇着", () => {
  const ev = [init, tool, { event: "result", result: { status: "ERROR", error: "stream idle timeout (5m0s)" } }];
  let now = runStart("2026-11-09 10:20");
  let [a] = cliSeats({ ...setup({ events: ev, now }), now, alive: () => false });
  assert.equal(a.state, "error"); assert.match(a.doing, /超时/);
  now = runStart("2026-11-10 10:20");
  [a] = cliSeats({ ...setup({ events: ev, now, mtimeAgoMin: 23 * 60 }), now, alive: () => false });
  assert.equal(a.state, "idle");
});

test("上一轮的报错不算本轮：本轮从最后一个 init 起算", () => {
  const now = runStart("2026-11-09 10:20");
  const ev = [init, { event: "result", result: { status: "ERROR", error: "old" } }, init, { event: "result", result: { status: "SUCCESS", response: "写完了" } }];
  const [a] = cliSeats({ ...setup({ events: ev, now }), now, alive: () => false });
  assert.equal(a.state, "idle"); assert.equal(a.said, "上一轮：写完了");
});

test("步骤说成人话", () => {
  assert.equal(describeStep({ step_type: "error_message" }), "接口报错，在重试");
  assert.equal(describeStep({ step_type: "tool", tool_name: "write_to_file", tool_info: { parameters: { TargetFile: "/a/b.md" } } }), "在写文件：/a/b.md");
});
