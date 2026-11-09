#!/usr/bin/env node
// agent-hub 命令：install / update / uninstall / doctor / open
// 用法：agent-hub install [--home <目录>] [--no-launchd] [--no-mcp]
//       agent-hub renew <员工号> [--dry-run] [--note "<文字>"]   反重力员工的对话撑爆了：开新对话接着干（bridges 发现撑爆也会自动做同一件事）
//   --home <目录>   把「家目录」换成这个目录来演练：代码、配置、员工表、日志、plist 全写进去，不碰本机真实的家目录；
//                   此时 launchd 只生成 plist、不加载，MCP 注册（如果没加 --no-mcp）也只写进这个目录。
//   --no-launchd    不加载 / 不卸载 launchd（plist 仍会生成）
//   --no-mcp        不注册 MCP（Claude Code、反重力）
// 重复跑结果一样；员工表已有不覆盖，config.json 里已经填好且能用的路径不覆盖。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TOOLS, configPath, readConfig, detectTool, isExe } from "./toolpaths.mjs";


if (process.platform === "win32") {
  await import("./windows-cli.mjs");
} else {

const SRC = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const homeArg = opt("--home");
if (homeArg !== undefined && (!homeArg || homeArg.startsWith("--"))) { console.error("--home 后面要跟一个目录"); process.exit(2); }
const HOME = homeArg ? path.resolve(homeArg) : (process.env.HOME || os.homedir());
const REHEARSAL = !!homeArg;
process.env.HOME = HOME;                       // 子进程（agy、claude、doctor）和 toolpaths 都认这个
const NO_LAUNCHD = flag("--no-launchd");
const NO_MCP = flag("--no-mcp");

const DEST = path.join(HOME, ".local", "share", "agent-hub");
const BINDIR = path.join(HOME, ".local", "bin");
const CONF_DIR = path.join(HOME, ".config", "agent-hub");
const STATE = path.join(CONF_DIR, "state.json");
const ROLES = path.join(HOME, ".config", "agy-team", "roles.json");
const LOGS = path.join(HOME, "agy-logs");
const AGENTS_DIR = path.join(HOME, "Library", "LaunchAgents");
const SETTINGS = path.join(HOME, ".claude", "settings.json");
const LABELS = { bridges: "dev.agent-hub.bridges", board: "dev.agent-hub.board", float: "dev.agent-hub.float" };
const OLD_LABELS = ["dev.agent-hub-legacy-bridges", "dev.agent-hub-legacy-board"];
const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const log = (...a) => console.log(...a);
const warn = (...a) => console.log("提醒：", ...a);
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n"); };
const run = (bin, args, extra = {}) => spawnSync(bin, args, { encoding: "utf8", env: { ...process.env, HOME }, ...extra });

function usage() {
  log(`agent-hub：让 Claude Code 主控和各类 agent 员工互相派活、发消息、看状态

  agent-hub install    安装（拷代码、配置、MCP、设 crossSessionInbound、常驻、自检），重复跑结果一样
  agent-hub update     拉最新代码，重装，重启常驻
  agent-hub uninstall  卸常驻、注销 MCP、恢复 settings.json 那一项（员工表和日志留着）
  agent-hub doctor     自检
  agent-hub open       打开看板 http://127.0.0.1:4646
  agent-hub float      打开桌面悬浮窗（install 时编译；收起后是一颗小球，右键有菜单）
  agent-hub float --quit
                       关掉悬浮窗（开机自动启动还在的话，下次开机仍会出现）
  agent-hub renew <员工号> [--dry-run] [--note "<文字>"]
                       反重力员工对话撑爆（超过 30MB 上限）后换新对话：沿用模型、标题、工作区，带上身份和发给它的最后一条活
                       （连带前后各 3 条往来），员工表换号。--dry-run 只看会发什么、不动手；
                       --note 把派活人的补充原样加进第一条消息（「派活人补充」，放在续上的活前面）

选项（install / update / uninstall 通用）：
  --home <目录>  在这个目录里演练，不碰真实家目录
  --no-launchd   不加载 / 不卸载 launchd
  --no-mcp       不注册 / 不注销 MCP`);
}

// ------------------------------------------------------------------ install
function copyCode() {
  if (path.resolve(SRC) === path.resolve(DEST)) { log(`代码已经在 ${DEST}，不用拷`); return; }
  const skip = (name) => name === ".git" || name === "node_modules" || name === ".DS_Store" || /\.bak/.test(name) || /^board-v\d.*\.html$/.test(name)
    || name === "roles.json" || name === "seats.json" || name.endsWith(".log");
  fs.mkdirSync(DEST, { recursive: true });
  fs.cpSync(SRC, DEST, { recursive: true, force: true, filter: (s) => !skip(path.basename(s)) });
  log(`代码拷到 ${DEST}`);
}

function linkCommands() {
  fs.mkdirSync(BINDIR, { recursive: true });
  for (const f of fs.readdirSync(path.join(DEST, "bin"))) {
    const target = path.join(DEST, "bin", f);
    try { fs.chmodSync(target, 0o755); } catch { /* 忽略 */ }
    const link = path.join(BINDIR, f);
    try { fs.rmSync(link, { force: true }); } catch { /* 忽略 */ }
    fs.symlinkSync(target, link);
  }
  for (const f of fs.readdirSync(DEST)) if (f.endsWith(".mjs")) try { fs.chmodSync(path.join(DEST, f), 0o755); } catch { /* 忽略 */ }
  log(`命令链到 ${BINDIR}`);
  if (!(process.env.PATH || "").split(":").includes(BINDIR)) warn(`把 ${BINDIR} 加进 PATH（写进 ~/.zshrc）：export PATH="$HOME/.local/bin:$PATH"`);
}

function writeConfig() {
  const old = readConfig(HOME);
  const cfg = { ...old };
  const lines = [];
  for (const t of TOOLS) {
    const keep = old[t] && isExe(old[t]);
    cfg[t] = keep ? old[t] : detectTool(t, HOME);
    lines.push(`${t}: ${cfg[t] || "（没找到，留空）"}`);
  }
  if (fs.existsSync(path.join(SRC, ".git"))) cfg.repo = SRC;
  writeJson(configPath(HOME), cfg);
  log(`本机工具路径 ${configPath(HOME)}\n  ` + lines.join("\n  "));
  return cfg;
}

function ensureRoles() {
  fs.mkdirSync(path.join(LOGS, "bridges"), { recursive: true });
  fs.mkdirSync(path.dirname(ROLES), { recursive: true });
  if (fs.existsSync(ROLES)) log(`员工表已存在，不覆盖：${ROLES}`);
  else { fs.copyFileSync(path.join(DEST, "roles.example.json"), ROLES); log(`已建员工表（示例两个桌面端员工 d1、d2），按需要改：${ROLES}`); }
}

function registerMcp(cfg) {
  const server = path.join(DEST, "server.mjs");
  const node = cfg.node || process.execPath;
  if (cfg.agy) {
    const r = run(cfg.agy, ["mcp", "add", "-e", "HUB_SIDE=employee", "agent-hub", node, server]);
    log(r.status === 0 ? "反重力：已注册 agent-hub MCP" : `反重力：注册失败（${(r.stderr || r.stdout || "").trim().slice(0, 160)}）`);
  } else log("没找到 agy（反重力命令行），跳过反重力接入");
  if (cfg.claude) {
    run(cfg.claude, ["mcp", "remove", "-s", "user", "agent-hub"]);
    const r = run(cfg.claude, ["mcp", "add", "-s", "user", "agent-hub", "-e", "HUB_SIDE=master", "--", node, server]);
    log(r.status === 0 ? "Claude Code：已注册 agent-hub MCP（用户级）" : `Claude Code：注册失败（${(r.stderr || r.stdout || "").trim().slice(0, 160)}）`);
  } else log("没找到 claude（Claude Code），跳过主控接入");
}

// 只改 crossSessionInbound 这一项；改之前先备份；原值记进 state.json，卸载时恢复
function setCrossSession() {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  const raw = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, "utf8") : null;
  let obj = {};
  if (raw !== null && raw.trim()) {
    try { obj = JSON.parse(raw); } catch { warn(`${SETTINGS} 不是合法 JSON，没动它。请手动加 "crossSessionInbound": "accept"`); return; }
  }
  if (obj.crossSessionInbound === "accept") { log("settings.json：crossSessionInbound 已经是 accept，不动"); return; }
  let backup = null;
  if (raw !== null) { backup = `${SETTINGS}.agent-hub-bak-${stamp()}`; fs.copyFileSync(SETTINGS, backup); }
  const state = readJson(STATE, {});
  if (!state.crossSessionInbound) state.crossSessionInbound = { had: "crossSessionInbound" in obj, value: obj.crossSessionInbound ?? null, backup };
  writeJson(STATE, state);
  obj.crossSessionInbound = "accept";
  const indent = raw?.match(/^([ \t]+)"/m)?.[1] ?? "  ";
  fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, indent) + (raw === null || raw.endsWith("\n") ? "\n" : ""));
  log(`settings.json：crossSessionInbound 设为 accept${backup ? `（原文件备份在 ${backup}）` : ""}`);
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function plistPath(label) { return path.join(AGENTS_DIR, `${label}.plist`); }

// 桌面悬浮窗：用系统自带的 swiftc 把 float.swift 编成 ~/Applications/Agent Hub.app
// 没有命令行工具 / 编译失败时返回 null，install 只提醒、不影响其他功能
const FLOAT_APP = () => path.join(HOME, "Applications", "Agent Hub.app");
function buildFloat() {
  if (REHEARSAL) { log("演练模式：跳过编译桌面悬浮窗"); return null; }
  const app = FLOAT_APP();
  const exe = path.join(app, "Contents", "MacOS", "AgentHub");
  const which = run("xcrun", ["-f", "swiftc"]);
  const swiftc = (which.stdout || "").trim();
  if (which.status !== 0 || !swiftc || !fs.existsSync(swiftc)) {
    warn("没找到 swiftc（Xcode 命令行工具没装），跳过桌面悬浮窗；其他功能照常。装好工具后重跑 agent-hub install");
    return null;
  }
  const src = path.join(DEST, "float.swift");
  if (!fs.existsSync(src)) { warn(`找不到 ${src}，跳过桌面悬浮窗`); return null; }
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  // 新系统的 swiftc 不带 -sdk 会报「unable to load standard library for target 'arm64-apple-macosxNN.0'」
  const sdk = (run("xcrun", ["--show-sdk-path"]).stdout || "").trim();
  const args = ["-parse-as-library", "-O"];
  if (sdk && fs.existsSync(sdk)) args.push("-sdk", sdk);
  args.push("-o", exe, src);
  const r = run(swiftc, args);
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ").slice(0, 240);
    warn(`桌面悬浮窗编译失败，跳过（${tail}）`);
    return null;
  }
  const info = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Agent Hub</string>
  <key>CFBundleDisplayName</key><string>Agent Hub</string>
  <key>CFBundleIdentifier</key><string>dev.agent-hub.float</string>
  <key>CFBundleExecutable</key><string>AgentHub</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMultipleInstancesProhibited</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), info);
  run("codesign", ["--force", "--deep", "--sign", "-", app]);   // 本机自签，免得每次启动被拦
  log(`桌面悬浮窗已编译：${app}`);
  return app;
}
function genPlists(cfg) {
  const node = cfg.node || process.execPath;
  const dirs = [path.join(HOME, ".local", "bin"), path.dirname(node), cfg.tmux && path.dirname(cfg.tmux), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean);
  const PATH = [...new Set(dirs)].join(":");
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const out = [];
  for (const [kind, label] of Object.entries(LABELS)) {
    const tmpl = fs.readFileSync(path.join(DEST, "launchd", `${label}.plist.tmpl`), "utf8");
    const text = tmpl.replaceAll("{{LABEL}}", xml(label)).replaceAll("{{NODE}}", xml(node)).replaceAll("{{DEST}}", xml(DEST))
      .replaceAll("{{HOME}}", xml(HOME)).replaceAll("{{PATH}}", xml(PATH));
    fs.writeFileSync(plistPath(label), text);
    out.push({ kind, label, file: plistPath(label) });
  }
  log(`launchd 配置已生成：\n  ${out.map((o) => o.file).join("\n  ")}`);
  return out;
}

function loadLaunchd(plists) {
  const uid = process.getuid();
  const domain = `gui/${uid}`;
  for (const old of OLD_LABELS) {                // 旧标签先卸掉（旧看板占着 4646），plist 改名留底
    const had = run("launchctl", ["print", `${domain}/${old}`]).status === 0;
    if (had) { run("launchctl", ["bootout", `${domain}/${old}`]); log(`旧常驻已卸载：${old}`); }
    const f = plistPath(old);
    if (fs.existsSync(f)) { fs.renameSync(f, `${f}.replaced-${stamp()}`); log(`旧 plist 改名留底：${path.basename(f)}.replaced-…`); }
  }
  for (const p of plists) {
    run("launchctl", ["bootout", `${domain}/${p.label}`]);
    let r = run("launchctl", ["bootstrap", domain, p.file]);
    if (r.status !== 0) r = run("launchctl", ["load", "-w", p.file]);
    log(r.status === 0 ? `常驻已加载：${p.label}` : `常驻加载失败：${p.label}（${(r.stderr || r.stdout || "").trim().slice(0, 160)}）`);
  }
}

function runDoctor() {
  const args = [path.join(DEST, "doctor.mjs")];
  if (NO_MCP) args.push("--no-mcp");
  if (NO_LAUNCHD || REHEARSAL) args.push("--no-launchd");
  const cfg = readConfig(HOME);
  const r = spawnSync(cfg.node || process.execPath, args, { stdio: "inherit", env: { ...process.env, HOME } });
  return r.status ?? 1;
}

function install() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) { console.error(`Node 版本太旧（${process.versions.node}），要 18 以上`); process.exit(1); }
  if (process.platform !== "darwin") { console.error("这一版只支持 macOS（会话间消息靠 Unix 套接字，常驻靠 launchd）；不支持 Windows"); process.exit(1); }
  if (REHEARSAL) log(`== 演练模式：家目录换成 ${HOME}，不碰真实家目录 ==`);
  copyCode();
  linkCommands();
  const cfg = writeConfig();
  ensureRoles();
  if (NO_MCP) log("跳过 MCP 注册（--no-mcp）"); else registerMcp(cfg);
  setCrossSession();
  const floatApp = buildFloat();
  const plists = genPlists(cfg);
  if (!floatApp) { const f = plistPath(LABELS.float); if (fs.existsSync(f)) fs.rmSync(f); }   // 没编出来就别留个拉不起来的常驻
  const load = !NO_LAUNCHD && !REHEARSAL;
  if (load) loadLaunchd(floatApp ? plists : plists.filter((p) => p.kind !== "float"));
  else log(NO_LAUNCHD ? "跳过 launchd 加载（--no-launchd）" : "演练模式：只生成 plist，不加载");
  if (load) spawnSync("sleep", ["6"]);           // 等桥登记完再自检
  log("\n== 自检 ==");
  const code = runDoctor();
  log(code === 0 ? "\n装好了。反重力桌面端要完全退出（Cmd+Q）再打开才会读到；Claude Code 要开新会话。" : "\n装完了，但自检有项目不通，看上面标「断」的行。");
  return code;
}

// ------------------------------------------------------------------ update
function update() {
  const cfg = readConfig(HOME);
  const repo = cfg.repo || (fs.existsSync(path.join(SRC, ".git")) ? SRC : "");
  if (!repo || !fs.existsSync(path.join(repo, ".git"))) { console.error("找不到代码仓库（config.json 的 repo）。进到克隆下来的目录里跑 bin/agent-hub install 一次就会记上。"); return 1; }
  log(`更新代码：${repo}`);
  const pull = run("git", ["-C", repo, "pull", "--ff-only"], { stdio: "inherit" });
  if (pull.status !== 0) { console.error("git pull 失败（有本地改动或没联网？）"); return 1; }
  const passthrough = argv.slice(1);
  const r = spawnSync(cfg.node || process.execPath, [path.join(repo, "cli.mjs"), "install", ...passthrough], { stdio: "inherit", env: { ...process.env, HOME } });
  return r.status ?? 1;
}

// ------------------------------------------------------------------ uninstall
function uninstall() {
  if (REHEARSAL) log(`== 演练模式：家目录 ${HOME} ==`);
  const cfg = readConfig(HOME);
  if (!NO_LAUNCHD && !REHEARSAL) {
    const domain = `gui/${process.getuid()}`;
    for (const label of Object.values(LABELS)) {
      run("launchctl", ["bootout", `${domain}/${label}`]);
      log(`常驻已卸载：${label}`);
    }
  }
  if (!NO_LAUNCHD || REHEARSAL) for (const label of Object.values(LABELS)) if (fs.existsSync(plistPath(label))) { fs.rmSync(plistPath(label)); log(`已删除 ${plistPath(label)}`); }
  const floatApp = FLOAT_APP();
  if (fs.existsSync(floatApp)) {
    run("pkill", ["-f", path.join(floatApp, "Contents", "MacOS", "AgentHub")]);
    fs.rmSync(floatApp, { recursive: true, force: true });
    log(`已删除桌面悬浮窗 ${floatApp}`);
  }
  if (!NO_MCP) {
    if (cfg.claude) { const r = run(cfg.claude, ["mcp", "remove", "-s", "user", "agent-hub"]); log(r.status === 0 ? "Claude Code：已注销 agent-hub MCP" : "Claude Code：没有可注销的 agent-hub"); }
    if (cfg.agy) { const r = run(cfg.agy, ["mcp", "remove", "agent-hub"]); log(r.status === 0 ? "反重力：已注销 agent-hub MCP" : "反重力：没有可注销的 agent-hub"); }
  }
  const state = readJson(STATE, {});
  const s = state.crossSessionInbound;
  if (s) {
    const obj = readJson(SETTINGS, null);
    if (obj && obj.crossSessionInbound === "accept") {
      if (s.had) obj.crossSessionInbound = s.value; else delete obj.crossSessionInbound;
      const raw = fs.readFileSync(SETTINGS, "utf8");
      fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, raw.match(/^([ \t]+)"/m)?.[1] ?? "  ") + (raw.endsWith("\n") ? "\n" : ""));
      log(`settings.json：crossSessionInbound 已恢复为 ${s.had ? JSON.stringify(s.value) : "没设"}`);
    } else log("settings.json：crossSessionInbound 现在不是 accept（可能被改过），不动");
    delete state.crossSessionInbound;
    writeJson(STATE, state);
  }
  try {
    for (const f of fs.readdirSync(BINDIR)) {
      const link = path.join(BINDIR, f);
      if (fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link).startsWith(path.join(DEST, "bin") + path.sep)) fs.rmSync(link);
    }
    log(`已移除 ${BINDIR} 里指向 agent-hub 的命令`);
  } catch { /* 目录不存在 */ }
  log(`\n员工表（${ROLES}）、日志（${LOGS}）、代码（${DEST}）、本机配置（${CONF_DIR}）都留着；不要了自己删。`);
  return 0;
}

// ------------------------------------------------------------------ doctor / open
function doctor() {
  const dir = fs.existsSync(path.join(DEST, "doctor.mjs")) ? DEST : SRC;
  const cfg = readConfig(HOME);
  const r = spawnSync(cfg.node || process.execPath, [path.join(dir, "doctor.mjs"), ...argv.slice(1).filter((a, i, all) => a !== "--home" && all[i - 1] !== "--home")],
    { stdio: "inherit", env: { ...process.env, HOME } });
  return r.status ?? 1;
}

async function open() {
  const url = "http://127.0.0.1:4646";
  try { await fetch(url, { signal: AbortSignal.timeout(3000) }); } catch { warn("看板现在打不开（常驻没起来？）先跑 agent-hub doctor 看看。"); }
  run("open", [url]);
  log(url);
  return 0;
}

function float() {
  const app = FLOAT_APP();
  const exe = path.join(app, "Contents", "MacOS", "AgentHub");
  if (flag("--quit")) {
    const r = run("pkill", ["-f", exe]);
    log(r.status === 0 ? "悬浮窗已退出" : "悬浮窗没在运行");
    return 0;
  }
  if (!fs.existsSync(exe)) {
    console.error(`桌面悬浮窗还没装（${app} 不存在）。没有命令行工具时 install 会跳过它；装好 Xcode 命令行工具后重跑 agent-hub install。`);
    return 1;
  }
  const r = run("open", [app]);
  if (r.status !== 0) { console.error(`打开失败：${(r.stderr || r.stdout || "").trim()}`); return 1; }
  log("悬浮窗已打开（收起后是桌面上一颗小球，右键有菜单）");
  return 0;
}

function renew() {
  const dir = fs.existsSync(path.join(DEST, "desk.mjs")) ? DEST : SRC;
  const cfg = readConfig(HOME);
  const rest = argv.slice(1).filter((a, i, all) => a !== "--home" && all[i - 1] !== "--home");
  const r = spawnSync(cfg.node || process.execPath, [path.join(dir, "desk.mjs"), "renew", ...rest], { stdio: "inherit", env: { ...process.env, HOME } });
  return r.status ?? 1;
}

const commands = { install, update, uninstall, doctor, open, renew, float };
if (!commands[cmd]) { usage(); process.exit(cmd && cmd !== "help" && cmd !== "--help" ? 2 : 0); }
process.exit((await commands[cmd]()) || 0);

}
