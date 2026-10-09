// 版本化发布（架构师的发布纪律）：
// - 每批节目单独成一个版本：public/seeds/<version>/seed.json + public/seeds/<version>/audio/*.mp3
// - 线上指针 public/current.json = { version, previous }；切换只改这一个文件（再部署），上一版原样保留，随时回滚。
// - 新版本必须整批校验通过、且可播条目 >= MIN_PLAYABLE 才允许切过去；不够就保留旧版。
import { KINDS } from "./enrich.js";

export const MIN_PLAYABLE = 15;
export const PARTS = ["what", "who", "take"];
export const VERSION_RE = /^\d{8}-\d{4,6}$/;

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
    const hasAudio = !!it.audio && it.audio.startsWith(`/seeds/${version}/audio/`) && audioBytes(it.audio) > 1000 && it.duration > 0;
    if (hasAudio) audioOk++;
    else e.push("音频缺失、不在本版本目录或没有时长");
    if (!KINDS.includes(it.kind) || it.brief?.kind !== it.kind) e.push("kind 缺失或跟 brief 不一致");
    if (!it.brief?.what || !it.brief?.who) e.push("没有 brief");
    if (!it.take) e.push("没有 take");
    if (!Array.isArray(it.script) || it.script.length !== 3) e.push("script 不是三段");
    const parts = new Set((it.rounds || []).map((r) => r.part));
    if (!PARTS.every((p) => parts.has(p))) e.push("rounds 没把 what/who/take 都标上");
    if ("materialText" in it || "material" in it || dump.includes("materialText")) e.push("带了原文");
    if (it.source === "Product Hunt" && "rank" in (it.fields || {})) e.push("Product Hunt 不许有 rank");
    if (e.length) errors.push(`${it.id}：${e.join("，")}`);
    else playable++;
  }
  if (playable < minPlayable) errors.push(`可播条目 ${playable} 条，少于 ${minPlayable} 条，不切换`);
  // audioOk：只看能不能播（回滚到旧版时用）；playable：内容也全部合格
  return { ok: errors.length === 0, playable, audioOk, errors };
}
