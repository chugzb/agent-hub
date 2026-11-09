// DeepSeek-only child environment. Never mutate process.env or shared Claude settings.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { HOME } from "../home.mjs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Transform } from "node:stream";

export const KEY_FILE = process.env.DEEPSEEK_ENV_FILE || join(HOME, ".config", "agent-hub", "deepseek.env");
export const RULES_FILE = join(HOME, ".config", "agy-team", "ds-rules.md");
export const BASE_URL = process.env.HUB_DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic";

export function normalizeModel(model = "deepseek-flash") {
  if (["flash", "deepseek-flash"].includes(model)) return "deepseek-flash";
  if (["pro", "deepseek-v4-pro"].includes(model)) return "deepseek-v4-pro";
  throw new Error("DS 模型只支持 flash / pro（或对应的完整模型名）");
}

export function readDeepSeekKey(file = KEY_FILE) {
  if (!existsSync(file)) throw new Error(`缺少钥匙文件：${file}；请老板填写 DEEPSEEK_API_KEY`);
  const values = readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)
    .filter(line => /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=/.test(line));
  if (values.length !== 1) throw new Error("deepseek.env 必须只有一行 DEEPSEEK_API_KEY 配置");
  let value = values[0].replace(/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*/, "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1).trim();
  if (!value || /\s|["']/.test(value) || /^<.*>$/.test(value)) throw new Error("deepseek.env 钥匙为空或格式不对，等老板填钥匙；未发出请求");
  return value;
}

export function createDeepSeekEnv({ parentEnv = process.env, model, profile = "official", keyFile = KEY_FILE, configDir } = {}) {
  const selected = normalizeModel(model);
  const env = { ...parentEnv };
  for (const name of Object.keys(env)) {
    if (/^ANTHROPIC_/i.test(name) || /^DEEPSEEK_API_KEY$/i.test(name) || /^CLAUDE_CODE_OAUTH/i.test(name)
      || /^CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$/i.test(name) || /^CLAUDE_CONFIG_DIR$/i.test(name)) delete env[name];
  }
  Object.assign(env, {
    ANTHROPIC_BASE_URL: BASE_URL,
    ANTHROPIC_AUTH_TOKEN: readDeepSeekKey(keyFile),
    ANTHROPIC_MODEL: selected,
    ANTHROPIC_SMALL_FAST_MODEL: "deepseek-flash",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-flash",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
    CLAUDE_CODE_SUBAGENT_MODEL: selected,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "256000",
    CLAUDE_CONFIG_DIR: configDir || join(HOME, ".config", "agy-team", "claude-ds", profile),
    DISABLE_AUTOUPDATER: "1",
  });
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  return env;
}

export function officialClaudeCommand(env = process.env) {
  // Resolve the official npm package installed on this Windows host, not a shell alias.
  const root = join(env.APPDATA || join(HOME, "AppData", "Roaming"), "npm", "node_modules", "@anthropic-ai", "claude-code");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.name !== "@anthropic-ai/claude-code") throw new Error("Claude Code 官方包识别失败");
  const target = resolve(root, typeof pkg.bin === "string" ? pkg.bin : pkg.bin.claude);
  if (!existsSync(target)) throw new Error("Claude Code 可执行文件不存在，请重新安装官方 npm 包");
  return /\.[cm]?js$/i.test(target) ? { command: process.execPath, args: [target] } : { command: target, args: [] };
}

export function redactText(value, secret) {
  let text = String(value);
  if (secret) text = text.split(secret).join("[REDACTED]");
  return text.replace(/sk\x2d[A-Za-z0-9_-]{12,}/g, "[REDACTED]");
}

export function redactingStream(secret) {
  // Retain a suffix so a token split across stdout chunks is still removed.
  let pending = "";
  const keep = Math.max(secret?.length || 0, 256);
  return new Transform({
    decodeStrings: false,
    transform(chunk, encoding, callback) {
      pending += chunk;
      pending = redactText(pending, secret);
      if (pending.length > keep) {
        this.push(pending.slice(0, -keep));
        pending = pending.slice(-keep);
      }
      callback();
    },
    flush(callback) { this.push(redactText(pending, secret)); callback(); },
  });
}

export function startDeepSeekJob({ role, dir, promptFd, log, parentEnv, model }) {
  const env = createDeepSeekEnv({ parentEnv, model, profile: role });
  const rules = existsSync(RULES_FILE) ? readFileSync(RULES_FILE, "utf8").replace(/^\uFEFF/, "") : "";
  const cli = officialClaudeCommand(env);
  const args = [...cli.args, "-p", "--dangerously-skip-permissions", "--model", env.ANTHROPIC_MODEL,
    "--append-system-prompt", rules, "--output-format", "stream-json", "--verbose",
    "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
  const child = spawn(cli.command, args, { cwd: dir, env, stdio: [promptFd, "pipe", "pipe"], windowsHide: true });
  const secret = env.ANTHROPIC_AUTH_TOKEN;
  const redact = text => redactText(text, secret);
  const state = { sawResult: false, isError: false, models: new Set(), last: "", parseBuffer: "" };
  appendFileSync(log, `[hub] claude-ds model=${env.ANTHROPIC_MODEL}; endpoint=${BASE_URL}; isolated config; credentials omitted\n`);
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    const safe = stream.pipe(redactingStream(secret));
    safe.on("data", data => {
      const text = String(data);
      appendFileSync(log, text);
      if (stream !== child.stdout) return;
      state.parseBuffer += text;
      const lines = state.parseBuffer.split("\n");
      state.parseBuffer = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant" && event.message?.model) state.models.add(event.message.model);
          if (event.type === "result") {
            state.sawResult = true;
            state.isError = Boolean(event.is_error);
            state.last = String(event.result || event.errors?.join(" / ") || "");
          }
        } catch { /* Non-JSON diagnostics remain in the sanitized log. */ }
      }
    });
  }
  return { child, state, redact };
}

async function launch() {
  const [tier = "flash", ...inputArgs] = process.argv.slice(2);
  let model = tier;
  const args = [];
  for (let i = 0; i < inputArgs.length; i++) {
    if (inputArgs[i] === "--model") model = inputArgs[++i];
    else if (inputArgs[i].startsWith("--model=")) model = inputArgs[i].slice(8);
    else args.push(inputArgs[i]);
  }
  const diagnostic = args.some(arg => ["--version", "-v", "--help", "-h"].includes(arg));
  // Interactive sessions share the normal registry, memory and MCP configuration.
  // Credentials and model overrides live only in this child environment.
  const env = diagnostic ? { ...process.env } : createDeepSeekEnv({ model, configDir: join(HOME, ".claude") });
  if (!diagnostic) {
    delete env.CLAUDE_CONFIG_DIR;
    // An independent terminal must not inherit a parent Claude child-session marker.
    for (const name of ["CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
      "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PID", "CLAUDECODE"]) delete env[name];
  }
  const cli = officialClaudeCommand(env);
  const hasName = args.some(arg => arg === "--name" || arg === "-n" || arg.startsWith("--name="));
  const defaults = diagnostic ? [] : ["--model", env.ANTHROPIC_MODEL,
    ...(!hasName ? ["--name", env.ANTHROPIC_MODEL === "deepseek-v4-pro" ? "Claude DS Pro" : "Claude DS Flash"] : [])];
  const child = spawn(cli.command, [...cli.args, ...defaults, ...args], { env, stdio: "inherit", windowsHide: false });
  child.on("error", () => { console.error("Claude DS 启动失败，请检查官方 CLI 安装"); process.exitCode = 1; });
  child.on("close", code => { process.exitCode = code ?? 1; });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  launch().catch(error => { console.error(error.message); process.exitCode = 1; });
}
