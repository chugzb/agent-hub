// --home is shared by all Windows entrypoints and inherited by child processes.
import os from "node:os";
import path from "node:path";
const at = process.argv.indexOf("--home");
if (at >= 0) {
  if (!process.argv[at + 1] || process.argv[at + 1].startsWith("--")) throw new Error("--home 需要目录");
  process.env.HUB_HOME = path.resolve(process.argv[at + 1]);
  process.argv.splice(at, 2);
}
export const HOME = path.resolve(process.env.HUB_HOME || process.env.HOME || os.homedir());
if (process.env.HUB_HOME) process.env.HUB_HOME = HOME;
export const ISOLATED = path.normalize(HOME).toLowerCase() !== path.normalize(os.homedir()).toLowerCase();
