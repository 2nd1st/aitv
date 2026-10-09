// 唯一的部署入口：npm run deploy（需要 设置自己的 Cloudflare 凭据）。
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

// wrangler 在 routes 那步报错就不会再去设定时触发器（[triggers] crons），这里按 wrangler.toml 补设、再读回来核对。
// 用的是同一个 CLOUDFLARE_API_TOKEN，走的是 wrangler 本来要调的同一个接口（Workers Scripts → schedules）。
import { readFileSync } from "node:fs";
const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const name = /^name\s*=\s*"([^"]+)"/m.exec(toml)[1];
const crons = (/^\[triggers\][^[]*?crons\s*=\s*\[([^\]]*)\]/ms.exec(toml)?.[1] || "").match(/"[^"]+"/g)?.map((x) => x.slice(1, -1)) || [];
// Reuse Wrangler's OAuth session when no API token was supplied. Never log credentials.
const token = process.env.CLOUDFLARE_API_TOKEN || JSON.parse(execFileSync("npx", ["wrangler", "auth", "token", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).token;
const acct = process.env.CLOUDFLARE_ACCOUNT_ID || (await (await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: { authorization: `Bearer ${token}` } })).json()).result?.[0]?.id;
const api = `https://api.cloudflare.com/client/v4/accounts/${acct}/workers/scripts/${name}/schedules`;
const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const schedules = async () => {
  const response = await fetch(api, { headers: H, signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  if (!response.ok || !body.success || !Array.isArray(body.result?.schedules)) throw new Error("无法核对定时触发器；请检查 Cloudflare 认证和账户权限");
  return body.result.schedules.map(x => x.cron);
};
const cur = await schedules();
if (JSON.stringify([...cur].sort()) !== JSON.stringify([...crons].sort())) {
  const r = await (await fetch(api, { method: "PUT", headers: H, body: JSON.stringify(crons.map((cron) => ({ cron }))) })).json();
  if (!r.success) { console.error("✗ 定时触发器设置失败", JSON.stringify(r.errors)); process.exit(1); }
}
const now = await schedules();
if (JSON.stringify([...now].sort()) !== JSON.stringify([...crons].sort())) {
  console.error("✗ 线上定时触发器与 wrangler.toml 不一致"); process.exit(1);
}
console.log(`定时触发器：${now.join(", ") || "无"}`);
