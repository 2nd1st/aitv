// 版本化发布（架构师的发布纪律）：
// - 每批节目单独成一个版本：本地 releases/<version>/seed.json；seed 在 KV 的 seed:<version>。
// - 音频按内容寻址：R2 key <hash>.mp3（hash = sha256(音色 + 参数 + 口播稿) 前 16 位），对外 /audio/<hash>.mp3，支持 Range。
//   同样的稿子不重复合成，跨版本共用；本地在 audio-cache/。早期两个版本用的是 /audio/<version>/<file>.mp3，照样认。
// - 线上指针是 KV 的 pointer = { version, previous }；切换 / 回滚只改这一个 key，上一版原样保留。
// - 新版本必须整批校验通过、且可播条目 >= MIN_PLAYABLE 才允许切过去；不够就保留旧版。
import { KINDS } from "./enrich.js";

export const MIN_PLAYABLE = 15;
export const PARTS = ["what", "who", "take"];
export const VERSION_RE = /^\d{8}-\d{4,6}$/;
export const HASH_AUDIO_RE = /^\/audio\/[0-9a-f]{16}\.mp3$/;
export const audioPathOk = (audio, version) => typeof audio === "string" && (HASH_AUDIO_RE.test(audio) || audio.startsWith(`/audio/${version}/`));

// 东八区时间做版本号：20261009-1130
export function makeVersion(ms = Date.now()) {
  const d = new Date(ms + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

// 逐条检查；audioBytes(path) 返回文件字节数（不存在返回 0），由调用方注入，便于测试
export function checkSeed(seed, version, { audioBytes, minPlayable = MIN_PLAYABLE } = {}) {
  const errors = [];
  if (!seed || !Array.isArray(seed.items)) return { ok: false, playable: 0, errors: ["seed.json 结构不对"] };
  if (seed.version !== version) errors.push(`seed.version=${seed.version}，跟目录 ${version} 不一致`);
  let playable = 0, audioOk = 0;
  for (const it of seed.items) {
    const e = [];
    const dump = JSON.stringify(it);
    const hasAudio = audioPathOk(it.audio, version) && audioBytes(it.audio) > 1000 && it.duration > 0;
    if (hasAudio) audioOk++;
    else e.push("音频缺失、地址不对或没有时长");
    if (!KINDS.includes(it.kind) || it.brief?.kind !== it.kind) e.push("kind 缺失或跟 brief 不一致");
    if (!it.brief?.what || !it.brief?.who) e.push("没有 brief");
    if (!it.take) e.push("没有 take");
    if (!Array.isArray(it.script) || it.script.length !== 3) e.push("script 不是三段");
    const parts = new Set((it.rounds || []).map((r) => r.part));
    if (!PARTS.every((p) => parts.has(p))) e.push("rounds 没把 what/who/take 都标上");
    if ("materialText" in it || "material" in it || dump.includes("materialText")) e.push("带了原文");
    if (it.source === "Product Hunt" && "rank" in (it.fields || {})) e.push("Product Hunt 不许有 rank");
    if (it.image != null && !/^\/img\/[0-9a-f]{16}\.(jpg|png|webp)$/.test(String(it.image))) e.push("image 只能是自家 /img/<key>，不许是第三方地址");
    if (e.length) errors.push(`${it.id}：${e.join("，")}`);
    else playable++;
  }
  if (playable < minPlayable) errors.push(`可播条目 ${playable} 条，少于 ${minPlayable} 条，不切换`);
  // audioOk：只看能不能播（回滚到旧版时用）；playable：内容也全部合格
  return { ok: errors.length === 0, playable, audioOk, errors };
}

// ---------- 下架（takedown）与作废（void） ----------
// 下架的是「某一版口播稿」，不是条目 id（乔布斯：同一条改写成合适的稿子以后可以重新上）。
// KV "takedown" = { hashes: [稿子 hash], audio: [旧版按版本目录的音频地址], refs: { <hash 或地址>: 条目 id（仅供查阅）}, updatedAt }
// 稿子 hash 跟音频文件名同一个依据（src/scripthash.js：sha256(音色 + 参数 + 稿子) 前 16 位），所以内容寻址的音频地址里就带着它；
// 早期两个版本的音频不是内容寻址，按音频地址拦（地址本身也是一版稿子一个）。
// /api/schedule 每次读都按它过滤并连续重排；同一个 id 换了新稿子（hash 变了）照常播。
export const scriptHashOf = (it) => (/^\/audio\/([0-9a-f]{16})\.mp3$/.exec(String(it?.audio || "")) || [])[1] || null;
const HASH_RE = /^[0-9a-f]{16}$/;

// 旧格式 { ids, audio } → 新格式：id 不再用来拦；内容寻址的音频地址转成 hash，其余地址照旧
export function migrateTakedown(td) {
  if (!td) return { hashes: [], audio: [], refs: {} };
  const hashes = new Set(td.hashes || []), audio = new Set(), refs = { ...(td.refs || {}) };
  const oldId = Array.isArray(td.ids) && td.ids.length === 1 ? td.ids[0] : null;
  for (const a of td.audio || []) {
    const h = scriptHashOf({ audio: a });
    if (h) { hashes.add(h); if (oldId && !refs[h]) refs[h] = oldId; }
    else { audio.add(a); if (oldId && !refs[a]) refs[a] = oldId; }
  }
  return { hashes: [...hashes], audio: [...audio], refs, ...(td.updatedAt ? { updatedAt: td.updatedAt } : {}) };
}
export function takedownMatches(td, it) {
  if (!td || !it) return false;
  const t = td.ids ? migrateTakedown(td) : td;
  const h = scriptHashOf(it);
  return (!!h && (t.hashes || []).includes(h)) || (!!it.audio && (t.audio || []).includes(it.audio));
}
export function applyTakedown(items, td) {
  return (items || []).filter((it) => !takedownMatches(td, it));
}
// entry：{ hash } 或 { audio }（旧版地址），id 只记在 refs 里
export function addTakedown(td, { hash, audio, id } = {}) {
  const t = migrateTakedown(td);
  const hashes = new Set(t.hashes), aud = new Set(t.audio), refs = { ...t.refs };
  if (hash) { if (!HASH_RE.test(hash)) throw new Error(`不是稿子 hash：${hash}`); hashes.add(hash); if (id) refs[hash] = id; }
  if (audio) { const h = scriptHashOf({ audio }); if (h) { hashes.add(h); if (id) refs[h] = id; } else { aud.add(audio); if (id) refs[audio] = id; } }
  return { hashes: [...hashes], audio: [...aud], refs, updatedAt: new Date().toISOString() };
}
export function removeTakedown(td, { hash, audio } = {}) {
  const t = migrateTakedown(td);
  const refs = { ...t.refs }; delete refs[hash]; delete refs[audio];
  return { hashes: t.hashes.filter((x) => x !== hash), audio: t.audio.filter((a) => a !== audio), refs, updatedAt: new Date().toISOString() };
}
// 作废的版本记在指针元数据 pointer.void 里：use / rollback 都拒绝切到作废版本（第二道保险）。
export const isVoid = (ptr, v) => Array.isArray(ptr?.void) && ptr.void.includes(v);
export function markVoid(ptr, versions, reason) {
  const set = new Set(ptr?.void || []);
  const reasons = { ...(ptr?.voidReasons || {}) };
  for (const v of versions) { set.add(v); if (reason && !reasons[v]) reasons[v] = reason; }
  return { ...(ptr || {}), void: [...set].sort(), voidReasons: reasons };
}
// 回滚要切到哪儿：返回 { ok, to, reason }（纯函数，dry-run 和测试都用它）
export function planRollback(ptr, hasSeed = () => true) {
  if (!ptr?.previous) return { ok: false, reason: "没有上一版" };
  if (isVoid(ptr, ptr.previous)) return { ok: false, to: ptr.previous, reason: `上一版 ${ptr.previous} 已作废（${ptr.voidReasons?.[ptr.previous] || "void"}），拒绝回滚` };
  if (!hasSeed(ptr.previous)) return { ok: false, to: ptr.previous, reason: `KV 里没有 seed:${ptr.previous}` };
  return { ok: true, to: ptr.previous };
}
