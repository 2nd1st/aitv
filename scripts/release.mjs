// 发布 / 回滚节目单版本（详见 README「发布与回滚」）。需要 CLOUDFLARE_API_TOKEN（source /home/box/.cf_aitv.env）。
//   node scripts/release.mjs list               本地版本 + 线上指针
//   node scripts/release.mjs check <version>    只校验本地 releases/<version>
//   node scripts/release.mjs publish <version>  校验 → R2 里还没有的音频才上传（<hash>.mp3 + <hash>.json 时间轴）→ seed 写 KV（seed:<version>）。不切换。
//   node scripts/release.mjs use <version>      校验 + 逐条 HEAD 线上 /audio/<version>/… 确认能播，可播 >= 15 条才把 KV 指针切过去
//   node scripts/release.mjs rollback [--dry-run]  KV 指针切回 previous（不用重新部署）；previous 已作废就拒绝
//   node scripts/release.mjs takedown <id|hash> 下架「这一版稿子」：id 在线上版本里解析成稿子 hash（=音频文件名），hash 进 KV "takedown"
//                                               （id 只记作参考）；/api/schedule 按 hash 过滤，同一个 id 换了新稿子照常播。
//                                               含这版稿子的版本自动标成作废（pointer.void），use / rollback 都不会再切过去
//   node scripts/release.mjs untakedown <id|hash> 撤销下架（不撤销作废，作废版本要人工判断）
//   node scripts/release.mjs takedown <id|hash> --now  紧急下架：立刻生效，正在播的那条也切掉
//   node scripts/release.mjs timeline           看 KV 里的时间线（current / next / switchAt）
//   node scripts/release.mjs timeline-init      按线上指针 + 下架名单把「此刻实际在播的」写成时间线（不改变任何人的播放位置）
//   切版本 / 回滚 / 下架都不立刻换：写时间线 { current, next, switchAt }，switchAt = 「现在 + 90 秒」之后的第一个条目边界
//   node scripts/release.mjs takedown-migrate   把旧格式（按 id）的下架名单迁成按稿子 hash
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSeed, MIN_PLAYABLE, applyTakedown, addTakedown, removeTakedown, migrateTakedown, scriptHashOf, isVoid, markVoid, planRollback, takedownMatches } from "../src/release.js";
import { gitGuard } from "./guard.mjs";
import { planTimeline, effective, LEAD_MS } from "../src/timeline.js";
import { buildSchedule } from "../src/schedule.js";

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
const fmt = (ms) => `${new Date(ms + 8 * 3600_000).toISOString().slice(11, 19)}（UTC+8）`;
// KV 里还没有时间线：按旧的读法（指针 + seed + 下架名单）现排一份，跟此刻线上 /api/schedule 给的一模一样
function currentTimeline(ptr, td) {
  const tl = kvGet("timeline");
  if (tl?.current) return tl;
  const seed = kvGet(`seed:${ptr.version}`);
  if (!seed) return null;
  return { current: { version: ptr.version, ...buildSchedule(applyTakedown(seed.items, td), seed.anchorMs ?? seed.anchor ?? 0) }, next: null, switchAt: null };
}
// 规划并写入时间线；不行就退出（线上不动）
function writeTimeline(tl, opts, why, dry = false) {
  const now = Date.now();
  const plan = planTimeline(tl, now, opts);
  if (!plan.ok) { console.log(`时间线不动：${plan.reason}`); process.exit(1); }
  const t = plan.timeline;
  if (!dry) kvPutJson("timeline", { ...t, updatedAt: new Date().toISOString(), why });
  const n = t.next || t.current;
  console.log(t.next
    ? `时间线：${n.items.length} 条，${fmt(t.switchAt)} 在条目边界切换（离现在 ${Math.round((t.switchAt - now) / 1000)} 秒），之前继续播原来的`
    : `时间线：${n.items.length} 条，立刻生效（${fmt(now)}）`);
  return t;
}
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
  const td = kvGet("takedown");
  const tl = currentTimeline(ptr, td);
  writeTimeline(tl, { version: v, items: applyTakedown(readSeed(v).items, td), mode: "fresh" }, `use ${v}`);
  kvPutJson("pointer", { ...ptr, version: v, previous: ptr.version || null, commit: guard.commit, previousCommit: ptr.commit || null, switchedAt: new Date().toISOString(), rolledBack: false });
  console.log(`线上指针：${ptr.version} → ${v}（上一版 ${ptr.version} 保留，可回滚）。`);
} else if (cmd === "rollback") {
  const ptr = kvGet("pointer") || {};
  const plan = planRollback(ptr, (x) => !!kvGet(`seed:${x}`));
  if (!plan.ok) { console.log(`不回滚：${plan.reason}`); process.exit(1); }
  if (process.argv.includes("--dry-run")) { console.log(`（dry-run）会回滚：${ptr.version} → ${plan.to}`); process.exit(0); }
  const td = kvGet("takedown");
  writeTimeline(currentTimeline(ptr, td), { version: plan.to, items: applyTakedown(kvGet(`seed:${plan.to}`).items, td), mode: "fresh" }, `rollback → ${plan.to}`);
  kvPutJson("pointer", { ...ptr, version: plan.to, previous: ptr.version, commit: ptr.previousCommit || null, previousCommit: ptr.commit || null, switchedAt: new Date().toISOString(), rolledBack: true });
  console.log(`已回滚：${ptr.version} → ${plan.to}。不用重新部署。`);
} else if (cmd === "timeline") {
  const tl = kvGet("timeline");
  if (!tl) { console.log("KV 里还没有时间线（Worker 按指针 + seed 现排）"); process.exit(0); }
  const e = effective(tl, Date.now());
  console.log(`current：${e.current.version} ${e.current.items.length} 条，anchor ${fmt(e.current.anchor)}`);
  if (e.next) console.log(`next：${e.next.version} ${e.next.items.length} 条，${fmt(e.switchAt)} 切换`);
  console.log(`更新于 ${tl.updatedAt || "?"}（${tl.why || ""}）`);
} else if (cmd === "pipeline") {
  // 定时流水线的状态（src/pipeline.js）：上一轮做了什么、在途 / 待上线 / 丢弃的条目、今天的合成额度
  const idx = kvGet("pipe:index") || {};
  const d = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
  console.log(JSON.stringify({ last: idx.last, pending: idx.pending, ready: idx.ready, dropped: (idx.dropped || []).slice(-5), daily: idx.daily, ttscap: kvGet(`ttscap:${d}`), error: kvGet("pipe:error") }, null, 1));
  for (const id of [...(idx.pending || []), ...(idx.ready || [])].concat(v ? [v] : [])) {
    const st = kvGet(`pipe:item:${id}`);
    if (st) console.log(`\n${id}：${st.status} @${st.step} ${st.why || ""}\n  ${JSON.stringify({ kind: st.results?.brief?.kind, lines: st.results?.script?.lines, audio: st.results?.tts?.audio, duration: st.results?.tts?.duration, image: st.results?.tts?.image, errors: st.errors })}`);
  }
} else if (cmd === "timeline-init") {
  const ptr = kvGet("pointer") || {};
  if (kvGet("timeline") && !process.argv.includes("--force")) { console.log("已经有时间线了（--force 覆盖）"); process.exit(1); }
  const seed = kvGet(`seed:${ptr.version}`);
  const cur = { version: ptr.version, ...buildSchedule(applyTakedown(seed.items, kvGet("takedown")), seed.anchorMs ?? seed.anchor ?? 0) };
  kvPutJson("timeline", { current: cur, next: null, switchAt: null, updatedAt: new Date().toISOString(), why: "timeline-init" });
  console.log(`时间线初始化：${ptr.version} ${cur.items.length} 条，anchor 不变（${fmt(cur.anchor)}），播放位置不变`);
} else if (cmd === "takedown-migrate") {
  const td = kvGet("takedown");
  const next = { ...migrateTakedown(td), updatedAt: new Date().toISOString(), migratedFrom: td?.ids ? "ids" : undefined };
  kvPutJson("takedown", next);
  console.log(`下架名单已迁移：hash ${next.hashes.join(", ") || "无"}；旧地址 ${next.audio.length} 个`);
} else if (cmd === "takedown" || cmd === "untakedown") {
  if (!v) { console.log(`用法：node scripts/release.mjs ${cmd} <条目 id | 稿子 hash>`); process.exit(2); }
  const ptr = kvGet("pointer") || {};
  const td = kvGet("takedown");
  const isHashArg = /^[0-9a-f]{16}$/.test(v);
  if (cmd === "untakedown") {
    const t = migrateTakedown(td);
    const keys = isHashArg ? [v] : Object.entries(t.refs).filter(([, id]) => id === v).map(([k]) => k);
    if (!keys.length) { console.log(`下架名单里没有 ${v}`); process.exit(1); }
    let next = t;
    for (const k of keys) next = removeTakedown(next, /^[0-9a-f]{16}$/.test(k) ? { hash: k } : { audio: k });
    kvPutJson("takedown", next);
    console.log(`已撤销下架：${keys.join(", ")}（作废的版本保持作废）`); process.exit(0);
  }
  // 解析成「线上版本里这条现在的稿子」
  let entry;
  if (isHashArg) entry = { hash: v };
  else {
    const live = kvGet(`seed:${ptr.version}`);
    const it = live?.items?.find((x) => x.id === v);
    if (!it) {
      const seen = [];
      for (const d of localVersions()) for (const x of readSeed(d).items) if (x.id === v) seen.push(`${d}: ${scriptHashOf(x) || x.audio}`);
      console.log(`线上版本 ${ptr.version} 里没有 ${v}。要下架某一版稿子请直接给 hash：\n  ${seen.join("\n  ") || "（本地版本里也没有）"}`);
      process.exit(1);
    }
    const h = scriptHashOf(it);
    entry = h ? { hash: h, id: v } : { audio: it.audio, id: v };
  }
  // 先排时间线：普通下架在 switchAt（条目边界）生效，--now 立刻生效
  const now = process.argv.includes("--now");
  const tl = currentTimeline(ptr, td);
  const only0 = addTakedown(null, entry);
  let effAt = Date.now();
  if (tl) {
    const e = effective(tl, Date.now());
    const target = e.next || e.current;
    if (target.items.some((it) => takedownMatches(only0, it))) {
      const t = writeTimeline(tl, { version: target.version, items: target.items.filter((it) => !takedownMatches(only0, it)), mode: "continue", emergency: now }, `takedown ${entry.hash || entry.audio}${now ? " --now" : ""}`);
      effAt = t.switchAt ?? Date.now();
    } else console.log("时间线里没有这版稿子，时间线不动");
  }
  const next = addTakedown(td, { ...entry, effectiveAt: effAt });
  kvPutJson("takedown", next);
  // 含这版稿子的版本全部作废：本地 releases/ 和 KV 里线上 / 上一版的 seed 都查
  const only = addTakedown(null, entry);
  const affected = new Set();
  for (const d of localVersions()) if (readSeed(d).items.some((it) => takedownMatches(only, it))) affected.add(d);
  for (const x of [ptr.version, ptr.previous].filter(Boolean)) if (kvGet(`seed:${x}`)?.items?.some((it) => takedownMatches(only, it))) affected.add(x);
  if (affected.size) kvPutJson("pointer", markVoid(kvGet("pointer") || ptr, [...affected], `含已下架稿子 ${entry.hash || entry.audio}${entry.id ? `（${entry.id}）` : ""}`));
  console.log(`已下架稿子 ${entry.hash || entry.audio}${entry.id ? `（${entry.id}）` : ""}；作废版本：${[...affected].join(", ") || "无"}。${now ? "紧急：立刻生效" : `${fmt(effAt)} 在条目边界生效`}。`);
} else {
  console.log("用法：node scripts/release.mjs list | check <v> | publish <v> | use <v> | rollback [--dry-run] | takedown <id|hash> [--now] | timeline | timeline-init | pipeline [id] | untakedown <id|hash> | takedown-migrate"); process.exit(2);
}
