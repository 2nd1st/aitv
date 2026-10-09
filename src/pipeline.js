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
import { renderScript } from "./validate.js";
import { checkSafety } from "./safety.js";
import { scriptHash, SPEAKERS, AUDIO_CONFIG } from "./scripthash.js";
import { takedownMatches, checkSeed, MIN_PLAYABLE } from "./release.js";
import { reserveTTS } from "./ttscap.js";
import { storeScreenedImage } from "./imagepick.js";
import { mp3Duration } from "./mp3.js";
import { planTimeline, effective, locate } from "./timeline.js";

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
    // 发布时间读不到（AIHOT 原文没日期、或原文是旧链接退回了 links.aihot）：不播，不拿抓取时间顶替
    if (m.patch?.dateUnknown || (st.item.dateUnknown && m.patch?.publishedAt == null)) throw new Drop("发布时间读不到，不播");
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
// 规则（乔布斯 2026-10-09 签）：
// - 每轮最多上一条新的；点评开头跟前后撞了就改写点评第一句（一条一天一次，改了要重新校验、重新合成、占额度）。
// - 超过 6 小时的下线；不足 15 条时用 6–12 小时的旧条目补到 15（越新越先），超过 12 小时的一律下线，哪怕不足 15 条。
//   15 条的门槛和兜底永远不挡新条目上线。全都不合格时保留最新的那一批在播条目，不出空节目单。
// - use / rollback 之后（时间线里少了我们上过的条目），下一轮把 6 小时内、没下架的已完成条目全部插回来，
//   音频按 hash 已在 R2，不再合成。全部经 switchAt。
export const FRESH_MS = 6 * 3600_000, FILLER_MAX_MS = 12 * 3600_000;
const ageOf = (it, now) => { const t = it.fetchedAt ?? it.publishedAt; return t == null ? 0 : now - t; };
const keyOf = (x) => `${x.id}|${x.audio}`;
export function dropOld(items, now, { min = MIN_PLAYABLE } = {}) {
  const fresh6 = items.filter((x) => ageOf(x, now) <= FRESH_MS);
  let keep = new Set(fresh6.map(keyOf));
  if (keep.size < min) {
    const filler = items.filter((x) => { const a = ageOf(x, now); return a > FRESH_MS && a <= FILLER_MAX_MS; }).sort((x, y) => ageOf(x, now) - ageOf(y, now));
    for (const f of filler) { if (keep.size >= min) break; keep.add(keyOf(f)); }
  }
  let out = items.filter((x) => keep.has(keyOf(x)));
  let keptStale = false;
  if (!out.length && items.length) { // 边界：全都超过 12 小时 → 留最新的那一批，不出空节目单
    const newest = Math.min(...items.map((x) => ageOf(x, now)));
    out = items.filter((x) => ageOf(x, now) === newest);
    keptStale = true;
  }
  return Object.assign(out, { keptStale });
}

// 点评第一句改写：只改 part3 模板的第一句，开头避开给定的几个开头
export const firstSentence = (s) => { const m = String(s).match(/^[^。！？；]*[。！？；]?/); return m ? m[0] : String(s); };
export async function rewriteTakeOpening(st, d, avoid) {
  const s = st.results.script, b = st.results.brief;
  const tpl = s.parts[2], first = firstSentence(tpl), rest = tpl.slice(first.length);
  const prompt = `下面是一段中文口播点评的第一句（模板，{{…}} 是占位符，原样保留）。把它改写成意思不变、同样口吻的一句，只改说法和开头。
要求：开头的头几个字不能是这些：${avoid.map((x) => `「${x}」`).join("、")}；不要以「如果你」开头；不要出现「今天」；不要新增任何数字（阿拉伯数字或中文数字都不行）；不要加新的事实。
原句：${first}
后文（不用改，只供参考）：${rest}
只输出 JSON：{"first":"…"}`;
  let out;
  try { out = JSON.parse((await d.scriptLLM(prompt, { temperature: 0.8 })).match(/\{[\s\S]*\}/)?.[0] || "null"); } catch { out = null; }
  const nf = typeof out?.first === "string" ? out.first.trim() : "";
  if (!nf) return { ok: false, reason: "改写没给结果" };
  const parts = [s.parts[0], s.parts[1], nf + rest];
  const it = { ...st.item, ...b, fields: s.fields };
  const fields = scriptFields(it);
  const chk = checkScript(parts, fields, { kind: b.kind, source: it.source });
  if (!chk.ok) return { ok: false, reason: `改写后不过：${chk.errors.join("；")}` };
  const lines = parts.map((p) => renderScript(p, s.fields));
  if (avoid.includes(opening(lines[2]))) return { ok: false, reason: "改写后开头还是撞" };
  return { ok: true, script: { ...s, parts, lines } };
}

// 这一轮的上线计划。返回 { ok, timeline, inserted: [id], reinserted: [id], dropped, keptStale } 或 { ok: false, reason }
export function planPublish(tl, now, { newItem = null, reinsert = [], takedown } = {}) {
  const eff = effective(tl, now);
  if (!eff) return { ok: false, reason: "KV 里没有时间线" };
  const target = eff.next || eff.current;
  const insert = [newItem, ...reinsert].filter(Boolean).filter((x) => !takedownMatches(takedown, x));
  const insIds = new Set(insert.map((x) => x.id));
  const base = target.items.filter((x) => !insIds.has(x.id));
  const kept = dropOld(base, now);
  if (!insert.length && kept.length === base.length) return { ok: false, reason: "没有要变的", noop: true };
  // 门槛不挡新条目：新条目 + 留下的，多少条都照排（插进来的不受 6 / 12 小时规则，它们本来就是新的）
  const p = planTimeline(tl, now, { version: target.version, items: kept, insert });
  if (!p.ok) return p;
  const n = p.timeline.next || p.timeline.current, at = p.timeline.switchAt ?? now;
  const before = eff.current.items[locate(eff.current, at - 1).i];
  let clash = null;
  if (newItem && insert[0] === newItem) {
    const after = n.items[1];
    for (const nb of [before, after]) if (nb?.take && nb.id !== newItem.id && opening(nb.take) === opening(newItem.take)) clash = { with: nb.id, avoid: [before?.take, after?.take].filter(Boolean).map(opening) };
  }
  return { ...p, clash, inserted: newItem ? [newItem.id] : [], reinserted: reinsert.map((x) => x.id), dropped: base.length - kept.length, keptStale: kept.keptStale, count: n.items.length };
}
// 兼容旧名字（测试 / 脚本用）
export const planInsert = (tl, now, item, o = {}) => {
  const v = validateItem(item);
  if (!v.ok) return { ok: false, reason: `条目没通过校验：${v.errors.join("；")}` };
  const p = planPublish(tl, now, { newItem: item, takedown: o.takedown });
  return p.ok && p.clash ? { ok: false, reason: `点评开头跟相邻的 ${p.clash.with} 撞了` } : p;
};

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
    // 3. 上线：最多一条新的 + 插回被 use / rollback 拿掉的已上线条目 + 下线超龄的
    let plan = null;
    const onAirTl = await kv.get("timeline");
    const effNow = effective(onAirTl, now);
    const onAirKeys = new Set([...(effNow?.next || effNow?.current)?.items || []].map(keyOf));
    // 已上线过、6 小时内、没下架、R2 里有音频、现在不在时间线里的 → 插回（不合成）
    idx.published = (idx.published || []).filter((p) => now - p.at <= FILLER_MAX_MS);
    const reinsert = [];
    for (const p of idx.published) {
      const st = await kv.get(`pipe:item:${p.id}`);
      const it = st?.seedItem;
      if (!it || onAirKeys.has(keyOf(it)) || ageOf(it, now) > FRESH_MS || takedownMatches(d.takedown, it)) continue;
      if (!(await d.r2.head(it.audio.replace(/^\/audio\//, "")))) continue;
      reinsert.push(it);
    }
    let readyId = idx.ready[0], readySt = readyId ? await kv.get(`pipe:item:${readyId}`) : null;
    if (readySt && takedownMatches(d.takedown, readySt.seedItem)) { idx.ready = idx.ready.slice(1); readySt = null; readyId = null; }
    let p = planPublish(onAirTl, now, { newItem: readySt?.seedItem || null, reinsert, takedown: d.takedown });
    // 点评开头撞车：改写第一句（一条一天一次）→ 重新校验 → 重新合成 → 再排一次
    if (p.ok && p.clash && autoPublish) {
      if (readySt.takeRewriteDay !== day(now)) {
        readySt.takeRewriteDay = day(now);
        const r = await rewriteTakeOpening(readySt, d, p.clash.avoid);
        log.push(`点评开头跟 ${p.clash.with} 撞了，改写第一句：${r.ok ? "成功" : r.reason}`);
        if (r.ok) {
          let st2 = { ...readySt, results: { ...readySt.results, script: r.script }, step: "validate", status: "pending", seedItem: undefined };
          st2 = await advance(st2, d, { save: (s) => kv.put(`pipe:item:${readyId}`, s), deadline });
          readySt = st2;
          if (st2.status === "ready") p = planPublish(onAirTl, now, { newItem: st2.seedItem, reinsert, takedown: d.takedown });
          else { log.push(`改写后：${st2.status}（${st2.why || ""}）`); if (st2.status === "dropped") idx.ready = idx.ready.slice(1); }
        } else await kv.put(`pipe:item:${readyId}`, readySt);
      }
      if (p.ok && p.clash) { // 今天已经改过 / 改写失败：这一轮不上新的，插回和下线照做
        log.push(`点评开头撞车，新条目这一轮先不上`);
        p = planPublish(onAirTl, now, { newItem: null, reinsert, takedown: d.takedown });
      }
    }
    if (p.ok) {
      plan = { switchAt: p.timeline.switchAt, count: p.count, inserted: p.inserted, reinserted: p.reinserted, droppedOld: p.dropped, keptStale: p.keptStale };
      if (autoPublish) {
        await kv.put("timeline", { ...p.timeline, updatedAt: new Date(now).toISOString(), why: `cron +${p.inserted.join(",") || "-"} reinsert ${p.reinserted.length} drop ${p.dropped}` });
        for (const id of p.inserted) {
          idx.ready = idx.ready.filter((x) => x !== id);
          idx.published.push({ id, at: now });
          const st = await kv.get(`pipe:item:${id}`); st.status = "published"; st.publishedAt = now; await kv.put(`pipe:item:${id}`, st);
        }
        log.push(`时间线已更新：新上 ${p.inserted.join(",") || "无"}，插回 ${p.reinserted.length} 条，下线 ${p.dropped} 条，${new Date(p.timeline.switchAt ?? now).toISOString()} 生效，共 ${p.count} 条${p.keptStale ? "（全部超过 12 小时，保留了最新一批）" : ""}`);
      } else log.push(`自动上线关闭；如果打开：${new Date(p.timeline.switchAt ?? now).toISOString()} 生效，共 ${p.count} 条（新上 ${p.inserted.length}、插回 ${p.reinserted.length}、下线 ${p.dropped}）`);
    } else if (!p.noop) { plan = { refused: p.reason }; log.push(`时间线不动：${p.reason}`); }
    idx.last = { at: now, log, plan, autoPublish };
    await kv.put("pipe:index", idx);
    return idx.last;
  } finally {
    await kv.delete?.("pipe:lock");
  }
}
