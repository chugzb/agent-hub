// 话说一半就收工的自动续上：识别、门槛、最多续 2 次、续满发 help。node --test test/resume.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "resume-test-"));
process.env.HOME = HOME;
const H = await import("../health.mjs");

const MIN = 60_000;
const NOW = 5_000_000_000_000;
const SAMPLE_3A = "正在使用 `tab.mjs markdown` 抓取 Higgsfield、Runway、Kling 等官方页面正文。";   // 3a 今天的真实最后一句（中间省略）
const SAMPLE_3G = "The calculator work is running in a sub-agent. I'll wait for its report, then verify and send done.";   // 3g 的真实最后一句（它把活交给了反重力自带的子 agent）
const SAMPLE_3B = "正在抓取两篇稿件所需的 Veo 3 和 OpenArt 官方定价页，待后台抓取任务完成后立即读取并开始撰写。";   // 3b 今天的真实最后一句（中间省略）

const stopped = (ago = 5 * MIN, extra = {}) => ({ status: "CASCADE_RUN_STATUS_IDLE", latestExecutorTerminationReason: "EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL", lastModifiedTime: new Date(NOW - ago).toISOString(), stepCount: 10, ...extra });
const task = (o = {}) => ({ id: "m1", time: "11-08 05:00", from: "master-c", type: "task", text: "写第三批稿", doneAfter: false, helpAfter: false, ...o });
function deps(o = {}) {
  const d = { sent: [], wakes: [], calls: { inspect: 0 }, now: o.now ?? NOW };
  d.inspect = async () => { d.calls.inspect++; return { overflow: false, liveMb: 1, lastType: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", lastReply: o.reply ?? SAMPLE_3B, lastReplyFromEnd: 0, lastError: "", lastModel: "M", subagents: o.subagents ?? [] }; };
  d.wake = async (id, text, opt) => { if (o.wakeError) throw new Error(o.wakeError); d.wakes.push({ id, text, opt }); return "原模型"; };
  d.notify = (type, text, to = "master-a") => d.sent.push({ type, text, to });
  d.lastTask = () => o.task ?? task();
  d.configs = async () => [];
  d.peek = async () => ({ steps: 58, said: o.subSaid ?? "正在改 calculator 页面的样式，下一步跑 tsc。" });
  d.renew = async () => { throw new Error("不该换对话"); };
  return d;
}

test("looksUnfinished：今天 3a、3b 的真实最后一句是半路收工", () => {
  assert.equal(H.looksUnfinished(SAMPLE_3A), true);
  assert.equal(H.looksUnfinished(SAMPLE_3B), true);
  assert.equal(H.looksUnfinished("命令放到后台跑了，稍后继续写。"), true);
  assert.equal(H.looksUnfinished("抓取任务还在后台执行，完成后立即读取。"), true);
  assert.equal(H.looksUnfinished("接下来我将读取两篇稿件。"), true);
});

test("looksUnfinished：收尾的话、没有关键词的话不算", () => {
  assert.equal(H.looksUnfinished("第三批 3 篇已写完并提交，提交号 abc1234，已发 done 给 master-c。"), false);
  assert.equal(H.looksUnfinished("我是 3h，工作文件夹是 /x/.wt-ag-h，有活会自动派给我。"), false);
  assert.equal(H.looksUnfinished("已完成：改了 A、B 两处。正在等下一单。"), false, "有「正在」但结尾是收尾");
  assert.equal(H.looksUnfinished("验证：测试全过。已回报。"), false);
  assert.equal(H.looksUnfinished("两篇都改好了，提交号 9f3c2ab。"), false);
  assert.equal(H.looksUnfinished(""), false);
  assert.equal(H.looksUnfinished(undefined), false);
  // 「正在」出现在很早的地方、最后 200 字里没有 → 不算
  assert.equal(H.looksUnfinished("正在抓取的那批已经全部处理完。" + "细节说明".repeat(60) + "结论：数字都核对过，写进稿子里了。"), false);
});

test("looksStopped：只认 IDLE + 没再调工具", () => {
  assert.equal(H.looksStopped(stopped()), true);
  assert.equal(H.looksStopped(stopped(5 * MIN, { status: "CASCADE_RUN_STATUS_RUNNING" })), false);
  assert.equal(H.looksStopped(stopped(5 * MIN, { latestExecutorTerminationReason: "EXECUTOR_TERMINATION_REASON_ERROR" })), false);
  assert.equal(H.looksStopped(undefined), false);
});

test("resumeGate：停够 2 分钟、没停超过 6 小时、它之后没发过 done / help", () => {
  const g = (summary, t = task()) => H.resumeGate({ summary, task: t, now: NOW });
  assert.equal(g(stopped(5 * MIN)), "ok");
  assert.equal(g(stopped(30_000)), "wait", "刚停下，等一等：后台命令跑完它自己可能会接着干");
  assert.equal(g(stopped(7 * 3600_000)), "stale");
  assert.equal(g(stopped(5 * MIN), null), "no-task");
  assert.equal(g(stopped(5 * MIN), task({ doneAfter: true })), "replied");
  assert.equal(g(stopped(5 * MIN), task({ helpAfter: true })), "replied");
  assert.equal(g({ ...stopped(5 * MIN), status: "CASCADE_RUN_STATUS_RUNNING" }), "not-stopped");
});

test("decideResume：续 2 次，第 3 次变成通知；换了一单重新数", () => {
  const info = { lastReply: SAMPLE_3A, lastType: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", lastReplyFromEnd: 0 };
  const d = (state, t = task()) => H.decideResume({ info, task: t, state, now: NOW });
  assert.deepEqual(d(null), { act: "resume", count: 1 });
  assert.deepEqual(d({ taskId: "m1", count: 1 }), { act: "resume", count: 2 });
  assert.deepEqual(d({ taskId: "m1", count: 2 }), { act: "giveup", count: 2 });
  assert.equal(d({ taskId: "m1", count: 2, gaveUp: true }).act, "none", "通知过就不再动");
  assert.deepEqual(d({ taskId: "m1", count: 2, gaveUp: true }, task({ id: "m2" })), { act: "resume", count: 1 }, "新的一单重新数");
  assert.equal(H.decideResume({ info: { ...info, lastReply: "已写完，提交号 abc1234。" }, task: task(), state: null, now: NOW }).act, "none");
  assert.equal(H.decideResume({ info: { ...info, lastReplyFromEnd: 9 }, task: task(), state: null, now: NOW }).act, "none", "最后一句后面还有别的动静，不是这一轮的收尾");
});

test("checkRole：半路收工 → 原模型叫醒一次，写 resumed，不打扰别人", async () => {
  H._resetMemory();
  const d = deps();
  const r = await H.checkRole("r-a", "ID-1", { "ID-1": stopped() }, d);
  assert.equal(r, "resumed");
  assert.equal(d.wakes.length, 1);
  assert.equal(d.wakes[0].id, "ID-1"); assert.equal(d.wakes[0].opt.role, "r-a", "不指定模型，由 wake 按这个员工原来的模型叫醒");
  assert.ok(d.wakes[0].text.includes("继续刚才那单，从断的地方接着做；不要把命令放后台再结束这一轮"));
  assert.ok(d.wakes[0].text.includes("待后台抓取任务完成后立即读取并开始撰写"), "把它停在哪句话带上");
  const h = H.readHealth("r-a");
  assert.equal(h.state, "resumed"); assert.equal(h.count, 1); assert.equal(h.at, NOW);
  assert.equal(d.sent.length, 0, "续上的时候不发通知");
});

test("checkRole：同一单最多续 2 次，再停就给主控和派活人发 help，不再续", async () => {
  H._resetMemory();
  const t0 = NOW;
  const run = async (n, extra = {}) => { const d = deps({ now: t0 + n * 10 * MIN, ...extra }); const r = await H.checkRole("r-b", "ID-2", { "ID-2": stopped(5 * MIN, { lastModifiedTime: new Date(t0 + n * 10 * MIN - 5 * MIN).toISOString() }) }, d); return { r, d }; };
  const a = await run(0); assert.equal(a.r, "resumed"); assert.equal(H.readHealth("r-b").count, 1);
  const b = await run(1); assert.equal(b.r, "resumed"); assert.equal(H.readHealth("r-b").count, 2);
  assert.ok(b.d.wakes[0].text.includes("第 2 次自动续上"));
  const c = await run(2);
  assert.equal(c.r, "resume-giveup"); assert.equal(c.d.wakes.length, 0, "第 3 次不再叫醒");
  assert.deepEqual(c.d.sent.map((x) => [x.type, x.to]), [["help", "master-a"], ["help", "master-c"]]);
  for (const k of ["r-b", "自动续了 2 次", "m1", "待后台抓取任务完成后立即读取并开始撰写"]) assert.ok(c.d.sent[0].text.includes(k), k);
  const hh = H.readHealth("r-b"); assert.equal(hh.state, "resumed"); assert.equal(hh.gaveUp, true); assert.equal(hh.count, 2);
  const e = await run(3);
  assert.equal(e.d.wakes.length, 0); assert.equal(e.d.sent.length, 0, "通知过一次就不再发");
  const f = await run(4, { task: task({ id: "m2" }) });
  assert.equal(f.r, "resumed", "派了新的一单，重新数"); assert.equal(H.readHealth("r-b").count, 1);
});

test("resumeStep：之后发过 done / help、刚停下 → 预检不过，不叫醒，也不拉整段对话", async () => {
  for (const [label, summary, t] of [
    ["发过 done", stopped(), task({ doneAfter: true })],
    ["发过 help", stopped(), task({ helpAfter: true })],
    ["刚停下 30 秒", stopped(30_000), task()],
    ["没有发给它的活", stopped(), null],
  ]) {
    const d = deps({ task: t, reply: SAMPLE_3A });
    const m = { notifiedAt: {} };
    const r = await H.resumeStep("r-c", "ID-3", summary, { m, now: NOW, say: d.notify, inspect: d.inspect, wake: d.wake, getTask: () => t, S: {} });
    assert.equal(r, null, label); assert.equal(d.wakes.length, 0, label); assert.equal(d.calls.inspect, 0, `${label}：预检不过不拉整段对话`);
  }
});

test("checkRole：最后一句是收尾（已写完、已发 done）→ 不叫醒", async () => {
  H._resetMemory();
  const d = deps({ reply: "两篇都写完了，提交号 abc1234，已发 done。" });
  const r = await H.checkRole("r-c2", "ID-3", { "ID-3": stopped() }, d);
  assert.notEqual(r, "resumed"); assert.equal(d.wakes.length, 0); assert.equal(d.sent.length, 0);
});

test("checkRole：宽限期过了才叫醒（同一个停下的状态不重复判断）", async () => {
  H._resetMemory();
  const sum = (ago) => stopped(ago, { lastModifiedTime: new Date(NOW - ago).toISOString() });
  const d1 = deps({ now: NOW });
  await H.checkRole("r-d", "ID-4", { "ID-4": sum(30_000) }, d1);
  assert.equal(d1.wakes.length, 0);
  const d2 = deps({ now: NOW + 3 * MIN });
  const r = await H.checkRole("r-d", "ID-4", { "ID-4": { ...sum(30_000) } }, d2);   // 同一个 lastModifiedTime，3 分钟后
  assert.equal(r, "resumed");
});

test("checkRole：叫醒失败 → 通知一次，不记续过的次数", async () => {
  H._resetMemory();
  const d = deps({ wakeError: "桌面端连不上" });
  const r = await H.checkRole("r-e", "ID-5", { "ID-5": stopped() }, d);
  assert.equal(r, "resume-failed");
  assert.equal(d.sent.length, 2, "主控 + 派活人");
  assert.ok(d.sent[0].text.includes("桌面端连不上"));
  assert.equal(H.readHealth("r-e"), null);
});

test("checkRole：刚自动续上的状态保留 30 分钟，不被「ok」盖掉", async () => {
  H._resetMemory();
  H.writeHealth("r-f", { state: "resumed", at: NOW, count: 1, taskId: "m1" });
  const running = { status: "CASCADE_RUN_STATUS_RUNNING", stepCount: 50, lastModifiedTime: new Date(NOW).toISOString() };
  await H.checkRole("r-f", "ID-6", { "ID-6": running }, deps({ now: NOW + 10 * MIN }));
  assert.equal(H.readHealth("r-f").state, "resumed");
  H._resetMemory();
  await H.checkRole("r-f", "ID-6", { "ID-6": { ...running, stepCount: 51 } }, deps({ now: NOW + 31 * MIN }));
  assert.equal(H.readHealth("r-f").state, "ok");
});

// ---------------- 子 agent ----------------
const SUB = "339b1298-0a97-44b1-a6e6-14a9db0be23b";
const subRunning = (st = "CASCADE_RUN_STATUS_RUNNING") => ({ [SUB]: { status: st, stepCount: 58 } });

test("subagentIds：从 INVOKE_SUBAGENT 步骤的 invokeSubagent.results[].conversationId 取子对话号（去重、按先后）", async () => {
  const D = await import("../desk.mjs");
  const step = (ids) => ({ type: "CORTEX_STEP_TYPE_INVOKE_SUBAGENT", invokeSubagent: { subagents: ids.map(() => ({})), results: ids.map((conversationId) => ({ conversationId, logAbsoluteUri: "file:///x" })) } });
  assert.deepEqual(D.subagentIds([{ type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE" }, step([SUB]), step(["aaaa", SUB])]), [SUB, "aaaa"]);
  assert.deepEqual(D.subagentIds([{ type: "CORTEX_STEP_TYPE_GENERIC" }]), []);
  assert.deepEqual(D.subagentIds(undefined), []);
});

test("looksUnfinished：3g 那句英文是没收尾的话；英文收尾话不算", () => {
  assert.equal(H.looksUnfinished(SAMPLE_3G), true);
  assert.equal(H.looksUnfinished("I'll wait for the fetch to finish and then continue."), true);
  assert.equal(H.looksUnfinished("Waiting for the background task. Will continue once it finishes."), true);
  assert.equal(H.looksUnfinished("The scraper is running in the background."), true);
  for (const done of ["All three pages are committed as 9f3c2ab. Sent done to master-a.", "Work is done and committed (abc1234).", "Sent done to master-c.", "Waiting for next task.", "Done.", "I've sent done; ready for the next one."]) {
    assert.equal(H.looksUnfinished(done), false, done);
  }
});

test("有子 agent 在跑：不续，写 sub.json 给看板；缓存整段对话，不重复拉", async () => {
  H._resetMemory();
  const d = deps({ reply: SAMPLE_3G, subagents: [SUB] });
  const S = (extra = {}) => ({ "ID-S": stopped(5 * MIN), ...subRunning(), ...extra });
  const r1 = await H.checkRole("r-s", "ID-S", S(), d);
  assert.equal(r1, "subagent"); assert.equal(d.wakes.length, 0); assert.equal(d.sent.length, 0);
  const sub = H.readSub("r-s");
  assert.equal(sub.running.length, 1); assert.equal(sub.running[0].id, SUB); assert.ok(sub.running[0].said.includes("calculator"), "子对话最后一句");
  const inspected = d.calls.inspect;
  const d2 = deps({ reply: SAMPLE_3G, subagents: [SUB], now: NOW + 30_000 });
  assert.equal(await H.checkRole("r-s", "ID-S", S(), d2), "subagent");
  assert.equal(d2.wakes.length, 0);
  assert.equal(d2.calls.inspect, 0, "第二轮用缓存，不再拉整段对话");
  assert.ok(inspected >= 1);
});

test("子 agent 已结束、员工仍停着没发 done：按原规则判断（这句英文是没收尾 → 续）", async () => {
  H._resetMemory();
  const run = deps({ reply: SAMPLE_3G, subagents: [SUB] });
  await H.checkRole("r-t", "ID-T", { "ID-T": stopped(5 * MIN), ...subRunning() }, run);
  assert.ok(H.readSub("r-t"));
  const fin = deps({ reply: SAMPLE_3G, subagents: [SUB], now: NOW + 60_000 });
  const r = await H.checkRole("r-t", "ID-T", { "ID-T": stopped(5 * MIN), ...subRunning("CASCADE_RUN_STATUS_IDLE") }, fin);
  assert.equal(r, "resumed"); assert.equal(fin.wakes.length, 1);
  assert.equal(H.readSub("r-t"), null, "子 agent 跑完，标记收掉");
  assert.equal(H.readHealth("r-t").state, "resumed");
});

test("子 agent 已结束、员工之后发过 done：不续", async () => {
  H._resetMemory();
  await H.checkRole("r-u", "ID-U", { "ID-U": stopped(5 * MIN), ...subRunning() }, deps({ reply: SAMPLE_3G, subagents: [SUB] }));
  const fin = deps({ reply: SAMPLE_3G, subagents: [SUB], now: NOW + 60_000, task: task({ doneAfter: true }) });
  const r = await H.checkRole("r-u", "ID-U", { "ID-U": stopped(5 * MIN), ...subRunning("CASCADE_RUN_STATUS_IDLE") }, fin);
  assert.notEqual(r, "resumed"); assert.equal(fin.wakes.length, 0);
});

test("员工又动起来了（子 agent 汇报后被叫醒）：子 agent 标记收掉", async () => {
  H._resetMemory();
  await H.checkRole("r-v", "ID-V", { "ID-V": stopped(5 * MIN), ...subRunning() }, deps({ reply: SAMPLE_3G, subagents: [SUB] }));
  assert.ok(H.readSub("r-v"));
  await H.checkRole("r-v", "ID-V", { "ID-V": { status: "CASCADE_RUN_STATUS_RUNNING", stepCount: 300, lastModifiedTime: new Date(NOW).toISOString() } }, deps({ now: NOW + 30_000 }));
  assert.equal(H.readSub("r-v"), null);
});

test("lastActivity：最近一条有文字的回复；都是空的就写最后一次工具调用", async () => {
  const D = await import("../desk.mjs");
  const reply = (t) => ({ type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: t } });
  const tool = (name, args) => ({ type: "CORTEX_STEP_TYPE_GENERIC", metadata: { toolCall: { name, argumentsJson: JSON.stringify(args) } } });
  assert.equal(D.lastActivity([reply("先看任务单"), tool("run_command", { CommandLine: "ls" }), reply("")]), "先看任务单");
  assert.equal(D.lastActivity([reply(""), tool("run_command", { CommandLine: "pnpm tsc --noEmit", Cwd: "/x" })]), "run_command：pnpm tsc --noEmit");
  assert.equal(D.lastActivity([tool("write_file", { TargetFile: "/a/b.tsx", Content: "..." })]), "write_file：/a/b.tsx");
  assert.equal(D.lastActivity([]), "");
});
