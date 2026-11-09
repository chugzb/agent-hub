// 员工发消息给主控：node agy-reply.mjs <员工> help|progress|note "内容"
import { appendMsg, MASTER } from "./hub-lib.mjs";

const [role, type, ...rest] = process.argv.slice(2);
const text = rest.join(" ").trim();
if (!role || !["help", "progress", "note", "done"].includes(type) || !text) {
  console.log("用法：agy-reply <员工> help|progress|note \"内容\"");
  process.exit(1);
}
const m = appendMsg(role, MASTER, type, text);
console.log(`已发给主控（消息 ${m.id}）${type === "help" ? "。按你的默认选项继续干，主控回复用 agy-read 看" : ""}`);
