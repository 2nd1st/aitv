// 发布 / 回滚节目单版本（详见 README「发布与回滚」）。需要 CLOUDFLARE_API_TOKEN（source /home/box/.cf_aitv.env）。
//   node scripts/release.mjs list               本地版本 + 线上指针
//   node scripts/release.mjs check <version>    只校验本地 releases/<version>
//   node scripts/release.mjs publish <version>  校验 → 音频传 R2（<version>/<file>.mp3）→ seed 写 KV（seed:<version>）。不切换。
//   node scripts/release.mjs use <version>      校验 + 逐条 HEAD 线上 /audio/<version>/… 确认能播，可播 >= 15 条才把 KV 指针切过去
//   node scripts/release.mjs rollback           KV 指针切回 previous（不用重新部署）
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSeed, MIN_PLAYABLE } from "../src/release.js";

const ROOT = new URL("../releases/", import.meta.url);
const BASE = process.env.AITV_BASE || "https://aitv.qiaomu.ai";
const BUCKET = "aitv-audio";
const wr = (...args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const kvGet = (key) => { try { return JSON.parse(wr("kv", "key", "get", "--binding", "SCHEDULE", key, "--remote").trim()); } catch { return null; } };
const kvPutFile = (key, path) => wr("kv", "key", "put", "--binding", "SCHEDULE", key, "--path", path, "--remote");
const kvPutJson = (key, obj) => { const f = join(tmpdir(), `aitv-kv-${Date.now()}.json`); writeFileSync(f, JSON.stringify(obj)); kvPutFile(key, f); };
const seedPath = (v) => new URL(`${v}/seed.json`, ROOT);
const localFile = (v, audio) => new URL(`${v}/audio/${audio.split("/").pop()}`, ROOT);
const readSeed = (v) => JSON.parse(readFileSync(seedPath(v), "utf8"));

function check(v) {
  if (!existsSync(seedPath(v))) return { ok: false, playable: 0, audioOk: 0, errors: [`没有 releases/${v}/seed.json`] };
  return checkSeed(readSeed(v), v, { audioBytes: (a) => { const f = localFile(v, a); return existsSync(f) ? statSync(f).size : 0; } });
}
function report(v, r) {
  console.log(`${v}：${r.ok ? "✓ 通过" : "✗ 不通过"}，内容合格可播 ${r.playable} 条（音频齐全 ${r.audioOk} 条）`);
  for (const e of r.errors) console.log("  - " + e);
}

const [cmd, v] = process.argv.slice(2);
if (cmd === "list") {
  const ptr = kvGet("pointer") || {};
  for (const d of readdirSync(ROOT).filter((d) => existsSync(seedPath(d))).sort())
    console.log(`${d}${d === ptr.version ? "  ← 线上" : d === ptr.previous ? "  ← 上一版（可回滚）" : ""}`);
} else if (cmd === "check") {
  const r = check(v); report(v, r); process.exit(r.ok ? 0 : 1);
} else if (cmd === "publish") {
  const r = check(v); report(v, r);
  if (!r.ok && process.argv[4] !== "--legacy") { console.log("不上传"); process.exit(1); }
  const seed = readSeed(v);
  for (const it of seed.items) {
    const key = it.audio.replace(/^\/audio\//, "");
    wr("r2", "object", "put", `${BUCKET}/${key}`, "--file", localFile(v, it.audio).pathname, "--content-type", "audio/mpeg", "--remote");
    process.stdout.write(".");
  }
  kvPutFile(`seed:${v}`, seedPath(v).pathname);
  console.log(`\n已上传 ${seed.items.length} 个音频到 R2 ${BUCKET}/${v}/，seed 写入 KV seed:${v}`);
} else if (cmd === "use") {
  const r = check(v); report(v, r);
  if (!r.ok) { console.log("不切换，线上保持原版本"); process.exit(1); }
  if (!kvGet(`seed:${v}`)) { console.log(`KV 里没有 seed:${v}，先 publish`); process.exit(1); }
  let live = 0;
  for (const it of readSeed(v).items) {
    const res = await fetch(BASE + it.audio, { method: "HEAD" });
    const okLen = Number(res.headers.get("content-length")) === statSync(localFile(v, it.audio)).size;
    if (res.status === 200 && res.headers.get("content-type") === "audio/mpeg" && okLen) live++;
    else console.log(`  - 线上音频不对：${it.audio} ${res.status}`);
  }
  if (live < MIN_PLAYABLE || live < r.playable) { console.log(`线上能播 ${live} 条，不切换`); process.exit(1); }
  const ptr = kvGet("pointer") || {};
  if (ptr.version === v) { console.log("已经是线上版本"); process.exit(0); }
  kvPutJson("pointer", { version: v, previous: ptr.version || null, switchedAt: new Date().toISOString() });
  console.log(`线上指针：${ptr.version} → ${v}（上一版 ${ptr.version} 保留，可回滚）。KV 全球生效约一分钟。`);
} else if (cmd === "rollback") {
  const ptr = kvGet("pointer") || {};
  if (!ptr.previous || !kvGet(`seed:${ptr.previous}`)) { console.log("没有可回滚的上一版"); process.exit(1); }
  kvPutJson("pointer", { version: ptr.previous, previous: ptr.version, switchedAt: new Date().toISOString() });
  console.log(`已回滚：${ptr.version} → ${ptr.previous}。KV 全球生效约一分钟，不用重新部署。`);
} else {
  console.log("用法：node scripts/release.mjs list | check <v> | publish <v> | use <v> | rollback"); process.exit(2);
}
