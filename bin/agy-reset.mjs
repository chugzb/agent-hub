// 让 Kiro 员工下一单新开一个对话（上下文太长、跑偏时用）：node agy-reset.mjs kr1
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { roles, JOBS, stamp } from "./hub-lib.mjs";

const role = process.argv[2];
const r = roles()[role];
if (!r || r.kind !== "kiro") { console.log("用法：agy-reset <Kiro 员工号>，比如 kr1"); process.exit(1); }
const home = r.home || join(JOBS, `${role}-home`);
const m = join(home, ".kiro-session-started");
if (existsSync(m)) renameSync(m, `${m}.${stamp()}`);
console.log(`${role} 下一单会新开对话（家目录 ${home}，老对话还在，用 kiro-cli chat --list-sessions 能看到）`);
