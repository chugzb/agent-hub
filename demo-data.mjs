// 看板演示数据：BOARD_DEMO=1 时 board.mjs 用这里的假员工、假消息，不读本机任何东西。
// 名字、项目、任务内容都是编的，只为 README 截图和本地试看；时间以模块加载那一刻为基准，之后不再变。
import { clockText } from "./desk.mjs";

const T0 = Date.now();
const MIN = 60_000;
// 额度用完的假员工：12 分钟后恢复，时间跟 T0 绑死，同一进程里每次快照都一样
const QUOTA_UNTIL = new Date(T0 + 12 * MIN).toISOString();
const QUOTA_RECOVER = clockText(QUOTA_UNTIL, T0);

const AGENTS = [
  // 在干活
  { name: "master-a", avatar: "claude", kind: "Claude Code", model: "claude-opus-5-5", state: "working", group: "主控",
    since: T0 - 34 * MIN, lastMove: T0 - 8_000, doing: "Grep：结算页的文案", said: "在核对接入点", where: "~/web-app" },
  { name: "d1", avatar: "gemini", kind: "反重力 · Gemini", model: "gemini-4-argon-high", state: "working", group: "反重力",
    since: T0 - 41 * MIN, lastMove: T0 - 20_000, said: "共 132 步",
    doing: "master-a 派的：把价格页改成中英双语，英文版不要机器直译" },
  { name: "c1", avatar: "codex", kind: "Codex CLI", model: "gpt-6-1-sol-high", state: "working", group: "Devin · Codex",
    since: T0 - 18 * MIN, lastMove: T0 - 15_000, doing: "Bash：npm test", where: "~/web-app" },
  { name: "k1", avatar: "claude", kind: "Claude Code", model: "claude-sonnet-5-5", state: "working", group: "其他会话",
    since: T0 - 9 * MIN, lastMove: T0 - 30_000, doing: "Read：README.md", said: "顺手把安装步骤补全", where: "~/web-app",
    health: { state: "big", at: T0 - 2 * MIN, mb: 24 } },
  // 等会话 / 状态未知（都不算歇着）
  { name: "v1", avatar: "devin", kind: "Devin · gpt-5-1", model: "gpt-5-1", state: "waiting", group: "Devin · Codex",
    since: T0 - 26 * MIN, lastMove: T0 - 4 * MIN, where: "~/web-app" },
  { name: "t1", avatar: "claude", kind: "终端 agent · tmux", model: "claude-opus-5-5", state: "unknown", group: "其他会话",
    since: 0, lastMove: 0, doing: "窗口 demo:0.0" },
  // 额度用完：备用模型也用完了，等额度池重置（顶栏计「没额度」，待命区灰标恢复时间）
  { name: "d2", avatar: "gemini", kind: "反重力 · Gemini", model: "gemini-4-argon-high", state: "quota", group: "反重力",
    since: T0 - 52 * MIN, lastMove: T0 - 6 * MIN, said: "共 86 步",
    doing: `额度用完，${QUOTA_RECOVER} 恢复`,
    health: { state: "quota", at: T0 - 6 * MIN, until: QUOTA_UNTIL, from: "Gemini 4 Argon High", recover: QUOTA_RECOVER } },
  // 歇着
  { name: "master-b", avatar: "claude", kind: "Claude Code", model: "claude-sonnet-5-5", state: "idle", group: "主控",
    since: T0 - 55 * MIN, lastMove: T0 - 12 * MIN, said: "这一单先停，等排期", where: "~/web-app" },
  { name: "d3", avatar: "gemini", kind: "反重力 · Gemini", model: "gemini-4-argon-medium", state: "idle", group: "反重力",
    since: T0 - 76 * MIN, lastMove: T0 - 31 * MIN, said: "共 47 步" },
  { name: "w1", avatar: "deepseek", kind: "Claude Code", model: "deepseek-v4-pro", state: "idle", group: "其他会话",
    since: T0 - 88 * MIN, lastMove: T0 - 44 * MIN, where: "~/docs-site" },
];

// [多少分钟前, 发件人, 收件人, 类型, 正文]，从旧到新
const RAW = [
  [118, "master-a", "d1", "task", "把价格页改成中英双语：中文排第一，英文版单独一页，价格数字两边要对得上。"],
  [116, "d1", "master-a", "progress", "收到，先看现有的价格组件怎么写的。"],
  [112, "master-b", "c1", "task", "跑一遍测试，把报错贴给我，先别改代码。"],
  [110, "c1", "master-b", "progress", "测试跑起来了，有 2 条失败，都在国际化相关的用例。"],
  [106, "master-b", "c1", "reply", "先看失败原因，如果是假数据的问题就改假数据，别动断言。"],
  [104, "c1", "master-b", "done", "查清了：两条失败都是假数据里少了英文字段，已补上，测试全通。"],
  [100, "d1", "master-a", "progress", "价格页英文初稿好了，正在核 1280 和 390 两个宽度。"],
  [96, "master-a", "d1", "reply", "先看 390，宽度不够的时候价格容易折行。"],
  [92, "d1", "master-a", "progress", "390 下改好了，数字不折行了，截图放本地了。"],
  [88, "master-a", "d1", "task", "再看 1440 下的套餐卡片，三张卡高度要一样。"],
  [84, "master-a", "master-b", "note", "d1 在改价格页，c1 在跑测试，别重复派。"],
  [80, "master-b", "master-a", "reply", "收到，我这边这一单先停，等排期。"],
  [78, "c1", "master-a", "note", "测试用的临时目录我清掉了，没留垃圾。"],
  [74, "master-a", "k1", "task", "把 README 的安装步骤补全，缺一步「把 ~/.local/bin 加进 PATH」。"],
  [70, "k1", "master-a", "progress", "在补，顺手把命令表也加上了。"],
  [66, "d1", "master-a", "done", "价格页三处都改完了：中英双语、390 不折行、1440 三卡等高。截图已发。"],
  [62, "master-a", "d1", "reply", "看到了，可以。下一单等我理完需求再派。"],
  [60, "v1", "master-a", "progress", "Devin 这边会话被桌面版占着，我先把能做的部分做了。"],
  [56, "master-a", "v1", "reply", "好，占着就先等，别开新会话，免得两边打架。"],
  [52, "t1", "master-a", "note", "终端这边的日常巡检做完了，没有异常。"],
  [50, "master-a", "t1", "reply", "收到。"],
  [48, "d3", "master-a", "done", "上一单的两个页面都补齐了，检查过没有横向滚动。"],
  [44, "master-a", "d3", "reply", "好，先歇着。"],
  [42, "master-b", "c1", "task", "把测试里的时间相关用例固定住，别跟着当天日期变。"],
  [40, "c1", "master-b", "progress", "在改成固定基准时间，跑完贴结果。"],
  [36, "c1", "master-b", "done", "改完了，测试连跑三次结果一样。"],
  [34, "master-a", "k1", "task", "README 里加一张看板截图，用演示模式截，别用真实数据。"],
  [32, "k1", "master-a", "progress", "演示模式没有现成数据，我先编一套假员工和假消息。"],
  [30, "master-a", "k1", "reply", "名字都用通用的，比如 master-a、d1、c1，别出现内部项目名。"],
  [28, "k1", "master-a", "progress", "假数据编好了，看板能跑起来，截图正在截。"],
  [26, "w1", "master-a", "note", "文档站的构建过了，链接检查没有死链。"],
  [24, "master-a", "w1", "reply", "收到，先歇着。"],
  [22, "d1", "master-a", "progress", "新一单的英文文案先写了三屏，等你确认语气。"],
  [20, "master-a", "d1", "reply", "语气按大白话，别用营销腔。"],
  [18, "d1", "master-a", "progress", "按大白话改完了，再顺一遍。"],
  [17, "c1", "master-a", "note", "测试脚本里我加了超时，跑太久会自动退出。"],
  [16, "master-a", "c1", "reply", "好，别把超时设得太短。"],
  [15, "master-b", "d3", "task", "把上一单的验收记录整理成一段话发我。"],
  [14, "d3", "master-b", "done", "整理好了：两个页面、一处文案、无新增依赖，测试全通。"],
  [13, "k1", "master-a", "progress", "看板截图截好了，桌面和手机各一张。"],
  [12, "master-a", "k1", "reply", "发我看看。"],
  [11, "k1", "master-a", "done", "截图和 README 都放好了，你看一眼。"],
  [10, "master-a", "d1", "task", "最后再核一遍价格数字：中文页和英文页必须完全一致。"],
  [9, "d1", "master-a", "progress", "正在逐条对，已经对了前两档。"],
  [8, "master-a", "master-b", "note", "这一轮收尾了，剩下的明天排。"],
  [7, "master-b", "master-a", "reply", "好，我这边把验收记录归档。"],
  [6, "c1", "master-a", "progress", "测试又跑了一遍，还是全通。"],
  [5, "master-a", "c1", "reply", "辛苦，可以收了。"],
  [4, "d1", "master-a", "progress", "价格数字三档都对上了，中文英文一模一样。"],
  [3, "master-a", "d1", "reply", "好，这一单收尾。"],
  [2, "v1", "master-a", "help", "Devin 的会话一直被桌面版占着，叫不醒，要不要开新会话？"],
];

function timeText(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const MESSAGES = RAW.map(([mAgo, from, to, type, text], i) => {
  const at = T0 - mAgo * MIN;
  return { line: i + 1, at, time: timeText(at), from, to, type, text };
});

/** 前端第一次连上时拿的整页快照（跟 board.mjs 的 snapshot() 同形） */
export function demoSnapshot() {
  return { at: Date.now(), agents: AGENTS.map((a) => ({ ...a })), ...demoPage(40) };
}

/** 「加载更早的消息」：取 before 行号之前的 limit 条，新的在前；more 表示前面还有 */
export function demoPage(limit = 40, before = Infinity) {
  const rows = MESSAGES.filter((m) => m.line < before);
  const page = rows.slice(-limit);
  return { messages: page.slice().reverse().map((m) => ({ ...m })), more: page.length > 0 && page[0].line > 1 };
}
