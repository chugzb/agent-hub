// 反重力员工对话的健康检查：撑爆了就自动换新对话，快撑爆了提前预警。由 bridges.mjs 每 30 秒调一次 healthTick。
// 状态写到 ~/agy-logs/presence/<员工>.health.json，看板下一轮会读：
//   {state:"renewed", at, old, new}   刚自动换过新对话
//   {state:"overflow", at, old, new}  撑爆了但没换（10 分钟内换过，或者换完新对话还是报错），只通知
//   {state:"big", at, mb}             未清理的内容已经很大，快到 30MB，不自动换
//   {state:"fallback", at, model, from, until}  额度用完，已自动换成备用模型接着干
//   {state:"quota", at, until, from}  额度用完、备选也都没额度，等 until 恢复，这期间不再重试
//   {state:"resumed", at, count, taskId, gaveUp?}  话说一半就收工，已自动叫醒续上 count 次（gaveUp=true：续满次数还是停，只通知）
//   <员工>.sub.json {at, running:[{id, steps, said}]}  员工把活交给了反重力子 agent、子 agent 还在跑（看板显示「子 agent 在做：…」）
//   {state:"ok", at}                  正常
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  inspect as deskInspect, renew as deskRenew, summaries as deskSummaries, wake as deskWake,
  modelConfigs as deskConfigs, isQuotaError, pickFallback, chainFor, poolOf, configLabel, clockText,
  familyName, readRoles, lastTaskFrom, lastTaskOf, peekReply,
} from "./desk.mjs";

export const BIG_MB = 24;                 // 未清理的内容到这个数就预警（上限 30MB，留几轮的余量）
export const RENEW_COOLDOWN_MS = 10 * 60_000;   // 同一个员工 10 分钟内最多自动换一次
export const SIZE_CHECK_MS = 10 * 60_000;       // 量大小要把整段对话拉下来，每个员工最多 10 分钟量一次，而且只在步数变了才量
export const NOTIFY_AGAIN_MS = 60 * 60_000;     // 同一种预警 1 小时内不重复发
export const QUOTA_FRESH_MS = 10 * 60_000;      // 额度报错超过这个时间就不自动叫醒了：那单多半已经有人接手做完，叫醒会重做一遍
export const RENEWED_SHOW_MS = 30 * 60_000;     // 「已自动换新对话」的状态至少保留 30 分钟再改回 ok
export const RESUME_MAX = 2;                      // 同一单最多自动续几次
export const RESUME_GRACE_MS = 2 * 60_000;        // 停下后先等 2 分钟：后台命令跑完，反重力自己可能会接着干，别抢
export const RESUME_MAX_AGE_MS = 6 * 3600_000;    // 停了超过 6 小时的不自动叫醒（多半已经被人接手或放弃）
export const RESUMED_SHOW_MS = 30 * 60_000;       // 「自动续上」状态至少保留 30 分钟再改回 ok
const TERMINATION_ERROR = "EXECUTOR_TERMINATION_REASON_ERROR";
const TERMINATION_NO_TOOL = "EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL";
const IDLE = "CASCADE_RUN_STATUS_IDLE";

const HOME = () => process.env.HOME || os.homedir();
const presenceDir = () => path.join(HOME(), "agy-logs", "presence");
const healthFile = (role) => path.join(presenceDir(), `${encodeURIComponent(role)}.health.json`);
const rolesFile = () => path.join(HOME(), ".config", "agy-team", "roles.json");
const NOTIFY_TO = () => process.env.HUB_NOTIFY_TO || "主控";

export function readHealth(role) { try { return JSON.parse(fs.readFileSync(healthFile(role), "utf8")); } catch { return null; } }
export function writeHealth(role, obj) {
  fs.mkdirSync(presenceDir(), { recursive: true });
  const tmp = `${healthFile(role)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj) + "\n");
  fs.renameSync(tmp, healthFile(role));
}

/** 摘要里长这样才值得去拉整段对话确认：停着（IDLE）而且上一轮是因为出错结束的 */
export function looksFailed(summary) {
  return !!summary && summary.status === IDLE && summary.latestExecutorTerminationReason === TERMINATION_ERROR;
}

/**
 * 撑爆了该怎么办（纯函数，好测）：
 *  "renew"  —— 换新对话
 *  "notify" —— 只通知：10 分钟内刚换过，或者当前这个对话就是上次自动换出来的（换完还报错，别再换了）
 */
export function decideOverflow({ id, lastRenewAt = 0, lastRenewTo = "", now }) {
  if (lastRenewTo && id === lastRenewTo) return "notify";
  if (now - lastRenewAt < RENEW_COOLDOWN_MS) return "notify";
  return "renew";
}

/** 要不要现在去量一次大小（纯函数）：步数没变不量；10 分钟内量过不量 */
export function shouldMeasure({ stepCount, lastSteps, lastAt = 0, now }) {
  return stepCount !== lastSteps && now - lastAt >= SIZE_CHECK_MS;
}

/** 所有额度池里最近的一次重置时间（都没额度时用它当「什么时候恢复」） */
export function nextReset(configs, now) {
  const ts = [];
  for (const pool of new Set((configs ?? []).map((c) => c.pool))) {
    const t = Date.parse(poolOf(configs, pool)?.until ?? "");
    if (Number.isFinite(t) && t > now) ts.push(t);
  }
  return ts.length ? new Date(Math.min(...ts)).toISOString() : "";
}

/** 停着（IDLE），上一轮是「没有再调工具」自己结束的 */
export function looksStopped(summary) {
  return !!summary && summary.status === IDLE && summary.latestExecutorTerminationReason === TERMINATION_NO_TOOL;
}

// 「话说一半」的话：只看最后 200 个字，关键词表 + 结尾不是收尾的话，别太聪明（中英文都认）
const UNFINISHED = [
  /正在/, /待[^。！？\n]{0,24}(完成|结束|返回|就绪|跑完)/, /稍后(继续|再)/, /(完成|结束|返回|跑完)后[^。！？\n]{0,6}(立即|马上|再|继续|开始)/,
  /后台[^。！？\n]{0,16}(运行|执行|抓取|任务|命令)/, /(接下来|下一步)[^。！？\n]{0,6}(将|会|我)/, /我将(继续|等待|读取|开始)/, /继续(执行|抓取|读取|撰写|处理)/,
  /\bI['’]?ll (wait|continue|verify|check|proceed|resume)\b/i, /\bwait(ing)? (for|on)\b/i, /\bwill (continue|resume|proceed|verify)\b/i,
  /\bonce\b[^.!?\n]{0,80}\b(finish(es)?|complete[sd]?|done|ready|returns?|report)\b/i, /\b(running|runs) (in|on) (the |a )?(background|sub-?agent)\b/i, /\bin the background\b/i,
  /\b(then|and) (verify|send)\b/i,
];
const FINISHED_ZH = /(已完成|做完了?|完成了?|收工|结束这一轮|等(新活|下一单|你的?指示)|待命|已回报|已发(送)?\s*(done|给\s*\S{1,30})|提交号\s*\w+)[\s。.!！)）」"]*$/i;
const FINISHED_EN = /(\bsent done|\bhave sent|\balready sent|\bcommitted|\ball done|\bis done|\bare done|\bwaiting for (the )?next (task|assignment|one|job)|\bready for (the )?next|\bstanding by)[^.!?\n]{0,40}[.!)"”\s]*$|^\W*done\W*$/i;
const FUTURE_SEND = /\b(will|I['’]?ll|then|and|to)\s+send\b/i;   // 「then verify and send done」是还没发，别当成收尾
export function looksUnfinished(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  const end = t.slice(-60);
  if ((FINISHED_ZH.test(t.slice(-40)) || FINISHED_EN.test(end)) && !FUTURE_SEND.test(end)) return false;
  const tail = t.slice(-200);
  return UNFINISHED.some((re) => re.test(tail));
}
/** 最后一句（给通知和叫醒消息引用） */
const lastSentence = (text, n = 120) => { const t = String(text ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? "…" + t.slice(-n) : t; };

const RUNNING = "CASCADE_RUN_STATUS_RUNNING";
/** 员工交给反重力子 agent 的对话里，哪些还在跑（S 是摘要表） */
export function runningSubagents(ids, S) { return (ids ?? []).filter((x) => S?.[x]?.status === RUNNING); }

/** 便宜的预检（不用拉整段对话）：停了够久、没停太久、发给它的最后一条活之后它没发过 done / help */
export function resumeGate({ summary, task, now }) {
  if (!looksStopped(summary)) return "not-stopped";
  const age = now - Date.parse(summary.lastModifiedTime ?? "");
  if (!(age >= RESUME_GRACE_MS)) return "wait";
  if (age > RESUME_MAX_AGE_MS) return "stale";
  if (!task) return "no-task";
  if (task.doneAfter || task.helpAfter) return "replied";
  return "ok";
}

/** 拉了整段对话之后的判断（纯函数）：不像半路收工 → none；续过 RESUME_MAX 次还是停 → giveup；否则 resume（count 是这次续完后的次数） */
export function decideResume({ info, task, state, now }) {
  void now;
  if (!looksUnfinished(info?.lastReply)) return { act: "none", why: "not-unfinished" };
  if (info.lastType === "CORTEX_STEP_TYPE_ERROR_MESSAGE" || info.lastReplyFromEnd < 0 || info.lastReplyFromEnd > 3) return { act: "none", why: "not-last-turn" };
  const same = state?.taskId === task?.id;
  if (same && state.gaveUp) return { act: "none", why: "gave-up" };
  const count = same ? state.count ?? 0 : 0;
  if (count >= RESUME_MAX) return { act: "giveup", count };
  return { act: "resume", count: count + 1 };
}

const resumeFile = (role) => path.join(presenceDir(), `${encodeURIComponent(role)}.resume.json`);
const readResume = (role) => { try { return JSON.parse(fs.readFileSync(resumeFile(role), "utf8")); } catch { return null; } };
const writeResume = (role, obj) => { fs.mkdirSync(presenceDir(), { recursive: true }); fs.writeFileSync(resumeFile(role), JSON.stringify(obj) + "\n"); };

/** 给主控发通知（走 agent-hub 的 send_message，发件人写「系统」） */
export function notify(type, text, to = NOTIFY_TO()) {
  const hub = path.join(path.dirname(new URL(import.meta.url).pathname), "server.mjs");
  const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { me: "系统", to, type, text } } });
  spawnSync(process.execPath, [hub], { input: req + "\n", env: { ...process.env, HUB_SIDE: "employee" }, encoding: "utf8" });
}

const mem = new Map();   // 员工 → { lastRenewAt, lastRenewTo, checkedKey, info, overflow, quotaKey, lastSteps, lastSizeAt, notifiedAt:{overflow,big,quota} }
const memOf = (role) => {
  let m = mem.get(role);
  if (!m) {
    const h = readHealth(role) ?? {};
    m = { lastRenewAt: h.lastRenewAt ?? 0, lastRenewTo: h.lastRenewTo ?? "", notifiedAt: {}, lastSteps: undefined, lastSizeAt: 0 };
    mem.set(role, m);
  }
  return m;
};
export const _resetMemory = () => mem.clear();

const brief = (t) => (t ? `消息 ${t.id}（${t.time}，${t.from} 发的 ${t.type}）：${String(t.text).replace(/\s+/g, " ").slice(0, 60)}${t.text.length > 60 ? "…" : ""}` : "收件箱里没找到发给它的活");

/**
 * 额度用完怎么接：在同一个对话里换成还有额度的模型，接着做刚才那单（上下文保留）。
 *  - 有备选 → 发「现在换成 X」→ health = fallback（model/from/until）
 *  - 都没有 → health = quota，等 until 恢复，这期间不再重试
 * 员工表的 fallback_models 优先，没写按原模型所在的额度池给默认链（desk.mjs 的 chainFor）。
 */
export async function quotaStep(role, id, info, { m, now, say, configs, wake }) {
  const h = readHealth(role) ?? {};
  // 记过「都没额度」：没到重置时间就不再试，每 30 秒试一次没有意义；
  // 连重置时间都读不出来时退一步按 1 小时冷却（跟通知去重同一个钟）
  const untilTs = Date.parse(h.until ?? "");
  const waitUntil = h.state === "quota" ? (Number.isFinite(untilTs) ? untilTs : (h.at ?? 0) + NOTIFY_AGAIN_MS) : NaN;
  if (Number.isFinite(waitUntil) && now < waitUntil) return "quota-wait";

  let list = [];
  try { list = await configs(); } catch { /* 额度接口读不出来这轮就不切，下一轮再看 */ }

  const r = readRoles()[role] ?? {};
  const fromId = info.lastModel || r.plan_model || "";
  const fromLabel = configLabel(list, fromId) || fromId || "这个模型";
  const own = list.find((c) => c.model === fromId || c.label === fromId);
  const until = (own ? poolOf(list, own.pool)?.until : "") || nextReset(list, now);
  const keep = { lastRenewAt: m.lastRenewAt, lastRenewTo: m.lastRenewTo };

  // 报错不是刚发生的（超过 10 分钟），比如早上额度用完、活早就被别人接手做完了：
  // 只把「额度用完」记给看板（进额度用完角落），不叫醒、不通知，免得叫醒它把做过的那单重做一遍。
  const errAt = Date.parse(info.lastAt ?? "");
  if (!(Number.isFinite(errAt) && now - errAt <= QUOTA_FRESH_MS)) {
    writeHealth(role, { state: "quota", at: now, from: fromLabel, until, stale: true, ...keep });
    return "quota-stale";
  }
  if (!list.length) return "quota-unknown";
  const once = () => {   // 同一个员工 1 小时内同类通知只发一次
    if (m.notifiedAt.quota && now - m.notifiedAt.quota < NOTIFY_AGAIN_MS) return false;
    m.notifiedAt.quota = now;
    return true;
  };

  // 主控和最后派活的人都得知道：派活的人正卡在等这单
  const tell = (msg) => {
    say("help", msg);
    const boss = lastTaskFrom(role);
    if (boss && boss !== NOTIFY_TO() && boss !== "系统" && boss !== role) say("help", msg, boss);
  };

  const pick = pickFallback({ from: fromId || fromLabel, chain: chainFor(fromId || fromLabel, list, r.fallback_models), configs: list });
  if (!pick) {
    writeHealth(role, { state: "quota", at: now, from: fromLabel, until, ...keep });
    if (once()) tell(`【没有可用模型】${role} 的 ${fromLabel} 额度用完，备用模型也都用完了，${clockText(until, now)} 恢复；这期间不再重试，请把这些活转给别人。`);
    return "quota";
  }

  const text = `刚才额度用完了，现在换成 ${pick.label} 接着做刚才那单，从断的地方继续。`;
  try {
    await wake(id, text, { model: pick.model, role });
  } catch (e) {
    writeHealth(role, { state: "quota", at: now, from: fromLabel, until, error: String(e.message).slice(0, 200), ...keep });
    if (once()) tell(`【额度用完，自动换模型失败】${role} 的 ${fromLabel} 额度用完，换成 ${pick.label} 没发出去：${e.message}。请手动换模型或把活转给别人。`);
    return "fallback-failed";
  }
  writeHealth(role, { state: "fallback", at: now, model: pick.label, modelId: pick.model, from: fromLabel, until, ...keep });
  if (once()) {
    tell(`【额度用完，已自动换模型】${role} 的 ${fromLabel}（${familyName(fromLabel)} 额度池）用完了，已在同一个对话里换成 ${pick.label} 接着做，上下文保留。${clockText(until, now)} 额度回来，下一单自动切回 ${fromLabel}。`);
  }
  return "fallback";
}

async function writeSub(role, run, S, now, peek) {
  const list = [];
  for (const sid of run) { const p = await peek(sid); list.push({ id: sid, steps: S?.[sid]?.stepCount ?? p.steps, said: lastSentence(p.said, 100) }); }
  fs.mkdirSync(presenceDir(), { recursive: true });
  fs.writeFileSync(subFile(role), JSON.stringify({ at: now, running: list }) + "\n");
}

/**
 * 话说一半就收工：员工把命令放后台、说一句「正在…待…完成后继续」就结束了这一轮，之后没人叫醒。
 * 停够 2 分钟、它之后没发过 done/help、最后一句像没收尾 → 用原模型叫醒一次（同一单最多 2 次）；还停就通知派活人，不再续。
 */
const subFile = (role) => path.join(presenceDir(), `${encodeURIComponent(role)}.sub.json`);
export function readSub(role) { try { return JSON.parse(fs.readFileSync(subFile(role), "utf8")); } catch { return null; } }
const clearSub = (role) => { try { fs.rmSync(subFile(role), { force: true }); } catch { /* 没有就算了 */ } };

export async function resumeStep(role, id, t, { m, now, say, inspect, wake, getTask, S, peek }) {
  const key = `${id}@${t.lastModifiedTime}`;
  if (m.resumeKey === key) return null;
  // 员工把活交给了子 agent、子 agent 还在跑：它不是半路收工，是在等子 agent 的汇报。每轮刷新「子 agent 在做什么」给看板，不续、也不占用这个状态——
  // 等子 agent 跑完，员工还停着没发 done，再按下面原来的规则判断
  if (m.resumeInfo?.key === key) {
    const run = runningSubagents(m.resumeInfo.info.subagents, S);
    if (run.length) { await writeSub(role, run, S, now, peek ?? peekReply); return "subagent"; }
  }
  const task = getTask();
  const gate = resumeGate({ summary: t, task, now });
  if (gate === "wait") return null;        // 还在宽限期，下一轮再看
  if (gate !== "ok") { m.resumeKey = key; return null; }
  if (m.resumeInfo?.key !== key) m.resumeInfo = { key, info: await inspect(id) };
  const info = m.resumeInfo.info;
  const run = runningSubagents(info.subagents, S);
  if (run.length) { await writeSub(role, run, S, now, peek ?? peekReply); return "subagent"; }
  clearSub(role);
  m.resumeKey = key; m.resumeInfo = null;  // 同一个停下的状态只判断一次
  const state = readResume(role);
  const d = decideResume({ info, task, state, now });
  if (d.act === "none") return null;
  const keep = { lastRenewAt: m.lastRenewAt, lastRenewTo: m.lastRenewTo };
  const said = lastSentence(info.lastReply);
  const tell = (msg) => {                  // 通知主控和最后派活的人
    say("help", msg);
    const boss = task.from;
    if (boss && boss !== NOTIFY_TO() && boss !== "系统" && boss !== role) say("help", msg, boss);
  };
  if (d.act === "giveup") {
    writeResume(role, { taskId: task.id, count: state.count, at: now, gaveUp: true });
    writeHealth(role, { state: "resumed", at: now, count: state.count, taskId: task.id, gaveUp: true, ...keep });
    tell(`【半路收工，自动续了 ${state.count} 次还是停】${role} 的活（${brief(task)}）停在：「${said}」。不再自动续，请看看它卡在哪，必要时手动叫醒或换人。`);
    return "resume-giveup";
  }
  const text = d.count === 1
    ? `继续刚才那单，从断的地方接着做；不要把命令放后台再结束这一轮（命令在前台跑，要等就等它跑完再继续）。你上一轮停在：「${said}」`
    : `（第 ${d.count} 次自动续上）继续刚才那单，从断的地方接着做；不要把命令放后台再结束这一轮，命令在前台跑完再继续，别只说「正在…」就停。再停在半路就要通知派活人了。你上一轮停在：「${said}」`;
  try { await wake(id, text, { role }); } catch (e) {
    if (!m.notifiedAt.resumeFail || now - m.notifiedAt.resumeFail >= NOTIFY_AGAIN_MS) {
      m.notifiedAt.resumeFail = now;
      tell(`【半路收工，自动续上失败】${role} 的活（${brief(task)}）停在：「${said}」，叫醒没发出去：${e.message}。请手动叫醒它。`);
    }
    return "resume-failed";
  }
  writeResume(role, { taskId: task.id, count: d.count, at: now, gaveUp: false });
  writeHealth(role, { state: "resumed", at: now, count: d.count, taskId: task.id, ...keep });
  return "resumed";
}

/**
 * 检查一个员工。deps 可以换成假的做测试：{ inspect, renew, notify, now }。
 * S 是 GetAllCascadeTrajectories 的摘要表。返回这一轮做了什么，方便日志和测试。
 */
export async function checkRole(role, id, S, deps = {}) {
  const inspect = deps.inspect ?? deskInspect, doRenew = deps.renew ?? deskRenew, say = deps.notify ?? notify;
  const doConfigs = deps.configs ?? deskConfigs, doWake = deps.wake ?? deskWake, getTask = deps.lastTask ?? lastTaskOf;
  const now = deps.now ?? Date.now();
  const m = memOf(role), t = S[id];
  if (!t) return "no-summary";

  // 1. 撑爆了？先看摘要，像失败了才拉整段对话确认（同一状态不重复拉）
  if (looksFailed(t)) {
    const key = `${id}@${t.lastModifiedTime}`;
    if (m.checkedKey !== key) { m.checkedKey = key; m.info = await inspect(id); m.overflow = !!m.info.overflow; }
    const info = m.info ?? {};
    if (m.overflow) {
      const what = decideOverflow({ id, lastRenewAt: m.lastRenewAt, lastRenewTo: m.lastRenewTo, now });
      if (what === "renew") {
        let r;
        try { r = await doRenew(role); } catch (e) {
          writeHealth(role, { state: "overflow", at: now, old: id, new: null, error: String(e.message).slice(0, 200), lastRenewAt: m.lastRenewAt, lastRenewTo: m.lastRenewTo });
          say("help", `【对话撑爆】${role} 的反重力对话超过 30MB 上限（${id}），自动换新对话失败：${e.message}。请手动 agent-hub renew ${role}。`);
          m.notifiedAt.overflow = now;
          return "renew-failed";
        }
        m.lastRenewAt = now; m.lastRenewTo = r.new; m.overflow = false; m.checkedKey = "";
        writeHealth(role, { state: "renewed", at: now, old: id, new: r.new, lastRenewAt: now, lastRenewTo: r.new });
        const text = `【对话撑爆，已自动换新对话】${role} 的反重力对话超过 30MB 上限发不出去。旧号 ${id} → 新号 ${r.new}（模型、标题、工作区沿用，员工表已换号）。续上的活：${brief(r.task)}。`;
        say("help", text);                                   // 通知主控（master-a）
        const boss = r.task?.from;                           // 也通知最后派活的人：他在等的活可能因此晚了
        if (boss && boss !== NOTIFY_TO() && boss !== "系统" && boss !== role) say("help", text, boss);
        return "renewed";
      }
      if (!m.notifiedAt.overflow || now - m.notifiedAt.overflow >= NOTIFY_AGAIN_MS) {
        m.notifiedAt.overflow = now;
        writeHealth(role, { state: "overflow", at: now, old: id, new: m.lastRenewTo || null, lastRenewAt: m.lastRenewAt, lastRenewTo: m.lastRenewTo });
        say("help", `【对话撑爆，没有自动换】${role} 的对话（${id}）又超过 30MB 上限：${id === m.lastRenewTo ? "它就是刚自动换出来的新对话，换完还报错" : "10 分钟内刚换过一次"}。不再自动换，请看看是不是有人在读大截图，必要时手动 agent-hub renew ${role}。`);
      }
      return "overflow-notified";
    }
    // 额度用完？同一个对话里换成还有额度的模型接着干（不是撑爆，撑爆的上面已经处理）
    if (isQuotaError(info.lastError) && m.quotaKey !== key) {
      m.quotaKey = key;
      return quotaStep(role, id, info, { m, now, say, configs: doConfigs, wake: doWake });
    }
  } else {
    m.overflow = false; m.checkedKey = ""; m.quotaKey = "";   // 不再报错了，清掉
    const h = readHealth(role);
    if (h?.state === "overflow") writeHealth(role, { state: "ok", at: now, lastRenewAt: m.lastRenewAt, lastRenewTo: m.lastRenewTo });
    // 备用态的 until（原池重置时间）过了就收回 ok；下一单由 wake 自动回到首选模型
    if ((h?.state === "fallback" || h?.state === "quota") && (!h.until || now >= Date.parse(h.until))) {
      writeHealth(role, { state: "ok", at: now, lastRenewAt: m.lastRenewAt, lastRenewTo: m.lastRenewTo });
    }
  }

  // 1b. 话说一半就收工？（停着、没出错、没发 done）→ 自动叫醒续上，最多 2 次
  if (looksStopped(t) && m.resumeKey !== `${id}@${t.lastModifiedTime}`) {
    const done = await resumeStep(role, id, t, { m, now, say, inspect, wake: doWake, getTask: () => getTask(role), S, peek: deps.peek });
    if (done) return done;
  }

  if (!looksStopped(t) && m.resumeInfo) { m.resumeInfo = null; clearSub(role); }   // 员工又动起来了（比如子 agent 汇报后被叫醒），子 agent 的标记收掉

  // 2. 快撑爆了？量一次大小（整段对话要拉下来，所以限频）
  if (shouldMeasure({ stepCount: t.stepCount, lastSteps: m.lastSteps, lastAt: m.lastSizeAt, now })) {
    m.lastSteps = t.stepCount; m.lastSizeAt = now;
    const info = await inspect(id);
    const mb = Math.round(info.liveMb * 10) / 10;
    if (info.liveMb >= BIG_MB) {
      writeHealth(role, { state: "big", at: now, mb, lastRenewAt: m.lastRenewAt, lastRenewTo: m.lastRenewTo });
      if (!m.notifiedAt.big || now - m.notifiedAt.big >= NOTIFY_AGAIN_MS) {
        m.notifiedAt.big = now;
        say("note", `【对话快撑爆】${role} 的反重力对话里没清理的内容已有 ${mb}MB（上限 30MB，到了每条消息都发不出去）。不自动换；等它这一单做完，或手动 agent-hub renew ${role}。`);
      }
      return "big";
    }
    const h = readHealth(role);
    const freshRenewed = h?.state === "renewed" && now - h.at < RENEWED_SHOW_MS;   // 刚换过的，让看板多显示一阵子
    const freshResumed = h?.state === "resumed" && now - h.at < RESUMED_SHOW_MS;     // 刚自动续上的，也多显示一阵子
    // 额度备用态没到重置时间也别盖掉（看板要显示「已切 Gemini」/「额度用完」）
    const backup = (h?.state === "fallback" || h?.state === "quota") && (!h.until || now < Date.parse(h.until));
    if (!freshRenewed && !freshResumed && !backup && (!h || h.state !== "ok")) writeHealth(role, { state: "ok", at: now, mb, lastRenewAt: m.lastRenewAt, lastRenewTo: m.lastRenewTo });
    return "ok";
  }
  return "skip";
}

let running = false;
/** bridges.mjs 每 30 秒调一次；上一轮还没跑完就跳过 */
export async function healthTick(log = () => {}) {
  if (running) return;
  running = true;
  try {
    let roles = {}; try { roles = JSON.parse(fs.readFileSync(rolesFile(), "utf8")); } catch { return; }
    const ds = Object.entries(roles).filter(([, r]) => r.kind === "desktop" && r.desktop_id);
    if (!ds.length) return;
    let S; try { S = await deskSummaries(); } catch { return; }   // 桌面端没开就算了
    for (const [role, r] of ds) {
      try {
        const what = await checkRole(role, r.desktop_id, S);
        if (what !== "skip" && what !== "ok" && what !== "no-summary") log(`对话健康 ${role}：${what}`);
      } catch (e) { log(`对话健康 ${role} 检查失败：${String(e.message).slice(0, 100)}`); }
    }
  } finally { running = false; }
}
