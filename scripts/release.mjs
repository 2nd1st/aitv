// 发布 / 回滚节目单版本（详见 README「发布与回滚」）。需要 CLOUDFLARE_API_TOKEN（source /home/box/.cf_aitv.env）。
//   node scripts/release.mjs list               本地版本 + 线上指针
//   node scripts/release.mjs check <version>    只校验本地 releases/<version>
//   node scripts/release.mjs publish <version>  校验 → R2 里还没有的音频才上传（<hash>.mp3 + <hash>.json 时间轴）→ seed 写 KV（seed:<version>）。不切换。
//   node scripts/release.mjs use <version>      校验 + 逐条 HEAD 线上 /audio/<version>/… 确认能播，可播 >= 15 条才把 KV 指针切过去
//   node scripts/release.mjs rollback [--dry-run]  KV 指针切回 previous（不用重新部署）；previous 已作废就拒绝
//   node scripts/release.mjs takedown <id>      下架：id（和它在各版本里的音频地址）进 KV "takedown"，/api/schedule 立刻按它过滤；
//                                               含这条的版本自动标成作废（pointer.void），use / rollback 都不会再切过去
//   node scripts/release.mjs untakedown <id>    撤销下架（不撤销作废，作废版本要人工判断）
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSeed, MIN_PLAYABLE, addTakedown, removeTakedown, isVoid, markVoid, planRollback, takedownMatches } from "../src/release.js";
import { gitGuard } from "./guard.mjs";

const ROOT = new URL("../releases/", import.meta.url);
const BASE = process.env.AITV_BASE || "https://aitv.qiaomu.ai";
const BUCKET = "aitv-audio";
const wr = (...args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const kvGet = (key) => { try { return JSON.parse(wr("kv", "key", "get", "--binding", "SCHEDULE", key, "--remote").trim()); } catch { return null; } };
const kvPutFile = (key, path) => wr("kv", "key", "put", "--binding", "SCHEDULE", key, "--path", path, "--remote");
const kvPutJson = (key, obj) => { const f = join(tmpdir(), `aitv-kv-${Date.now()}.json`); writeFileSync(f, JSON.stringify(obj)); kvPutFile(key, f); };
const seedPath = (v) => new URL(`${v}/seed.json`, ROOT);
const CACHE = new URL("../audio-cache/", import.meta.url);
const isHash = (audio) => /^\/audio\/[0-9a-f]{16}\.mp3$/.test(audio);
// 内容寻址的音频在 audio-cache/；早期按版本放的在 releases/<v>/audio/
const localFile = (v, audio) => isHash(audio) ? new URL(audio.split("/").pop(), CACHE) : new URL(`${v}/audio/${audio.split("/").pop()}`, ROOT);
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
// publish / use 会改线上：只允许从干净的 main（HEAD == origin/main）发。rollback 只把指针换回上一版，应急用，不设闸。
const guard = cmd === "publish" || cmd === "use" ? gitGuard() : null;
const localVersions = () => readdirSync(ROOT).filter((d) => existsSync(seedPath(d))).sort();
if (cmd === "list") {
  const ptr = kvGet("pointer") || {};
  for (const d of readdirSync(ROOT).filter((d) => existsSync(seedPath(d))).sort())
    console.log(`${d}${d === ptr.version ? "  ← 线上" : ""}${d === ptr.previous ? (isVoid(ptr, d) ? "  ← 上一版（已作废，不能回滚）" : "  ← 上一版（可回滚）") : ""}${isVoid(ptr, d) && d !== ptr.previous ? "  （作废）" : ""}`);
} else if (cmd === "check") {
  const r = check(v); report(v, r); process.exit(r.ok ? 0 : 1);
} else if (cmd === "publish") {
  const r = check(v); report(v, r);
  if (!r.ok && process.argv[4] !== "--legacy") { console.log("不上传"); process.exit(1); }
  const seed = readSeed(v);
  let put = 0, skip = 0;
  for (const it of seed.items) {
    const key = it.audio.replace(/^\/audio\//, "");
    const file = localFile(v, it.audio);
    // 已经在线上（内容寻址，同 key 必同内容）就不再传
    const head = await fetch(BASE + it.audio, { method: "HEAD" }).catch(() => null);
    if (head?.status === 200 && Number(head.headers.get("content-length")) === statSync(file).size) { skip++; process.stdout.write("="); continue; }
    wr("r2", "object", "put", `${BUCKET}/${key}`, "--file", file.pathname, "--content-type", "audio/mpeg", "--cache-control", "public, max-age=31536000, immutable", "--remote");
    const meta = file.pathname.replace(/\.mp3$/, ".json");
    if (isHash(it.audio) && existsSync(meta)) wr("r2", "object", "put", `${BUCKET}/${key.replace(/\.mp3$/, ".json")}`, "--file", meta, "--content-type", "application/json", "--remote");
    put++; process.stdout.write(".");
  }
  kvPutFile(`seed:${v}`, seedPath(v).pathname);
  console.log(`\nR2 ${BUCKET}：新传 ${put} 个音频，${skip} 个已存在跳过；seed 写入 KV seed:${v}`);
} else if (cmd === "use") {
  const r = check(v); report(v, r);
  if (!r.ok) { console.log("不切换，线上保持原版本"); process.exit(1); }
  { const p0 = kvGet("pointer") || {}; if (isVoid(p0, v)) { console.log(`${v} 已作废（${p0.voidReasons?.[v] || "void"}），拒绝切换`); process.exit(1); } }
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
  if (ptr.version === v) {
    // 已经是线上版本：只补记 / 更新提交号，previous 不动
    kvPutJson("pointer", { ...ptr, commit: guard.commit, commitRecordedAt: new Date().toISOString() });
    console.log(`已经是线上版本；指针记下提交 ${guard.commit.slice(0, 7)}`); process.exit(0);
  }
  kvPutJson("pointer", { ...ptr, version: v, previous: ptr.version || null, commit: guard.commit, previousCommit: ptr.commit || null, switchedAt: new Date().toISOString(), rolledBack: false });
  console.log(`线上指针：${ptr.version} → ${v}（上一版 ${ptr.version} 保留，可回滚）。KV 全球生效约一分钟。`);
} else if (cmd === "rollback") {
  const ptr = kvGet("pointer") || {};
  const plan = planRollback(ptr, (x) => !!kvGet(`seed:${x}`));
  if (!plan.ok) { console.log(`不回滚：${plan.reason}`); process.exit(1); }
  if (process.argv.includes("--dry-run")) { console.log(`（dry-run）会回滚：${ptr.version} → ${plan.to}`); process.exit(0); }
  kvPutJson("pointer", { ...ptr, version: plan.to, previous: ptr.version, commit: ptr.previousCommit || null, previousCommit: ptr.commit || null, switchedAt: new Date().toISOString(), rolledBack: true });
  console.log(`已回滚：${ptr.version} → ${plan.to}。KV 全球生效约一分钟，不用重新部署。`);
} else if (cmd === "takedown" || cmd === "untakedown") {
  if (!v) { console.log(`用法：node scripts/release.mjs ${cmd} <条目 id>`); process.exit(2); }
  // 本地各版本里这条的音频地址一起记上（同一条换了 id 也能按音频拦住）
  const hits = [];
  for (const d of localVersions()) for (const it of readSeed(d).items) if (it.id === v) hits.push({ version: d, audio: it.audio });
  const audios = [...new Set(hits.map((h) => h.audio).filter(Boolean))];
  const td = kvGet("takedown") || { ids: [], audio: [] };
  if (cmd === "untakedown") {
    kvPutJson("takedown", removeTakedown(td, v, audios));
    console.log(`已撤销下架 ${v}（作废的版本保持作废）`); process.exit(0);
  }
  const next = addTakedown(td, v, audios);
  kvPutJson("takedown", next);
  // 含这条的版本全部作废：本地 releases/ 和 KV 里线上 / 上一版的 seed 都查
  const ptr = kvGet("pointer") || {};
  const affected = new Set(hits.map((h) => h.version));
  for (const x of [ptr.version, ptr.previous].filter(Boolean)) {
    const seed = kvGet(`seed:${x}`);
    if (seed?.items?.some((it) => takedownMatches(next, it))) affected.add(x);
  }
  if (affected.size) kvPutJson("pointer", markVoid(ptr, [...affected], `含已下架条目 ${v}`));
  console.log(`已下架 ${v}（音频 ${audios.join(", ") || "无"}）；作废版本：${[...affected].join(", ") || "无"}。/api/schedule 约半分钟到一分钟内生效。`);
} else {
  console.log("用法：node scripts/release.mjs list | check <v> | publish <v> | use <v> | rollback [--dry-run] | takedown <id> | untakedown <id>"); process.exit(2);
}
