// 对话撑爆的判断逻辑（不碰桌面端、不碰真实员工表）：node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "health-test-"));
process.env.HOME = HOME;
process.env.HUB_DIR = path.join(HOME, "agy-logs");   // 收件箱也落在临时目录里，别碰真实的
const H = await import("../health.mjs");
const D = await import("../desk.mjs");

const MIN = 60_000;
const failed = (extra = {}) => ({ status: "CASCADE_RUN_STATUS_IDLE", latestExecutorTerminationReason: "EXECUTOR_TERMINATION_REASON_ERROR", lastModifiedTime: "t1", stepCount: 100, ...extra });
const healthy = (extra = {}) => ({ status: "CASCADE_RUN_STATUS_IDLE", latestExecutorTerminationReason: "EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL", lastModifiedTime: "t1", stepCount: 100, ...extra });
const mkDeps = (o = {}) => {
  const sent = [], woke = [], calls = { inspect: 0, renew: 0, wake: 0, configs: 0 };
  return {
    sent, woke, calls,
    now: o.now ?? 1_000_000_000,
    // 额度报错默认当成 2 分钟前发生的（新鲜的才自动切）；要测「过期」就自己在 o.inspect 里写 lastAt
    inspect: async () => { calls.inspect++; const base = o.inspect ?? { overflow: true, liveMb: 31.5 }; return base.lastAt === undefined ? { ...base, lastAt: new Date((o.now ?? 1_000_000_000) - 2 * MIN).toISOString() } : base; },
    renew: async (role) => { calls.renew++; if (o.renewError) throw new Error(o.renewError); return { role, new: o.newId ?? "NEW-1", task: { id: "t42", time: "11-08 03:10", from: o.boss ?? "master-c", type: "task", text: "做看板第二轮的活" } }; },
    configs: async () => { calls.configs++; if (o.configsError) throw new Error(o.configsError); return o.configs ?? CLIENTS; },
    wake: async (id, text, opt) => { calls.wake++; woke.push({ id, text, model: opt?.model, role: opt?.role }); if (o.wakeError) throw new Error(o.wakeError); return opt?.model ?? "x"; },
    notify: (type, text, to = "主控") => sent.push({ type, text, to }),
  };
};

// 11-08 03:55 实测的样子：Claude 池（M400–M405）用完、13:07:54Z 重置；Gemini 池（M417/M318）满、16:20:51Z 重置
const RAW_CONFIGS = [
  { modelOrAlias: { model: "MODEL_PLACEHOLDER_M400" }, label: "Claude Opus 5.5 (Low)", quotaInfo: { resetTime: "2026-11-08T13:07:54Z" } },
  { modelOrAlias: { model: "MODEL_PLACEHOLDER_M402" }, label: "Claude Opus 5.5 (High)", quotaInfo: { resetTime: "2026-11-08T13:07:54Z" } },
  { modelOrAlias: { model: "MODEL_PLACEHOLDER_M405" }, label: "Claude Sonnet 5.5 (High)", quotaInfo: { resetTime: "2026-11-08T13:07:54Z" } },
  { modelOrAlias: { model: "MODEL_PLACEHOLDER_M417" }, label: "Gemini 4 Argon (High)", quotaInfo: { remainingFraction: 0.99, resetTime: "2026-11-08T16:20:51Z" } },
  { modelOrAlias: { model: "MODEL_PLACEHOLDER_M318" }, label: "Gemini 3.8 Flash (High)", quotaInfo: { remainingFraction: 0.5, resetTime: "2026-11-08T16:20:51Z" } },
];
const CLIENTS = D.normalizeConfigs(RAW_CONFIGS);
const allUsed = () => D.normalizeConfigs(RAW_CONFIGS.map((c) => ({ ...c, quotaInfo: { resetTime: "2026-11-08T13:07:54Z" } })));

const TEAM = path.join(HOME, ".config", "agy-team");
const setRole = (role, patch = {}) => {
  fs.mkdirSync(TEAM, { recursive: true });
  const file = path.join(TEAM, "roles.json");
  let all = {}; try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 还没有员工表 */ }
  all[role] = { kind: "desktop", desktop_id: `D-${role}`, ...patch };
  fs.writeFileSync(file, JSON.stringify(all));
};
const setInbox = (role, from) => {
  fs.mkdirSync(path.join(HOME, "agy-logs"), { recursive: true });
  const line = JSON.stringify({ id: "m1", at: Date.now(), time: "11-08 03:10", from, to: role, type: "task", text: "做额度切换的活" });
  fs.writeFileSync(path.join(HOME, "agy-logs", "inbox.jsonl"), line + "\n");
};
const QUOTA_INSPECT = { overflow: false, liveMb: 3, lastError: "RESOURCE_EXHAUSTED (code 429): Individual quota reached for this model. Resets in 1h27m", lastModel: "MODEL_PLACEHOLDER_M402" };

test("isOverflowSteps：只认最后一步是 30MB 报错", () => {
  const err = { type: "CORTEX_STEP_TYPE_ERROR_MESSAGE", errorMessage: { error: { modelErrorMessage: "FAILED_PRECONDITION (code 400): The message size (30683302 bytes) exceeds 30.000MB limit." } } };
  assert.equal(D.isOverflowSteps([{ type: "X" }, err]), true);
  assert.equal(D.isOverflowSteps([err, { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE" }]), false);
  assert.equal(D.isOverflowSteps([{ type: "CORTEX_STEP_TYPE_ERROR_MESSAGE", errorMessage: { error: { modelErrorMessage: "quota exceeded" } } }]), false);
  assert.equal(D.isOverflowSteps([]), false);
});

test("liveMb：已清理的步骤不算", () => {
  const big = { status: "CORTEX_STEP_STATUS_DONE", x: "a".repeat(2_000_000) };
  const cleared = { status: "CORTEX_STEP_STATUS_CLEARED", x: "a".repeat(9_000_000) };
  const mb = D.liveMb([big, cleared]);
  assert.ok(mb > 2 && mb < 2.1, String(mb));
});

test("looksFailed：停着且上一轮出错才算", () => {
  assert.equal(H.looksFailed(failed()), true);
  assert.equal(H.looksFailed(healthy()), false);
  assert.equal(H.looksFailed(failed({ status: "CASCADE_RUN_STATUS_RUNNING" })), false);
  assert.equal(H.looksFailed(undefined), false);
});

test("decideOverflow：10 分钟内最多换一次；换出来的新对话又报错只通知", () => {
  const now = 10 * 60 * MIN;
  assert.equal(H.decideOverflow({ id: "A", now }), "renew");
  assert.equal(H.decideOverflow({ id: "B", lastRenewAt: now - 3 * MIN, lastRenewTo: "X", now }), "notify");
  assert.equal(H.decideOverflow({ id: "B", lastRenewAt: now - 30 * MIN, lastRenewTo: "B", now }), "notify");
  assert.equal(H.decideOverflow({ id: "C", lastRenewAt: now - 11 * MIN, lastRenewTo: "B", now }), "renew");
});

test("shouldMeasure：步数没变不量；10 分钟内量过不量", () => {
  const now = 100 * MIN;
  assert.equal(H.shouldMeasure({ stepCount: 5, lastSteps: undefined, lastAt: 0, now }), true);
  assert.equal(H.shouldMeasure({ stepCount: 5, lastSteps: 5, lastAt: 0, now }), false);
  assert.equal(H.shouldMeasure({ stepCount: 6, lastSteps: 5, lastAt: now - 5 * MIN, now }), false);
  assert.equal(H.shouldMeasure({ stepCount: 6, lastSteps: 5, lastAt: now - 11 * MIN, now }), true);
});

test("checkRole：撑爆 → 自动换，写 renewed，通知一次（旧号、新号、续上的活）", async () => {
  H._resetMemory();
  const d = mkDeps();
  const r = await H.checkRole("t-a", "OLD-1", { "OLD-1": failed() }, d);
  assert.equal(r, "renewed");
  assert.equal(d.calls.renew, 1);
  const h = H.readHealth("t-a");
  assert.equal(h.state, "renewed"); assert.equal(h.old, "OLD-1"); assert.equal(h.new, "NEW-1"); assert.equal(h.at, d.now);
  assert.equal(d.sent.length, 2, "通知 主控 一条，再通知最后派活的人一条");
  assert.deepEqual(d.sent.map((x) => x.to), ["主控", "master-c"]);
  assert.ok(d.sent.every((x) => x.type === "help" && x.text === d.sent[0].text));
  for (const k of ["t-a", "OLD-1", "NEW-1", "t42", "做看板第二轮"]) assert.ok(d.sent[0].text.includes(k), k);
});

test("checkRole：最后派活的人就是 主控 时不重复通知", async () => {
  H._resetMemory();
  const d = mkDeps({ boss: "主控" });
  await H.checkRole("t-a2", "OLD-1", { "OLD-1": failed() }, d);
  assert.equal(d.sent.length, 1);
});

test("checkRole：换完新对话还是报错 → 只通知，不再换，同一状态不重复通知", async () => {
  H._resetMemory();
  const t0 = 2_000_000_000;
  await H.checkRole("t-b", "OLD-1", { "OLD-1": failed() }, mkDeps({ now: t0 }));          // 第一次：换
  const d2 = mkDeps({ now: t0 + 40_000 });
  const r2 = await H.checkRole("t-b", "NEW-1", { "NEW-1": failed({ lastModifiedTime: "t2" }) }, d2);   // 新对话也报错
  assert.equal(r2, "overflow-notified");
  assert.equal(d2.calls.renew, 0);
  assert.equal(H.readHealth("t-b").state, "overflow");
  assert.equal(d2.sent.length, 1); assert.equal(d2.sent[0].type, "help");
  const d3 = mkDeps({ now: t0 + 70_000 });
  await H.checkRole("t-b", "NEW-1", { "NEW-1": failed({ lastModifiedTime: "t2" }) }, d3);
  assert.equal(d3.calls.renew, 0); assert.equal(d3.sent.length, 0, "1 小时内不重复通知");
  assert.equal(d3.calls.inspect, 0, "同一状态不重复拉整段对话");
});

test("checkRole：摘要像失败但其实不是 30MB 报错 → 不换", async () => {
  H._resetMemory();
  const d = mkDeps({ inspect: { overflow: false, liveMb: 3 } });
  const r = await H.checkRole("t-c", "ID", { ID: failed() }, d);
  assert.notEqual(r, "renewed"); assert.equal(d.calls.renew, 0); assert.equal(d.sent.length, 0);
});

test("checkRole：自动换失败 → 只通知，不改员工表状态为 renewed", async () => {
  H._resetMemory();
  const d = mkDeps({ renewError: "找不到旧对话用过的模型" });
  const r = await H.checkRole("t-d", "ID", { ID: failed() }, d);
  assert.equal(r, "renew-failed");
  assert.equal(H.readHealth("t-d").state, "overflow");
  assert.equal(d.sent.length, 1); assert.ok(d.sent[0].text.includes("agent-hub renew t-d"));
});

test("checkRole：未清理内容 ≥ 预警线 → 写 big + 发 note，不自动换；1 小时内不重复", async () => {
  H._resetMemory();
  const t0 = 3_000_000_000;
  const d = mkDeps({ now: t0, inspect: { overflow: false, liveMb: 26.04 } });
  const r = await H.checkRole("t-e", "ID", { ID: healthy({ stepCount: 10 }) }, d);
  assert.equal(r, "big"); assert.equal(d.calls.renew, 0);
  const h = H.readHealth("t-e"); assert.equal(h.state, "big"); assert.equal(h.mb, 26);
  assert.equal(d.sent.length, 1); assert.equal(d.sent[0].type, "note");
  const d2 = mkDeps({ now: t0 + 11 * MIN, inspect: { overflow: false, liveMb: 27 } });
  await H.checkRole("t-e", "ID", { ID: healthy({ stepCount: 12 }) }, d2);
  assert.equal(d2.sent.length, 0, "1 小时内不重复发 note");
});

test("checkRole：正常的对话写 ok；刚换过的 renewed 保留一阵子不被盖掉", async () => {
  H._resetMemory();
  const t0 = 4_000_000_000;
  const d = mkDeps({ now: t0, inspect: { overflow: false, liveMb: 5 } });
  assert.equal(await H.checkRole("t-f", "ID", { ID: healthy({ stepCount: 1 }) }, d), "ok");
  assert.equal(H.readHealth("t-f").state, "ok");
  H.writeHealth("t-g", { state: "renewed", at: t0, old: "A", new: "B" });
  H._resetMemory();
  await H.checkRole("t-g", "B", { B: healthy({ stepCount: 1 }) }, mkDeps({ now: t0 + MIN, inspect: { overflow: false, liveMb: 1 } }));
  assert.equal(H.readHealth("t-g").state, "renewed");
  H._resetMemory();
  await H.checkRole("t-g", "B", { B: healthy({ stepCount: 2 }) }, mkDeps({ now: t0 + 31 * MIN, inspect: { overflow: false, liveMb: 1 } }));
  assert.equal(H.readHealth("t-g").state, "ok");
});

test("pickLastTask：task 或 reply 都算、任何发件人都算，带前后各 3 条往来", () => {
  const J = (id, time, from, to, type, text) => JSON.stringify({ id, time, from, to, type, text });
  const lines = [
    J("m1", "11-07 10:00", "主控", "3z", "task", "11-07 的旧单"),
    J("m2", "11-07 12:00", "3z", "主控", "done", "旧单做完"),
    J("x0", "11-08 00:50", "master-c", "别人", "task", "和 3z 无关的消息"),
    J("m3", "11-08 01:00", "master-c", "3z", "task", "新单一"),
    J("m4", "11-08 01:10", "3z", "master-c", "progress", "进度"),
    J("m5", "11-08 01:20", "3z", "master-c", "done", "新单一完成"),
    J("m6", "11-08 01:30", "master-c", "3z", "reply", "审过了，下一单：写 FAQ"),
    "不是 JSON",
    J("m7", "11-08 01:40", "3z", "master-c", "progress", "开始写"),
    J("s1", "11-08 01:45", "系统", "3z", "note", "系统通知不算"),
    J("m8", "11-08 01:50", "3z", "master-c", "progress", "写到一半"),
    J("m9", "11-08 01:55", "3z", "master-c", "progress", "快好了"),
    J("m10", "11-08 02:00", "3z", "master-c", "progress", "第四条（超出后 3 条）"),
  ];
  const t = D.pickLastTask(lines, "3z");
  assert.equal(t.id, "m6"); assert.equal(t.type, "reply"); assert.equal(t.from, "master-c");
  assert.equal(t.doneAfter, false);
  assert.deepEqual(t.before.map((x) => x.id), ["m3", "m4", "m5"], "前 3 条往来，不含和它无关的 x0");
  assert.deepEqual(t.after.map((x) => x.id), ["m7", "s1", "m8"], "后 3 条往来");
  assert.equal(D.pickLastTask(lines, "nobody"), null);
  const withDone = [...lines.slice(0, 7), J("m11", "11-08 01:35", "3z", "master-c", "done", "做完了"), ...lines.slice(7)];
  assert.equal(D.pickLastTask(withDone, "3z").doneAfter, true, "它之后员工发过 done");
  assert.equal(D.pickLastTask([J("a", "t", "系统", "3z", "task", "x"), J("b", "t", "3z", "3z", "task", "x")], "3z"), null, "系统和自己发的不算");
});

test("extractIdentity / buildRenewMessage", () => {
  assert.equal(D.extractIdentity("你是 3z。\n\n【新对话】老的说明\n旧活"), "你是 3z。");
  const t = { id: "m6", time: "11-08 01:30", from: "master-c", type: "reply", text: "审过了，下一单：写 FAQ", doneAfter: true,
    before: [{ time: "11-08 01:00", from: "master-c", to: "3z", type: "task", text: "新单一" }], after: [{ time: "11-08 01:40", from: "3z", to: "master-c", type: "progress", text: "开始写" }] };
  const msg = D.buildRenewMessage({ role: "3z", identity: "你是 3z，在 /旧目录 干活。", task: t, note: "派活人是 master-c。工作目录看活里写的。" });
  for (const k of ["你是 3z，在 /旧目录 干活。", "以最后一条活里写的工作目录为准", "超过 30MB 上限", "sips -Z 1280", "做完回报给 master-c", "to=master-c", "me=3z",
    "审过了，下一单：写 FAQ", "消息 m6", "新单一", "开始写", "就是上面这条"]) assert.ok(msg.includes(k), k);
  assert.ok(msg.includes("这条之后你发过 done"), "之后发过 done 要提醒先确认");
  assert.ok(msg.indexOf("【派活人补充】") > 0 && msg.indexOf("【派活人补充】") < msg.indexOf("原文："), "补充放在续上的活前面");
  assert.ok(msg.includes("派活人是 master-c。工作目录看活里写的。"));
  const none = D.buildRenewMessage({ role: "3z", identity: "", task: null });
  assert.ok(none.includes("没找到发给你的活") && !none.includes("【派活人补充】"));
  assert.ok(D.buildRenewMessage({ role: "3z", identity: "x", task: null, note: "  " }).indexOf("【派活人补充】") < 0, "空 note 不加");
});

// ---------------------------------------------------------------- 额度用完自动切换（11-08）
test("isQuotaError：认额度类报错，不认撑爆和普通错误", () => {
  for (const t of [
    "RESOURCE_EXHAUSTED (code 429): Individual quota reached for this model. Resets in 1h27m",
    "quota reached", "429 Too Many Requests", "Rate limit exceeded", "insufficient balance", "Insufficient credits", "402 Payment Required",
  ]) assert.equal(D.isQuotaError(t), true, t);
  for (const t of [
    "The message size (30683302 bytes) exceeds 30.000MB limit.",
    "FAILED_PRECONDITION (code 400): bad request", "", null, undefined,
  ]) assert.equal(D.isQuotaError(t), false, String(t));
});

test("chainFor / pickFallback：按池给默认链，取第一个还有额度的，跳过没额度的和原模型", () => {
  assert.deepEqual(D.chainFor("MODEL_PLACEHOLDER_M402", CLIENTS), ["Gemini 4 Argon (High)", "Gemini 3.8 Flash (High)"], "Claude 用完换 Gemini");
  assert.deepEqual(D.chainFor("MODEL_PLACEHOLDER_M417", CLIENTS), ["Claude Opus 5.5 (High)"], "Gemini 用完换 Claude");
  assert.deepEqual(D.chainFor("MODEL_PLACEHOLDER_M402", CLIENTS, ["Gemini 3.8 Flash (High)"]), ["Gemini 3.8 Flash (High)"], "员工表写了就按员工表");
  const p = D.pickFallback({ from: "MODEL_PLACEHOLDER_M402", chain: D.chainFor("MODEL_PLACEHOLDER_M402", CLIENTS), configs: CLIENTS });
  assert.equal(p.label, "Gemini 4 Argon (High)");
  // Argon 也快用完（≤0.05）→ 退到第二备选
  const argonOut = CLIENTS.map((c) => (c.model === "MODEL_PLACEHOLDER_M417" ? { ...c, remaining: 0.02 } : c));
  assert.equal(D.pickFallback({ from: "MODEL_PLACEHOLDER_M402", chain: ["Gemini 4 Argon (High)", "Gemini 3.8 Flash (High)"], configs: argonOut }).label, "Gemini 3.8 Flash (High)");
  assert.equal(D.pickFallback({ from: "MODEL_PLACEHOLDER_M402", chain: ["Gemini 4 Argon (High)"], configs: allUsed() }), null, "备选都没额度");
  assert.equal(D.pickFallback({ from: "MODEL_PLACEHOLDER_M402", chain: [], configs: CLIENTS }), null, "没有备选链");
});

test("pickPlanModel：首选池有额度回首选，用完走备选，都没额度返回 null；额度回来又回首选", () => {
  assert.equal(D.pickPlanModel({ preferred: "MODEL_PLACEHOLDER_M417", configs: CLIENTS }).model, "MODEL_PLACEHOLDER_M417", "Gemini 池还有额度");
  assert.equal(D.pickPlanModel({ preferred: "MODEL_PLACEHOLDER_M402", configs: CLIENTS }).model, "MODEL_PLACEHOLDER_M417", "Claude 池用完走备选");
  assert.equal(D.pickPlanModel({ preferred: "MODEL_PLACEHOLDER_M402", configs: allUsed() }), null);
  const back = CLIENTS.map((c) => (c.pool === "claude" ? { ...c, remaining: 1 } : c));
  assert.equal(D.pickPlanModel({ preferred: "MODEL_PLACEHOLDER_M402", configs: back }).label, "Claude Opus 5.5 (High)", "重置后回首选");
});

test("nextReset / clockText：重置时间按池取最近的，短句用本地时间", () => {
  assert.equal(H.nextReset(CLIENTS, 0), "2026-11-08T13:07:54.000Z");
  assert.equal(H.nextReset(allUsed(), 0), "2026-11-08T13:07:54.000Z");
  assert.equal(H.nextReset([], 0), "");
  assert.equal(H.nextReset(CLIENTS, Date.parse("2026-11-09T00:00:00Z")), "", "都过了就没有");
  const t = Date.parse("2026-11-08T20:07:54Z");
  assert.equal(D.clockText("2026-11-08T13:07:54Z", t), D.clockText("2026-11-08T13:07:54Z", t + 0));
  assert.match(D.clockText("2026-11-08T13:07:54Z", t), /^\d{2}:\d{2}$/, "同一天只写时分");
  assert.match(D.clockText("2026-11-09T13:07:54Z", t), /^\d{2}-\d{2} \d{2}:\d{2}$/, "跨天带日期");
  assert.equal(D.clockText("坏时间", t), "额度恢复后");
});

test("checkRole：额度用完 → 同一个对话换备用模型，写 fallback，通知主控和派活人", async () => {
  H._resetMemory();
  setRole("q-a"); setInbox("q-a", "master-c");
  const t0 = Date.parse("2026-11-08T11:40:00Z");
  const d = mkDeps({ now: t0, inspect: QUOTA_INSPECT });
  const r = await H.checkRole("q-a", "D-q-a", { "D-q-a": failed({ lastModifiedTime: "t-quota" }) }, d);
  assert.equal(r, "fallback");
  assert.equal(d.calls.wake, 1);
  assert.deepEqual({ id: d.woke[0].id, model: d.woke[0].model, role: d.woke[0].role }, { id: "D-q-a", model: "MODEL_PLACEHOLDER_M417", role: "q-a" }, "同一个对话，用备用模型，带上员工号");
  assert.equal(d.woke[0].text, "刚才额度用完了，现在换成 Gemini 4 Argon (High) 接着做刚才那单，从断的地方继续。");
  const h = H.readHealth("q-a");
  assert.equal(h.state, "fallback");
  assert.equal(h.model, "Gemini 4 Argon (High)");
  assert.equal(h.from, "Claude Opus 5.5 (High)");
  assert.equal(h.until, "2026-11-08T13:07:54.000Z");
  assert.equal(h.at, t0);
  assert.deepEqual(d.sent.map((x) => x.to), ["主控", "master-c"]);
  assert.ok(d.sent.every((x) => x.type === "help"));
  for (const k of ["q-a", "Claude Opus 5.5 (High)", "Gemini 4 Argon (High)", D.clockText(h.until, t0), "切回"]) assert.ok(d.sent[0].text.includes(k), k);
  // 同一失败状态再看一轮：不重复叫醒
  const d2 = mkDeps({ now: t0 + 30_000, inspect: QUOTA_INSPECT });
  await H.checkRole("q-a", "D-q-a", { "D-q-a": failed({ lastModifiedTime: "t-quota" }) }, d2);
  assert.equal(d2.calls.wake, 0);
  assert.equal(d2.sent.length, 0);
});

test("checkRole：额度报错是 30 分钟前的 → 不叫醒、不通知，只记 quota 给看板（活早有人接手了）", async () => {
  H._resetMemory();
  setRole("q-old"); setInbox("q-old", "master-c");
  const t0 = Date.parse("2026-11-08T11:40:00Z");
  const d = mkDeps({ now: t0, inspect: { ...QUOTA_INSPECT, lastAt: new Date(t0 - 30 * MIN).toISOString() } });
  assert.equal(await H.checkRole("q-old", "D-q-old", { "D-q-old": failed({ lastModifiedTime: "t-old" }) }, d), "quota-stale");
  assert.equal(d.calls.wake, 0, "别把别人做过的活重做一遍");
  assert.equal(d.sent.length, 0, "过期的报错不打扰主控和派活人");
  const h = H.readHealth("q-old");
  assert.equal(h.state, "quota");
  assert.equal(h.stale, true);
  assert.equal(h.from, "Claude Opus 5.5 (High)");
  assert.equal(h.until, "2026-11-08T13:07:54.000Z", "看板角落要靠 until 显示恢复时间");
});

test("checkRole：额度报错是 2 分钟前的 → 照样自动切备用模型", async () => {
  H._resetMemory();
  setRole("q-new"); setInbox("q-new", "master-c");
  const t0 = Date.parse("2026-11-08T11:40:00Z");
  const d = mkDeps({ now: t0, inspect: { ...QUOTA_INSPECT, lastAt: new Date(t0 - 2 * MIN).toISOString() } });
  assert.equal(await H.checkRole("q-new", "D-q-new", { "D-q-new": failed({ lastModifiedTime: "t-new" }) }, d), "fallback");
  assert.equal(d.calls.wake, 1);
  assert.equal(d.woke[0].model, "MODEL_PLACEHOLDER_M417");
  assert.equal(H.readHealth("q-new").state, "fallback");
});

test("checkRole：过期报错连额度接口都读不出来，也要记 quota（看板照样能进角落）", async () => {
  H._resetMemory();
  const t0 = Date.parse("2026-11-08T11:40:00Z");
  const d = mkDeps({ now: t0, configsError: "调不通", inspect: { ...QUOTA_INSPECT, lastAt: new Date(t0 - 3 * 60 * MIN).toISOString() } });
  assert.equal(await H.checkRole("q-old2", "D-q-old2", { "D-q-old2": failed({ lastModifiedTime: "k" }) }, d), "quota-stale");
  const h = H.readHealth("q-old2");
  assert.equal(h.state, "quota"); assert.equal(h.until, ""); assert.equal(h.stale, true);
  assert.equal(d.sent.length, 0); assert.equal(d.calls.wake, 0);
});

test("checkRole：备选都没额度 → 写 quota，不叫醒，重置前不再试也不重复通知", async () => {
  H._resetMemory();
  setRole("q-b"); setInbox("q-b", "master-c");
  const t0 = Date.parse("2026-11-08T11:40:00Z");
  const d = mkDeps({ now: t0, configs: allUsed(), inspect: QUOTA_INSPECT });
  assert.equal(await H.checkRole("q-b", "D-q-b", { "D-q-b": failed({ lastModifiedTime: "t-quota" }) }, d), "quota");
  assert.equal(d.calls.wake, 0, "没有可用模型就别发消息");
  const h = H.readHealth("q-b");
  assert.equal(h.state, "quota"); assert.equal(h.until, "2026-11-08T13:07:54.000Z"); assert.equal(h.from, "Claude Opus 5.5 (High)");
  assert.deepEqual(d.sent.map((x) => x.to), ["主控", "master-c"]);
  assert.ok(d.sent[0].text.includes("没有可用模型") && d.sent[0].text.includes(D.clockText(h.until, t0)));
  // 同一个失败：连 health 都不该被大小检查盖成 ok
  const d2 = mkDeps({ now: t0 + 30_000, configs: allUsed(), inspect: QUOTA_INSPECT });
  await H.checkRole("q-b", "D-q-b", { "D-q-b": failed({ lastModifiedTime: "t-quota" }) }, d2);
  assert.equal(H.readHealth("q-b").state, "quota");
  // 换了新的失败（key 变了）但还没到重置时间：也不再试
  const d3 = mkDeps({ now: t0 + 60_000, configs: allUsed(), inspect: QUOTA_INSPECT });
  assert.equal(await H.checkRole("q-b", "D-q-b", { "D-q-b": failed({ lastModifiedTime: "t-quota-2" }) }, d3), "quota-wait");
  assert.equal(d3.calls.wake, 0); assert.equal(d3.calls.configs, 0); assert.equal(d3.sent.length, 0);
});

test("checkRole：额度接口读不出来 → 这轮不切、不写死状态", async () => {
  H._resetMemory();
  const d = mkDeps({ inspect: QUOTA_INSPECT, configsError: "调不通" });
  assert.equal(await H.checkRole("q-f", "D-q-f", { "D-q-f": failed({ lastModifiedTime: "k" }) }, d), "quota-unknown");
  assert.equal(d.calls.wake, 0); assert.equal(d.sent.length, 0);
  assert.equal(H.readHealth("q-f"), null);
});

test("checkRole：换模型的叫醒发不出去 → 写 quota，通知请手动换", async () => {
  H._resetMemory();
  const t0 = Date.parse("2026-11-08T11:40:00Z");
  const d = mkDeps({ now: t0, inspect: QUOTA_INSPECT, wakeError: "调不通：503" });
  assert.equal(await H.checkRole("q-g", "D-q-g", { "D-q-g": failed({ lastModifiedTime: "k" }) }, d), "fallback-failed");
  const h = H.readHealth("q-g");
  assert.equal(h.state, "quota"); assert.equal(h.until, "2026-11-08T13:07:54.000Z"); assert.ok(h.error.includes("503"));
  assert.ok(d.sent[0].text.includes("自动换模型失败"));
});

test("checkRole：都没额度时隔一阵会再看一眼，但 1 小时内只通知一次", async () => {
  H._resetMemory();
  setRole("q-e"); setInbox("q-e", "master-c");
  const t0 = Date.parse("2026-11-08T13:10:00Z");
  H.writeHealth("q-e", { state: "quota", at: t0 - 3600_000, from: "Claude Opus 5.5 (High)", until: "2026-11-08T13:07:54Z" });
  const d = mkDeps({ now: t0, configs: allUsed(), inspect: QUOTA_INSPECT });
  assert.equal(await H.checkRole("q-e", "D-q-e", { "D-q-e": failed({ lastModifiedTime: "k1" }) }, d), "quota", "重置时间过了，再看一眼");
  assert.equal(d.sent.length, 2);
  const d2 = mkDeps({ now: t0 + 30_000, configs: allUsed(), inspect: QUOTA_INSPECT });
  assert.equal(await H.checkRole("q-e", "D-q-e", { "D-q-e": failed({ lastModifiedTime: "k2" }) }, d2), "quota");
  assert.equal(d2.sent.length, 0, "1 小时内不重复通知");
});

test("checkRole：重置换不清况不明时按 1 小时冷却，不每 30 秒重试", async () => {
  H._resetMemory();
  const t0 = Date.parse("2026-11-08T11:40:00Z");
  const noReset = CLIENTS.map((c) => ({ ...c, resetTime: "" }));
  const d = mkDeps({ now: t0, configs: noReset.map((c) => ({ ...c, remaining: 0 })), inspect: QUOTA_INSPECT });
  assert.equal(await H.checkRole("q-h", "D-q-h", { "D-q-h": failed({ lastModifiedTime: "k1" }) }, d), "quota");
  const h = H.readHealth("q-h");
  assert.equal(h.until, "", "读不出重置时间就留空");
  const d2 = mkDeps({ now: t0 + 30 * MIN, configs: noReset.map((c) => ({ ...c, remaining: 0 })), inspect: QUOTA_INSPECT });
  assert.equal(await H.checkRole("q-h", "D-q-h", { "D-q-h": failed({ lastModifiedTime: "k2" }) }, d2), "quota-wait");
  assert.equal(d2.calls.configs, 0);
});

test("checkRole：不再报错 → 备用态收回 ok；没到重置时间就保留", async () => {
  H._resetMemory();
  H.writeHealth("q-c", { state: "fallback", at: Date.parse("2026-11-08T12:00:00Z"), model: "Gemini 4 Argon (High)", from: "Claude Opus 5.5 (High)", until: "2026-11-08T13:07:54Z" });
  const t0 = Date.parse("2026-11-08T13:10:00Z");
  assert.equal(await H.checkRole("q-c", "D-q-c", { "D-q-c": healthy({ stepCount: 3 }) }, mkDeps({ now: t0, inspect: { overflow: false, liveMb: 2 } })), "ok");
  assert.equal(H.readHealth("q-c").state, "ok", "重置时间过了、活也不再报错 → 收回 ok");

  H._resetMemory();
  const t1 = Date.parse("2026-11-08T12:10:00Z");
  H.writeHealth("q-d", { state: "fallback", at: t1, model: "Gemini 4 Argon (High)", from: "Claude Opus 5.5 (High)", until: "2026-11-08T13:07:54Z" });
  await H.checkRole("q-d", "D-q-d", { "D-q-d": healthy({ stepCount: 1 }) }, mkDeps({ now: t1, inspect: { overflow: false, liveMb: 2 } }));
  assert.equal(H.readHealth("q-d").state, "fallback", "没到重置时间，「已切 Gemini」要留着给看板看");
});
