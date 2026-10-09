// 唯一的部署入口：npm run deploy（需要 source /home/box/.cf_aitv.env）。
// 闸门（scripts/guard.mjs）过了才构建并 wrangler deploy，并把当前提交注入 Worker（BUILD_COMMIT → /api/schedule 的 commit）。
import { execFileSync } from "node:child_process";
import { gitGuard } from "./guard.mjs";

const { commit, root } = gitGuard();
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
run("npm", ["run", "build"]);
run("npx", ["wrangler", "deploy", "--define", `BUILD_COMMIT:"${commit}"`]);
console.log(`已部署提交 ${commit}`);
