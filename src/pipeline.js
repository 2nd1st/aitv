// 定时流水线（Worker cron）：每条一个状态机，每一步的结果都存进 KV，挂了下一轮从断点接着跑。
//   fetch/去重 → read（读原文）→ brief（deepseek-chat）→ script（deepseek-v4-pro）→ validate → tts（豆包 → R2）→ ready
// KV：
//   "pipe:item:<id>" → { id, item, step, status, results: { read, brief, script, validate, tts }, tries, errors, ... }
//   "pipe:index"     → { pending: [id], ready: [id], dropped: [{id, step, why, at}], seen: [id], daily: { date, started }, last }
//   "pipe:lock"      → { until }  同一时刻只跑一个
//   "ttscap:<日期>"  → 每日合成额度（src/ttscap.js）：一天 40 次，同一条一天最多 2 次（= 一次重试）
// 上线（插进时间线）默认关闭：AUTO_PUBLISH 不是 "1" 时只记一份「如果上线会怎么插」的计划。
// 下架按稿子 hash：同一个 id 写出不一样的稿子照常能过；只有稿子 hash 在名单里才丢。
import { fetchAll, dedupe, interleave } from "./sources.js";
import { fetchMaterial, enrich } from "./enrich.js";
import { writeScript, toSeedItem, needsTitleZh, translateTitle, PART_KEYS, checkScript, scriptFields, opening } from "./writer.js";
import { checkSafety } from "./safety.js";
import { scriptHash, SPEAKERS, AUDIO_CONFIG } from "./scripthash.js";
import { takedownMatches, checkSeed, MIN_PLAYABLE } from "./release.js";
import { reserveTTS } from "./ttscap.js";
import { storeScreenedImage } from "./imagepick.js";
import { mp3Duration } from "./mp3.js";
import { planTimeline, effective, fresh, locate } from "./timeline.js";

export const STEPS = ["read", "brief", "script", "validate", "tts"];
export const MAX_STEP_TRIES = 3; // 网络 / 模型这类临时错误：同一步最多跑 3 次（跨轮）
const SEEN_MAX = 2000;
const day = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");

class Drop extends Error {}   // 内容不合格：直接丢，不重试
class Wait extends Error {}   // 今天额度用完 / 这条今天试够了：明天再来

// ---------- 每一步 ----------
const step = {
  async read(st, d) {
    const m = await fetchMaterial(st.item, { fetchImpl: d.fetch });
    if (!m) throw new Error("原文读不到");
    return m; // { url, text, image }（原文只存在流水线自己的 KV 里，不进 seed / 节目单）
  },
  async brief(st, d) {
    const e = await enrich(st.item, { llm: (p) => d.briefLLM(p, { temperature: 0.3 }), retries: 1, material: st.results.read });
    if (e.brief) return { kind: e.kind, brief: e.brief, fields: e.fields, image: e.image ?? null, imageHint: e.imageHint ?? null };
    if (e.unsafe || !/模型出错/.test(e.briefError || "")) throw new Drop(e.briefError || "brief 不合格");
    throw new Error(e.briefError);
  },
  async script(st, d) {
    const it = { ...st.item, ...st.results.brief };
    const s = await writeScript(it, { llm: d.scriptLLM, prevTake: d.prevTake || "" });
    if (s.error) { if (/模型出错/.test(s.error)) throw new Error(s.error); throw new Drop(s.error); }
    const fields = { ...it.fields };
    if (needsTitleZh(it)) { const zh = await translateTitle(it, { llm: (p) => d.briefLLM(p, { temperature: 0.2 }) }); if (zh) fields.title_zh = zh; }
    return { kind: s.kind, parts: s.parts, lines: s.lines, fields };
  },
  async validate(st, d) {
    const b = st.results.brief, s = st.results.script;
    const it = { ...st.item, ...b, fields: s.fields };
    const chk = checkScript(s.parts, scriptFields(it), { kind: b.kind, source: it.source });
    if (!chk.ok) throw new Drop(`复核不过：${chk.errors.join("；")}`);
    const safe = checkSafety(it, b.brief);
    if (!safe.ok) throw new Drop(`内容安全：${safe.reasons.join("；")}`);
    const hash = await scriptHash(s.lines);
    if (takedownMatches(d.takedown, { audio: `/audio/${hash}.mp3` })) throw new Drop(`稿子 ${hash} 在下架名单里`);
    return { hash, ok: true };
  },
  async tts(st, d) {
    const { hash } = st.results.validate, lines = st.results.script.lines;
    const mp3Key = `${hash}.mp3`, metaKey = `${hash}.json`;
    let bytes, rounds, cached = false;
    const [hm, hj] = await Promise.all([d.r2.head(mp3Key), d.r2.head(metaKey)]);
    if (hm && hj) { // 内容寻址：同一份稿子已经合成过，不再调豆包、不占额度
      bytes = new Uint8Array(await (await d.r2.get(mp3Key)).arrayBuffer());
      rounds = await (await d.r2.get(metaKey)).json();
      cached = true;
    } else {
      const r = await reserveTTS(d.kv, st.id, { now: d.now, cap: d.ttsCap });
      if (!r.ok) throw new Wait(r.reason);
      const payload = { action: 3, use_head_music: false, audio_config: AUDIO_CONFIG,
        nlp_texts: lines.map((text, j) => ({ speaker: SPEAKERS[j % 2], text })) };
      const out = await d.tts(payload); // 失败抛错：这一次也算额度（防故障时无限烧钱）
      bytes = out.audio; rounds = out.rounds.map((x) => ({ text: x.text, start_time: x.start_time, end_time: x.end_time }));
      if (!(mp3Duration(bytes) > 0)) throw new Error("合成结果没有音频");
      await d.r2.put(mp3Key, bytes, { httpMetadata: { contentType: "audio/mpeg", cacheControl: "public, max-age=31536000, immutable" } });
      await d.r2.put(metaKey, JSON.stringify(rounds), { httpMetadata: { contentType: "application/json" } });
    }
    const dur = mp3Duration(bytes);
    if (!(dur > 0)) throw new Error("音频时长为 0");
    // 配图：补料时已按地址筛过，这里经 storeImage 下载并按真实字节再筛一次（尺寸、画面太素），不合格就没图
    const img = st.results.brief.image
      ? await storeScreenedImage(d.r2img || d.r2, st.results.brief.image, itemOf(st).url, { fetch: d.fetch, hint: st.results.brief.imageHint || {} })
      : { image: null, reason: "" };
    return { audio: `/audio/${mp3Key}`, duration: Math.round((dur + 0.6) * 1000) / 1000, rounds: tagParts(rounds, lines), image: img.image, imageNote: img.reason, cached, bytes: bytes.length };
  },
};

// 每句 round 标上属于哪段（what / who / take），跟 scripts/tts_seed.py 的 tag_parts 一样
export function tagParts(rounds, lines) {
  if (rounds.length === lines.length) return rounds.map((r, i) => ({ ...r, part: PART_KEYS[i] }));
  const bounds = []; let acc = 0;
  for (const l of lines) { acc += l.length; bounds.push(acc); }
  let pos = 0;
  return rounds.map((r) => {
    const mid = pos + r.text.length / 2;
    let i = bounds.findIndex((b) => mid <= b); if (i < 0) i = bounds.length - 1;
    pos += r.text.length;
    return { ...r, part: PART_KEYS[Math.min(i, 2)] };
  });
}

// 全部步骤跑完 → 节目单条目（字段白名单）；再用发布时同一套 checkSeed 单条校验
// 读原文那步可能改了 item（AIHOT：原文发布时间、旧链接退回 links.aihot）
const itemOf = (st) => ({ ...st.item, ...(st.results?.read?.patch || {}) });
export function seedItemOf(st) {
  const b = st.results.brief, s = st.results.script, t = st.results.tts;
  const it = toSeedItem({ ...itemOf(st), kind: s.kind, brief: b.brief, fields: s.fields, image: t.image, take: s.lines[2],
    script: s.parts.map((tpl, i) => ({ part: PART_KEYS[i], tpl, text: s.lines[i] })), lines: s.lines });
  delete it.lines; // 跟 scripts/tts_seed.py 出的 seed 一样，不带 lines
  return { ...it, audio: t.audio, duration: t.duration, spoken: s.lines.join(""), rounds: t.rounds };
}
export function validateItem(it, bytes = 2000) {
  return checkSeed({ version: "x", items: [it] }, "x", { audioBytes: () => bytes, minPlayable: 0 });
}

// 推进一条：从 st.step 往后跑，每步存一次。返回新的 st（status: pending | ready | dropped | waiting）
export async function advance(st, d, { save, deadline = Infinity } = {}) {
  st = { ...st, results: { ...st.results }, tries: { ...st.tries }, errors: [...(st.errors || [])] };
  while (st.status === "pending" || st.status === "waiting") {
    if (Date.now() > deadline) break;
    const name = st.step;
    if (name === "done") break;
    st.tries[name] = (st.tries[name] || 0) + 1;
    let later = false;
    try {
      st.results[name] = await step[name](st, d);
      st.step = STEPS[STEPS.indexOf(name) + 1] || "done";
      st.status = "pending"; delete st.why;
      if (st.step === "done") {
        const item = seedItemOf(st);
        const v = validateItem(item, st.results.tts.bytes);
        if (!v.ok) { st.status = "dropped"; st.why = `单条校验不过：${v.errors.join("；")}`; }
        else { st.status = "ready"; st.seedItem = item; }
      }
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      st.errors.push({ step: name, at: d.now, msg });
      if (e instanceof Drop) { st.status = "dropped"; st.why = msg; }
      else if (e instanceof Wait) { st.status = "waiting"; st.why = msg; st.tries[name]--; }
      // 合成失败：每日额度管重试（同一条一天最多两次）；累计失败 4 次（两天）就丢
      else if (name === "tts") { const n = st.errors.filter((x) => x.step === "tts" && !/额度|试过/.test(x.msg)).length; st.status = n >= 4 ? "dropped" : "waiting"; st.why = `合成失败：${msg}`; }
      else if (st.tries[name] >= MAX_STEP_TRIES) { st.status = "dropped"; st.why = `${name} 连续 ${st.tries[name]} 次出错：${msg}`; }
      else { st.why = msg; later = true; } // 临时错误：等下一轮再跑这一步
    }
    st.updatedAt = d.now;
    if (save) await save(st);
    if (st.status !== "pending" || later) break;
  }
  return st;
}

// ---------- 上线（插进时间线），AUTO_PUBLISH 才真写 ----------
// 新条目插在「当前在播的那条」后面（switchAt 机制）；超过 6 小时的条目下线，但不会让节目单少于 MIN_PLAYABLE 条。
export function dropOld(items, now, { min = MIN_PLAYABLE, maxAge } = {}) {
  const keep = new Set(fresh(items, now, maxAge).map((x) => `${x.id}|${x.audio}`));
  const old = items.filter((x) => !keep.has(`${x.id}|${x.audio}`)).sort((a, b) => (a.fetchedAt ?? 0) - (b.fetchedAt ?? 0));
  const allowed = Math.max(0, items.length - min);
  const gone = new Set(old.slice(0, allowed).map((x) => `${x.id}|${x.audio}`));
  return items.filter((x) => !gone.has(`${x.id}|${x.audio}`));
}
export function planInsert(tl, now, item, { min = MIN_PLAYABLE, takedown } = {}) {
  const eff = effective(tl, now);
  if (!eff) return { ok: false, reason: "KV 里没有时间线" };
  const v = validateItem(item);
  if (!v.ok) return { ok: false, reason: `条目没通过校验：${v.errors.join("；")}` };
  if (takedownMatches(takedown, item)) return { ok: false, reason: "稿子在下架名单里" };
  const target = eff.next || eff.current;
  const items = dropOld(target.items.filter((x) => x.id !== item.id), now, { min });
  if (items.length + 1 < min) return { ok: false, reason: `插入后只有 ${items.length + 1} 条，少于 ${min}` };
  const p = planTimeline(tl, now, { version: target.version, items, insert: [item] });
  if (!p.ok) return p;
  // 点评开头不能跟前后两条撞
  const n = p.timeline.next || p.timeline.current, at = p.timeline.switchAt ?? now;
  const before = eff.current.items[(locate(eff.current, at - 1).i)];
  const after = n.items[1];
  for (const nb of [before, after]) if (nb?.take && opening(nb.take) === opening(item.take)) return { ok: false, reason: `点评开头跟相邻的 ${nb.id} 撞了` };
  return { ...p, dropped: target.items.length - items.length - (target.items.some((x) => x.id === item.id) ? 1 : 0) };
}

// ---------- 一轮 cron ----------
// d：依赖（Worker 里由 makeDeps(env) 组装；测试里全是假的）
export async function runCron(d, { maxNewPerDay = 1, autoPublish = false, budgetMs = 12 * 60_000 } = {}) {
  const now = d.now, kv = d.kv, deadline = Date.now() + budgetMs;
  const lock = await kv.get("pipe:lock");
  if (lock?.until > now) return { skipped: "上一轮还在跑" };
  await kv.put("pipe:lock", { until: now + budgetMs + 60_000 }, { expirationTtl: Math.ceil(budgetMs / 1000) + 120 });
  const log = [];
  try {
    const idx = { pending: [], ready: [], dropped: [], seen: [], ...(await kv.get("pipe:index")) };
    if (idx.daily?.date !== day(now)) idx.daily = { date: day(now), started: 0 };
    const tl = await kv.get("timeline");
    const eff = effective(tl, now);
    d.takedown = await kv.get("takedown");
    d.prevTake = eff ? eff.current.items[locate(eff.current, now).i]?.take : "";

    // 1. 抓 + 去重：没有在途的、今天还有名额才开新条
    if (!idx.pending.length && idx.daily.started < maxNewPerDay) {
      const r = await fetchAll({ fetchImpl: d.fetch, now });
      const onAir = new Set([...(eff?.current.items || []), ...(eff?.next?.items || [])].map((x) => x.id));
      const cands = interleave(dedupe(r.items, new Set([...idx.seen, ...onAir])));
      const pick = cands.find((c) => checkSafety(c).ok);
      log.push(`抓到 ${r.items.length} 条，新候选 ${cands.length}${Object.keys(r.errors).length ? `，失败源 ${JSON.stringify(r.errors)}` : ""}`);
      if (pick) {
        const st = { id: pick.id, item: pick, step: "read", status: "pending", results: {}, tries: {}, errors: [], createdAt: now, updatedAt: now };
        await kv.put(`pipe:item:${pick.id}`, st);
        idx.pending.push(pick.id); idx.daily.started++;
        log.push(`新条目 ${pick.id}`);
      }
      // 标记看过（只用来不重复处理同一条新闻；下架不按 id，按稿子 hash）
      idx.seen = [...new Set([...idx.seen, ...(pick ? [pick.id] : [])])].slice(-SEEN_MAX);
    }
    // 2. 推进在途的
    for (const id of [...idx.pending]) {
      let st = await kv.get(`pipe:item:${id}`);
      if (!st) { idx.pending = idx.pending.filter((x) => x !== id); continue; }
      if (st.status === "waiting") st.status = "pending"; // 新的一轮（可能是新的一天）再试
      st = await advance(st, { ...d }, { save: (s) => kv.put(`pipe:item:${id}`, s), deadline });
      log.push(`${id}：${st.status} @${st.step}${st.why ? `（${st.why}）` : ""}`);
      if (st.status === "ready") { idx.pending = idx.pending.filter((x) => x !== id); idx.ready.push(id); }
      if (st.status === "dropped") { idx.pending = idx.pending.filter((x) => x !== id); idx.dropped = [...idx.dropped, { id, step: st.step, why: st.why, at: now }].slice(-200); }
    }
    // 3. 上线：最多插一条
    let plan = null;
    const readyId = idx.ready[0];
    if (readyId) {
      const st = await kv.get(`pipe:item:${readyId}`);
      let p = planInsert(tl, now, st.seedItem, { takedown: d.takedown });
      if (p.ok && !(await d.r2.head(st.seedItem.audio.replace(/^\/audio\//, "")))) p = { ok: false, reason: "R2 里没有这条的音频" };
      plan = p.ok ? { id: readyId, switchAt: p.timeline.switchAt, count: (p.timeline.next || p.timeline.current).items.length, droppedOld: p.dropped } : { id: readyId, refused: p.reason };
      if (p.ok && autoPublish) {
        await kv.put("timeline", { ...p.timeline, updatedAt: new Date(now).toISOString(), why: `cron insert ${readyId}` });
        idx.ready = idx.ready.slice(1);
        st.status = "published"; st.publishedAt = now; await kv.put(`pipe:item:${readyId}`, st);
        log.push(`已插入时间线，${new Date(p.timeline.switchAt).toISOString()} 生效`);
      } else log.push(autoPublish ? `不插：${p.reason}` : `自动上线关闭；如果打开：${p.ok ? `会在 switchAt ${new Date(p.timeline.switchAt).toISOString()} 插入，节目单 ${plan.count} 条` : `不会插：${p.reason}`}`);
    }
    idx.last = { at: now, log, plan, autoPublish };
    await kv.put("pipe:index", idx);
    return idx.last;
  } finally {
    await kv.delete?.("pipe:lock");
  }
}
