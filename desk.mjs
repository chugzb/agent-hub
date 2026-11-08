#!/usr/bin/env node
// 直接调用反重力桌面端本机语言服务：给桌面端会话发消息（实验，内部接口，升级可能失效）
// 令牌从语言服务进程参数里读，不打印
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 看板每 3 秒、健康检查每 30 秒都要调语言服务，不能每次都跑 ps + lsof。
// 缓存 pid、令牌和端口：pid 还活着、没超过 5 分钟就用缓存；调不通时 call() 会强制重新找一次。
const LS_TTL_MS = 5 * 60_000;
let lsCache = null;   // { pid, csrf, ports, at }
const pidAlive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; } };
export const _resetLsInfoCache = () => { lsCache = null; };

/** 现场找一遍：ps 里找到桌面端语言服务，再 lsof 拿它在听的端口 */
function scanLs() {
  const ps = execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" });
  const line = ps.split("\n").find((l) => l.includes("Antigravity.app/Contents/Resources/bin/language_server") && l.includes("--subclient_type hub"));
  if (!line) throw new Error("反重力桌面端没在运行");
  const pid = line.trim().split(/\s+/)[0];
  const csrf = line.match(/--csrf_token[ =](\S+)/)?.[1];
  const lsof = execFileSync("lsof", ["-nP", "-a", "-p", pid, "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" });
  const ports = [...lsof.matchAll(/127\.0\.0\.1:(\d+) \(LISTEN\)/g)].map((m) => Number(m[1]));
  return { pid, csrf, ports };
}

/** 语言服务的 pid、令牌、端口。_deps 只给测试换掉 ps / lsof。 */
export function lsInfo({ force = false, _deps } = {}) {
  const deps = { scan: scanLs, alive: pidAlive, now: Date.now, ..._deps };
  if (!force && lsCache && deps.now() - lsCache.at < LS_TTL_MS && deps.alive(lsCache.pid)) {
    return { pid: lsCache.pid, csrf: lsCache.csrf, ports: [...lsCache.ports] };
  }
  let info;
  try { info = deps.scan(); } catch (e) { lsCache = null; throw e; }
  lsCache = { pid: info.pid, csrf: info.csrf, ports: [...info.ports], at: deps.now() };
  return { pid: info.pid, csrf: info.csrf, ports: [...info.ports] };
}

export async function call(method, body, { port, _deps } = {}) {
  const tried = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { csrf, ports } = lsInfo({ force: attempt > 0, _deps });
    for (const p of port ? [port] : ports) {
      const url = `http://127.0.0.1:${p}/exa.language_server_pb.LanguageServerService/${method}`;
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1", "x-codeium-csrf-token": csrf }, body: JSON.stringify(body) });
        const text = await r.text();
        if (r.ok) return { port: p, data: text ? JSON.parse(text) : {} };
        tried.push(`${p} ${r.status} ${text.slice(0, 120)}`);
      } catch (e) { tried.push(`${p} ${e.message}`); }
    }
  }
  lsCache = null;   // 全都调不通：下次从 ps 重新找
  throw new Error(`调不通：${tried.join(" | ")}`);
}

// ---------------------------------------------------------------- 额度：哪个模型还有额度、该换成谁
// 11-08 实测：同一家的模型共用一个额度池，一起用完、一起重置。
// Claude 系（MODEL_PLACEHOLDER_M400–M405）+ GPT-OSS 120B 一个池；Gemini 系（M417/418/419、M318–M320）另一个池。
export const QUOTA_FLOOR = 0.05;   // 剩余低于这个就当作没额度
/** 没写 fallback_models 时的备选链：按原模型的池给 */
export const DEFAULT_CHAIN = {
  claude: ["Gemini 4 Argon (High)", "Gemini 3.8 Flash (High)"],
  gemini: ["Claude Opus 5.5 (High)"],
};

/** 模型属于哪个额度池（按标签认；认不出再按模型号） */
export function modelPool(model, label = "") {
  const l = String(label ?? "").toLowerCase();
  if (/claude|gpt-oss|gpt oss/.test(l)) return "claude";
  if (/gemini/.test(l)) return "gemini";
  const m = String(model ?? "");
  if (/^MODEL_PLACEHOLDER_M40[0-5]$/.test(m) || /OPENAI|GPT_OSS/i.test(m)) return "claude";
  if (/^MODEL_PLACEHOLDER_M(417|418|419|318|319|320)$/.test(m)) return "gemini";
  return "other";
}

/** 把 GetCascadeModelConfigData 的 clientModelConfigs 规整成 [{ model, label, remaining, resetTime, pool }] */
export function normalizeConfigs(list) {
  return (list ?? []).map((c) => {
    const q = c.quotaInfo ?? {};
    const model = c.modelOrAlias?.model ?? "";
    const label = c.label || model;
    return {
      model, label,
      remaining: typeof q.remainingFraction === "number" ? q.remainingFraction : 0,   // 没有这个字段 = 已用完
      resetTime: q.resetTime ?? "",
      pool: modelPool(model, label),
    };
  });
}

/** 各模型现在剩多少、什么时候重置 */
export async function modelConfigs(_deps) {
  const r = await call("GetCascadeModelConfigData", {}, _deps);
  return normalizeConfigs(r.data?.clientModelConfigs);
}

const findConfig = (configs, want) => (configs ?? []).find((c) => c.label === want || c.model === want);

/** 一个额度池还剩多少、什么时候重置（同池取最大剩余 = 这个池还能不能用） */
export function poolOf(configs, pool) {
  const xs = (configs ?? []).filter((c) => c.pool === pool);
  if (!xs.length) return null;
  const times = xs.map((c) => Date.parse(c.resetTime)).filter(Number.isFinite);
  return {
    pool,
    remaining: Math.max(...xs.map((c) => c.remaining)),
    until: times.length ? new Date(Math.max(...times)).toISOString() : "",
  };
}

/** 额度用完的报错：反重力返回 RESOURCE_EXHAUSTED / quota reached；DeepSeek 余额不足是 402 / insufficient balance */
export function isQuotaError(text) {
  return /RESOURCE_EXHAUSTED|quota|rate.?limit|insufficient|credits|too many requests|\b(429|402)\b/i.test(String(text ?? ""));
}

/** 员工的备选链：roles.json 的 fallback_models 优先，没写就按原模型所在的池给默认链 */
export function chainFor(fromModel, configs, fallbackModels) {
  if (Array.isArray(fallbackModels) && fallbackModels.length) return [...fallbackModels];
  const c = findConfig(configs, fromModel);
  const pool = c?.pool ?? modelPool(fromModel, fromModel);
  return DEFAULT_CHAIN[pool] ?? [];
}

/** 备选链里第一个还有额度的模型（remaining > QUOTA_FLOOR，跳过原模型）；都没有返回 null */
export function pickFallback({ from, chain, configs }) {
  for (const want of chain ?? []) {
    const c = findConfig(configs, want);
    if (!c || c.remaining <= QUOTA_FLOOR) continue;
    if (c.model === from || c.label === from) continue;
    return c;
  }
  return null;
}

/** 这一单该用哪个模型：首选所在的池还有额度就用首选，否则走备选链；都没有返回 null */
export function pickPlanModel({ preferred, configs, fallbackModels }) {
  const own = findConfig(configs, preferred);
  const shared = own && (own.pool === "claude" || own.pool === "gemini");
  const left = own ? (shared ? poolOf(configs, own.pool)?.remaining ?? own.remaining : own.remaining) : 0;
  if (own && left > QUOTA_FLOOR) return own;
  return pickFallback({ from: preferred, chain: chainFor(preferred, configs, fallbackModels), configs });
}

/** 模型号换成标签（看板上给人看的名字）；找不到就原样返回 */
export function configLabel(configs, key) {
  const c = findConfig(configs, key);
  return c?.label ?? (key || "");
}

/** 模型是哪一家的（看板短句用）：Claude / Gemini / GPT-OSS / DeepSeek */
export function familyName(model) {
  const s = String(model ?? "");
  if (/claude/i.test(s)) return "Claude";
  if (/gemini/i.test(s)) return "Gemini";
  if (/gpt-?oss/i.test(s)) return "GPT-OSS";
  if (/deepseek/i.test(s)) return "DeepSeek";
  const p = modelPool(s, s);
  return p === "claude" ? "Claude" : p === "gemini" ? "Gemini" : s || "模型";
}

/** 重置时间的短写法：今天只写 HH:MM，不是今天就写 MM-DD HH:MM（本地时间） */
export function clockText(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "额度恢复后";
  const d = new Date(t), n = new Date(now);
  const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
  const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return same ? `${hh}:${mm}` : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hh}:${mm}`;
}

/**
 * 叫醒桌面会话（必须带 plannerConfig.planModel，否则报「plan model not specified」）。
 * 模型怎么定：
 *  - 传了 model 就用它（health 自动切换时明确指定，可以是标签或模型号）；
 *  - 没传就按员工表：plan_model（首选，第一次自动把这个对话上次用的模型记进去）所在的池还有额度就用首选，
 *    否则按 fallback_models（没写用默认链）挑第一个有额度的 —— 额度回来以后下一单自然回到首选。
 * 返回实际用的模型标签。
 */
export async function wake(cascadeId, text, { model, role } = {}) {
  const t = await call("GetCascadeTrajectory", { cascadeId });
  const g = t.data.trajectory?.generatorMetadata ?? [];
  const lastModel = g.map((x) => x.chatModel?.model).filter(Boolean).pop();
  if (!lastModel) throw new Error("找不到这个会话用过的模型，先在桌面端手动发一句话");
  let configs = [];
  try { configs = await modelConfigs(); } catch { /* 额度接口读不出来就按老办法用上次的模型 */ }
  let use = model ? findConfig(configs, model) ?? { model, label: model } : null;
  if (!use && role) {
    const r = readRoles()[role] ?? {};
    if (!r.plan_model) { try { updateRole(role, { plan_model: lastModel }); } catch { /* 员工表写不进去不影响叫醒 */ } }
    const picked = configs.length ? pickPlanModel({ preferred: r.plan_model || lastModel, configs, fallbackModels: r.fallback_models }) : null;
    use = picked ?? { model: r.plan_model || lastModel, label: r.plan_model || lastModel };
  }
  use = use ?? { model: lastModel, label: lastModel };
  await call("SendUserCascadeMessage", { cascadeId, cascadeConfig: { plannerConfig: { planModel: use.model } }, items: [{ text }] });
  return use.label;
}

// ---------------------------------------------------------------- 对话撑爆：判断、换新对话
// 反重力对话里「没被清理的步骤」加起来超过 30MB，下一条消息就发不出去（FAILED_PRECONDITION: The message size ... exceeds 30.000MB limit）。
// 11-08 实测：撑爆那条 3g 旧对话的未清理步骤 31.5MB；整段 JSON 的大小不能当指标（3a、3c 的 JSON 有 58、95MB 但大部分是已清理的步骤，照常能用）。
export const OVERFLOW_MB = 30;
const STEP_ERROR = "CORTEX_STEP_TYPE_ERROR_MESSAGE";
const STEP_USER = "CORTEX_STEP_TYPE_USER_INPUT";
const CLEARED = "CORTEX_STEP_STATUS_CLEARED";

/** 最后一步是不是「消息超过 30MB」的报错 */
export function isOverflowSteps(steps) {
  const last = steps?.[steps.length - 1];
  if (!last || last.type !== STEP_ERROR) return false;
  return /exceeds\s+30(\.0+)?\s*MB/i.test(JSON.stringify(last.errorMessage ?? last));
}

/** 没被清理的步骤的 JSON 大小（MB）；这个数接近 30 就快撑爆了 */
export function liveMb(steps) {
  let n = 0;
  for (const s of steps ?? []) if (s.status !== CLEARED) n += JSON.stringify(s).length;
  return n / 1e6;
}

export async function summaries() {
  return (await call("GetAllCascadeTrajectories", {})).data.trajectorySummaries ?? {};
}

/**
 * 读一个对话：是不是撑爆了、未清理部分多大、最后一步是什么、最后一条报错写了什么、用的是哪个模型。
 * 会把整段对话拉下来（几十 MB），别高频调。
 */
export async function inspect(cascadeId) {
  const t = (await call("GetCascadeTrajectory", { cascadeId })).data.trajectory ?? {};
  const steps = t.steps ?? [];
  const last = steps[steps.length - 1];
  const e = last?.errorMessage?.error;
  return {
    steps: steps.length,
    overflow: isOverflowSteps(steps),
    liveMb: liveMb(steps),
    lastType: last?.type ?? "",
    lastAt: last?.metadata?.createdAt ?? "",   // 最后一步（额度报错时就是报错那一步）发生在什么时候
    lastError: e ? String(e.shortError || e.modelErrorMessage || e.userErrorMessage || "") : "",
    lastModel: (t.generatorMetadata ?? []).map((x) => x.chatModel?.model).filter(Boolean).pop() ?? "",
  };
}

const homeDir = () => process.env.HOME || os.homedir();
const rolesPath = () => path.join(homeDir(), ".config", "agy-team", "roles.json");
const inboxPath = () => path.join(process.env.HUB_DIR ?? path.join(homeDir(), "agy-logs"), "inbox.jsonl");
export const readRoles = () => { try { return JSON.parse(fs.readFileSync(rolesPath(), "utf8")); } catch { return {}; } };

/** 旧对话第一条用户消息里的身份段落。如果那条本身就是上一次换新对话写的，只取「【新对话】」之前的部分。 */
export function extractIdentity(text) {
  let t = String(text ?? "").trim();
  const cut = t.indexOf("【新对话】");
  if (cut > 0) t = t.slice(0, cut).trim();
  if (t.length <= 1200) return t;
  let out = "";
  for (const p of t.split(/\n{2,}/)) { if ((out + p).length > 1200) break; out += (out ? "\n\n" : "") + p; }
  return out || t.slice(0, 1200);
}

const CONTEXT_N = 3;   // 续上的活前后各带几条往来
/**
 * 收件箱里发给这个员工的最后一条 task 或 reply（任何人发的都算，系统通知和它自己发的不算）的原文，
 * 连带这条前后各 3 条跟这个员工有关的往来（摘要用），以及这条之后员工有没有发过 done。
 */
export function pickLastTask(lines, role) {
  const mine = [];   // 跟这个员工有关的往来（发给它的、它发出的），按时间顺序
  for (const l of lines) {
    let m; try { m = JSON.parse(l); } catch { continue; }   // 坏行跳过
    if (m.to === role || m.from === role) mine.push(m);
  }
  let idx = -1;
  for (let i = mine.length - 1; i >= 0; i--) {
    const m = mine[i];
    if (m.to === role && (m.type === "task" || m.type === "reply") && m.from && m.from !== role && m.from !== "系统") { idx = i; break; }
  }
  if (idx < 0) return null;
  const m = mine[idx];
  const slim = (x) => ({ id: x.id, time: x.time, from: x.from, to: x.to, type: x.type, text: String(x.text ?? "") });
  return {
    id: m.id, time: m.time, from: m.from, type: m.type, text: String(m.text ?? ""),
    doneAfter: mine.slice(idx + 1).some((x) => x.from === role && x.type === "done"),
    before: mine.slice(Math.max(0, idx - CONTEXT_N), idx).map(slim),
    after: mine.slice(idx + 1, idx + 1 + CONTEXT_N).map(slim),
  };
}

function readInboxLines() {
  try { return fs.readFileSync(inboxPath(), "utf8").split("\n").filter(Boolean); } catch { return []; }
}

/** 最近给这个员工派活的是谁（额度用完时也要通知他），找不到返回空串 */
export function lastTaskFrom(role) {
  try { return pickLastTask(readInboxLines(), role)?.from ?? ""; } catch { return ""; }
}

const oneLine = (t, n) => { const x = String(t ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };
const ctxLine = (x) => `  [${x.time}] ${x.from} → ${x.to} · ${x.type}：${oneLine(x.text, 120)}`;

/** 换新对话的第一条消息 */
export function buildRenewMessage({ role, identity, task, note }) {
  const parts = [];
  if (identity) parts.push(`${identity}\n（上面如果写了工作目录，以最后一条活里写的工作目录为准。）`);
  const boss = task?.from || "主控";
  parts.push(`【新对话】你原来的对话超过 30MB 上限发不出去了，这是新对话。上面的身份和规矩照旧；这一轮不用再回名字，直接接着干活。
重要：看截图前先缩小再看（sips -Z 1280 原图 --out 缩小图），只看缩小图，不要直接读 2880 宽的原图，免得对话又撑爆。
你通过 agent-hub 这个 MCP 和团队联系：做完回报给 ${boss}（send_message：me=${role}，to=${boss}，type=done，写改了什么、怎么验证的）；卡住发 help。做完一单直接结束这一轮，不要循环 wait_for_task（身份段落里如果写了要循环等活，以这条为准），有新活会自动叫醒你。`);
  if (note && String(note).trim()) parts.push(`【派活人补充】\n${String(note).trim()}`);
  if (task) {
    const body = task.text.length > 8000 ? task.text.slice(0, 8000) + "\n……（原文太长，后面的截掉了，去收件箱 read_messages all=true 看全文）" : task.text;
    const what = task.type === "task" ? "你最后一条没做完的活" : "发给你的最后一条消息（可能是新单，也可能只是对上一单的回复，看下面的往来判断）";
    parts.push(`${what}（${task.time}，${task.from} 发的 ${task.type}，消息 ${task.id}）原文：${task.doneAfter ? "\n（注意：这条之后你发过 done，可能已经做完了；先看看现状，确认没做完再接着做，做完了就回一句确认。）" : ""}\n${body}`);
    const ctx = [...task.before.map(ctxLine), `  ▶ [${task.time}] ${task.from} → ${role} · ${task.type}（就是上面这条）`, ...task.after.map(ctxLine)];
    parts.push(`这条前后跟你有关的往来（摘要，旧的在前；要全文用 read_messages all=true）：\n${ctx.join("\n")}`);
  } else {
    parts.push("收件箱里没找到发给你的活。先用 send_message（type=progress）回一句「新对话已就绪」，等新活。");
  }
  return parts.join("\n\n");
}

/** 只改一个员工的几个字段（现读 + tmp + rename），别的原样保留。返回改后的员工对象。 */
function updateRole(role, patch) {
  const file = rolesPath();
  const raw = fs.readFileSync(file, "utf8");
  const roles = JSON.parse(raw);
  const r = roles[role];
  if (!r) throw new Error(`员工表里没有 ${role}`);
  if (typeof patch === "function") patch(r); else Object.assign(r, patch);
  const indent = raw.match(/^([ \t]+)"/m)?.[1] ?? "  ";
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(roles, null, indent) + (raw.endsWith("\n") ? "\n" : ""));
  fs.renameSync(tmp, file);
  return r;
}

function updateRolesFile(role, oldId, newId) {
  updateRole(role, (r) => {
    const olds = Array.isArray(r.old_desktop_ids) ? [...r.old_desktop_ids] : [];
    for (const x of [r.old_desktop_id, oldId]) if (x && !olds.includes(x)) olds.push(x);
    r.old_desktop_ids = olds;
    r.desktop_id = newId;
  });
}

/**
 * 给员工换一个新的桌面对话：沿用旧对话的工作区、模型、标题，第一条消息写身份 + 换对话说明 + 最后一条没做完的活，
 * 然后把员工表里的 desktop_id 换成新号（旧号追加进 old_desktop_ids）。dryRun 只读不写，返回将要发的第一条消息。
 */
export async function renew(role, { dryRun = false, note = "" } = {}) {
  const r = readRoles()[role];
  if (!r) throw new Error(`员工表里没有 ${role}`);
  if (r.kind !== "desktop" || !r.desktop_id) throw new Error(`${role} 不是桌面端员工，或没登记 desktop_id`);
  const old = r.desktop_id;
  let sum = (await summaries())[old];
  if (!sum) { try { await call("GetCascadeTrajectory", { cascadeId: old }); } catch { /* 下面再报 */ } sum = (await summaries())[old]; }
  const traj = (await call("GetCascadeTrajectory", { cascadeId: old })).data.trajectory ?? {};
  const planModel = (traj.generatorMetadata ?? []).map((x) => x.chatModel?.model).filter(Boolean).pop();
  if (!planModel) throw new Error(`找不到 ${role} 旧对话用过的模型，没法带到新对话`);
  const first = (traj.steps ?? []).find((s) => s.type === STEP_USER)?.userInput;
  const identity = extractIdentity(first?.items?.[0]?.text ?? first?.userResponse ?? "");
  const title = sum?.annotations?.title || sum?.summary || role;
  const ws = sum?.trajectoryMetadata?.workspaceUris ?? (sum?.workspaces ?? []).map((w) => w.workspaceFolderAbsoluteUri).filter(Boolean);
  const task = pickLastTask(readInboxLines(), role);
  const text = buildRenewMessage({ role, identity, task, note });
  const plan = { role, old, planModel, title, workspaceUris: ws ?? [], task: task ? { id: task.id, time: task.time, from: task.from, type: task.type, doneAfter: task.doneAfter, before: task.before.length, after: task.after.length } : null, text };
  if (dryRun) return { ...plan, dryRun: true };
  const started = await call("StartCascade", { source: "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT", ...(ws?.length ? { workspaceUris: ws } : {}) });
  const id = started.data.cascadeId;
  if (!id) throw new Error("StartCascade 没返回会话号");
  try {
    await call("UpdateConversationAnnotations", { cascadeId: id, annotations: { title } });
    await call("SendUserCascadeMessage", { cascadeId: id, cascadeConfig: { plannerConfig: { planModel } }, items: [{ text }] });
  } catch (e) {
    try { await call("DeleteCascadeTrajectory", { cascadeId: id }); } catch { /* 删不掉也不管 */ }
    throw new Error(`新对话没发出去（${e.message.slice(0, 120)}），已删掉空对话，员工表没动`);
  }
  updateRolesFile(role, old, id);
  return { ...plan, new: id };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [method, json] = process.argv.slice(2);
  if (method === "list") {
    // 列出桌面端会话：会话号、状态、标题，登记员工时把会话号填进 roles.json 的 desktop_id
    const r = await call("GetAllCascadeTrajectories", {});
    for (const [id, t] of Object.entries(r.data.trajectorySummaries ?? {})) console.log(`${id}  ${t.status.replace("CASCADE_RUN_STATUS_", "").padEnd(8)}  ${t.summary}`);
    process.exit(0);
  }
  if (method === "renew") {
    // node desk.mjs renew <员工号> [--dry-run] [--note "<文字>"]   （一般用 agent-hub renew <员工号>）
    const role = process.argv[3], dry = process.argv.includes("--dry-run");
    const ni = process.argv.indexOf("--note"), note = ni >= 0 ? process.argv[ni + 1] ?? "" : "";
    if (ni >= 0 && !note.trim()) { console.error("--note 后面要跟一段文字"); process.exit(2); }
    if (!role || role.startsWith("--")) { console.error("用法：agent-hub renew <员工号> [--dry-run] [--note \"<文字>\"]"); process.exit(2); }
    try {
      const x = await renew(role, { dryRun: dry, note });
      console.log(`${dry ? "【只看不做】" : ""}${role}：旧对话 ${x.old}\n模型 ${x.planModel}　标题「${x.title}」　工作区 ${x.workspaceUris.length ? x.workspaceUris.join(", ") : "（旧对话没有）"}`);
      console.log(x.task ? `续上的活：消息 ${x.task.id}（${x.task.time}，${x.task.from} 发的 ${x.task.type}${x.task.doneAfter ? "，之后它发过 done" : ""}），连带前 ${x.task.before} 条、后 ${x.task.after} 条往来；做完回报给 ${x.task.from}` : "收件箱里没有发给它的活");
      if (dry) console.log(`\n第一条消息：\n${x.text}`); else console.log(`新对话 ${x.new}，员工表已换号（旧号进 old_desktop_ids）`);
      process.exit(0);
    } catch (e) { console.error(`换新对话失败：${e.message}`); process.exit(1); }
  }
  const r = await call(method, json ? JSON.parse(json) : {});
  console.log(process.env.FULL ? JSON.stringify(r.data) : JSON.stringify(r, null, 1).slice(0, 4000));
}
