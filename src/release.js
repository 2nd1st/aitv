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
// KV "takedown" = { ids: [条目 id], audio: [音频地址], updatedAt }。/api/schedule 每次读都按它过滤，
// 并重新连续排开始时间（无空档，总长变短）——所以不管哪个版本在线上（包括回滚到的旧版），被下架的条目都不会播。
export function takedownMatches(td, it) {
  if (!td || !it) return false;
  return (Array.isArray(td.ids) && td.ids.includes(it.id)) || (Array.isArray(td.audio) && !!it.audio && td.audio.includes(it.audio));
}
export function applyTakedown(items, td) {
  return (items || []).filter((it) => !takedownMatches(td, it));
}
export function addTakedown(td, id, audios = []) {
  const ids = new Set(td?.ids || []), audio = new Set(td?.audio || []);
  ids.add(id); for (const a of audios) if (a) audio.add(a);
  return { ids: [...ids], audio: [...audio], updatedAt: new Date().toISOString() };
}
export function removeTakedown(td, id, audios = []) {
  const drop = new Set(audios);
  return { ids: (td?.ids || []).filter((x) => x !== id), audio: (td?.audio || []).filter((a) => !drop.has(a)), updatedAt: new Date().toISOString() };
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
