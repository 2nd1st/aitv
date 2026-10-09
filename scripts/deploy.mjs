// 唯一的部署入口：npm run deploy（需要 source /home/box/.cf_aitv.env）。
// 闸门（scripts/guard.mjs）过了才构建并 wrangler deploy，并把当前提交注入 Worker（BUILD_COMMIT → /api/schedule 的 commit）。
// 部署完以线上 /api/schedule 返回的 commit 为准：token 没有 zone 路由权限时 wrangler 会在上传成功后报 routes 错误并返回非零，
// 这时只要线上 commit 已经是 HEAD 就算成功；对不上才算失败。
import { execFileSync } from "node:child_process";
import { gitGuard } from "./guard.mjs";

const BASE = process.env.AITV_BASE || "https://aitv.qiaomu.ai";
const { commit, root } = gitGuard();
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
run("npm", ["run", "build"]);
let wranglerOk = true;
try { run("npx", ["wrangler", "deploy", "--define", `BUILD_COMMIT:"${commit}"`]); } catch { wranglerOk = false; }

let live = null;
for (let i = 0; i < 12 && live !== commit; i++) {
  try { live = (await (await fetch(`${BASE}/api/schedule`, { cache: "no-store" })).json()).commit; } catch {}
  if (live !== commit) await new Promise((r) => setTimeout(r, 5000));
}
if (live === commit) {
  console.log(`${wranglerOk ? "" : "（wrangler 报了错，但上传已生效）"}已部署提交 ${commit}，线上 /api/schedule commit 一致`);
} else {
  console.error(`✗ 线上 commit 是 ${live}，不是 ${commit}`); process.exit(1);
}
