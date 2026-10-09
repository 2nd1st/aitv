import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runCron, advance, dropOld, planInsert, planPublish, tagParts, firstSentence } from "../src/pipeline.js";
import { planTimeline } from "../src/timeline.js";
import { mp3Duration } from "../src/mp3.js";
import { scriptHash } from "../src/scripthash.js";
import { addTakedown } from "../src/release.js";
import { buildSchedule } from "../src/schedule.js";
import { effective, locate } from "../src/timeline.js";
import { capKey } from "../src/ttscap.js";
import { fetchAll } from "../src/sources.js";

const GH = readFileSync(new URL("./fixtures/gh-trending.html", import.meta.url), "utf8");
const ID = "gh-cathrynlavery/diagram-design";
const T0 = Date.UTC(2026, 9, 9, 5, 0, 0);

// 假 mp3：n 帧 MPEG2 Layer III 24kHz 64kbps（每帧 192 字节、0.024 秒）
const fakeMp3 = (n = 1000) => { const b = new Uint8Array(192 * n); for (let i = 0; i < n; i++) b.set([0xff, 0xf3, 0x84, 0x00], i * 192); return b; };

const BRIEF = { safety: "ok", safetyReason: "", kind: "project", name: "cathrynlavery / diagram-design",
  what: "一个给 AI 编程助手用的图表技能，生成自包含的 HTML 加 SVG 编辑级图表，还能重绘别的图表源。",
  who: "写文档、做架构图的人，尤其是用 AI 助手画图却总得到通用圆角框的人。",
  highlight: "图表类型丰富，静态输出是默认，可选动效，作者强调每个节点都要有意义。",
  limit: "官方构建只来自该仓库，其他名字的插件列表是非官方副本；动效是可选的，静态才是默认。" };
const SCRIPT = {
  part1: "{{name}} 是给 AI 编程助手用的图表技能，生成自包含的 HTML 加 SVG 编辑级图表，还能重绘别的图表源。图表类型丰富，静态输出是默认，作者强调每个节点都要有意义。",
  part2: "写文档、做架构图的人，尤其用 AI 助手画图却总得到通用圆角框的，可以用它生成可编辑图表。官方构建只来自该仓库，其他名字的插件列表是非官方副本，下载前先确认来源。",
  part3: "拿它重绘现有文档里的架构图，对比输出是否比通用圆角框更贴切；动效是可选的，静态才是默认，按需开启。",
};
const README = "# diagram-design\n\n" + "Editorial diagram design skill for coding agents. Produces self-contained HTML and SVG diagrams. ".repeat(6);

function memKV(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => { m.delete(k); } };
}
function memR2(init = {}) {
  const m = new Map(Object.entries(init));
  const obj = (v) => ({ arrayBuffer: async () => (typeof v === "string" ? new TextEncoder().encode(v).buffer : v.buffer.slice(0)), json: async () => JSON.parse(typeof v === "string" ? v : new TextDecoder().decode(v)) });
  return { m, head: async (k) => (m.has(k) ? { key: k } : null), get: async (k) => (m.has(k) ? obj(m.get(k)) : null), put: async (k, v) => { m.set(k, v); } };
}
// 15 条在播（点评开头各不相同），给插入用
const onAir = Array.from({ length: 15 }, (_, i) => ({ id: `x${i}`, audio: `/audio/${String(i).padStart(16, "a")}.mp3`, duration: 30, publishedAt: T0 - 3600_000, take: `${"甲乙丙丁戊己庚辛壬癸子丑寅卯辰"[i]}号点评内容` }));
const TL = { current: { version: "v1", ...buildSchedule(onAir, T0 - 3600_000) }, next: null, switchAt: null };

function deps({ now = T0, kv = memKV({ timeline: TL, "pipe:index": { seen: ["gh-boykopovar/AnyPS5"] } }), r2 = memR2(), script = SCRIPT, briefFail = 0, ttsFail = 0, ttsCap = 40, pubAt = T0 - 3600_000, rewrite = "不妨先拿它重绘现有文档里的架构图，对比输出是否比通用圆角框更贴切；" } = {}) {
  const calls = { readme: 0, brief: 0, script: 0, tts: 0 };
  let bf = briefFail, tf = ttsFail;
  return { calls, kv, r2, d: {
    now, kv, r2, ttsCap,
    ranked: new Set(), // 这些测试关掉榜单类时间，按下面补的 publishedAt 走（榜单类另有测试）
    // GitHub Trending 本身没有发布时间（会被跳过）；这些测试走流水线本身，给 fixture 补一个 1 小时前的发布时间
    fetchAll: async (o) => { const r = await fetchAll(o); r.items = r.items.map((x) => ({ ...x, publishedAt: x.publishedAt ?? pubAt })); return r; },
    fetch: async (url) => {
      url = String(url);
      if (url.includes("github.com/trending")) return new Response(GH);
      if (url.includes("raw.githubusercontent.com/cathrynlavery/diagram-design")) { calls.readme++; return new Response(README); }
      return new Response("nope", { status: 404 });
    },
    briefLLM: async (p) => { calls.brief++; if (bf-- > 0) throw new Error("DeepSeek 503"); return /title_zh/.test(p) ? "{}" : JSON.stringify(BRIEF); },
    scriptLLM: async (p) => { if (/"first"/.test(p)) { calls.rewrite = (calls.rewrite || 0) + 1; return JSON.stringify({ first: rewrite }); } calls.script++; return JSON.stringify(script); },
    tts: async (payload) => { calls.tts++; if (tf-- > 0) throw new Error("豆包 500");
      return { audio: fakeMp3(), rounds: payload.nlp_texts.map((x, i) => ({ text: x.text, start_time: i * 8, end_time: i * 8 + 8 })) }; },
  } };
}

test("mp3Duration：按帧头累加；tagParts 三段一一对应", () => {
  assert.equal(Math.round(mp3Duration(fakeMp3(1000)) * 1000), 24000);
  assert.deepEqual(tagParts([{ text: "a" }, { text: "b" }, { text: "c" }], ["a", "b", "c"]).map((r) => r.part), ["what", "who", "take"]);
});

test("一轮跑完：抓 → 读原文 → brief → 稿 → 校验 → 合成 → R2；自动上线关闭时线上时间线不动，只记计划", async () => {
  const { d, kv, r2, calls } = deps();
  const out = await runCron(d, { autoPublish: false });
  const st = await kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "ready", JSON.stringify(st.errors));
  assert.deepEqual(Object.keys(st.results), ["read", "brief", "script", "validate", "tts"]);
  const hash = await scriptHash(st.results.script.lines);
  assert.equal(st.seedItem.audio, `/audio/${hash}.mp3`);
  assert.ok(r2.m.has(`${hash}.mp3`) && r2.m.has(`${hash}.json`));
  assert.equal(st.seedItem.kind, "project");
  assert.ok(!("lines" in st.seedItem) && !JSON.stringify(st.seedItem).includes("Editorial diagram design skill")); // 原文不进条目
  assert.equal(calls.tts, 1);
  assert.equal((await kv.get(capKey(T0))).count, 1);
  assert.deepEqual(await kv.get("timeline"), TL); // 没上线
  assert.ok(out.plan.switchAt >= T0 + 150_000 && out.plan.count === 16, JSON.stringify(out.plan));
  // 每天最多开一条：第二轮不再抓新的
  const again = await runCron({ ...d, now: T0 + 15 * 60_000 }, {});
  assert.ok(!again.log.some((l) => l.startsWith("新条目")));
});

test("断点续跑：brief 这步模型挂了，下一轮从 brief 接着跑，不重新读原文", async () => {
  const x = deps({ briefFail: 1 }); // 模型出错 enrich 直接返回 → 这一轮停在 brief
  await runCron(x.d, {});
  let st = await x.kv.get(`pipe:item:${ID}`);
  assert.equal(st.step, "brief");
  assert.equal(st.status, "pending");
  assert.ok(st.results.read.text.length > 200);
  assert.equal(x.calls.readme, 1);
  await runCron({ ...x.d, now: T0 + 15 * 60_000 }, {});
  st = await x.kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "ready");
  assert.equal(x.calls.readme, 1); // 没再读原文
});

test("每日额度：用完了就等（不调豆包）；同一条一天最多试两次（一次重试），第二天再来", async () => {
  const capped = deps({ ttsCap: 0 });
  await runCron(capped.d, {});
  let st = await capped.kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "waiting"); assert.match(st.why, /额度/); assert.equal(capped.calls.tts, 0);

  // 「第二天」= UTC+8 的下一天 00:00 之后（T0 + 11h）；发布时间放在那之前 5 小时，跨天时还在 6 小时内
  const x = deps({ ttsFail: 5, pubAt: T0 + 6 * 3600_000 });
  await runCron(x.d, {});                                  // 第 1 次：失败
  await runCron({ ...x.d, now: T0 + 15 * 60_000 }, {});    // 第 2 次（重试）：失败
  await runCron({ ...x.d, now: T0 + 30 * 60_000 }, {});    // 第 3 次：今天试够了，不调
  st = await x.kv.get(`pipe:item:${ID}`);
  assert.equal(x.calls.tts, 2);
  assert.equal(st.status, "waiting"); assert.match(st.why, /试过 2 次/);
  await runCron({ ...x.d, now: T0 + 11 * 3600_000 }, {});  // 第二天：又能试（还是失败 → 累计 3 次）
  assert.equal(x.calls.tts, 3);
  await runCron({ ...x.d, now: T0 + 11 * 3600_000 + 15 * 60_000 }, {}); // 累计失败 4 次 → 丢
  st = await x.kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "dropped");
});

test("内容寻址：R2 里已有这份稿子的音频就不调豆包、不占额度", async () => {
  const lines = [SCRIPT.part1.replace("{{name}}", BRIEF.name), SCRIPT.part2, SCRIPT.part3];
  const h = await scriptHash(lines);
  const x = deps({ r2: memR2({ [`${h}.mp3`]: fakeMp3(), [`${h}.json`]: JSON.stringify(lines.map((text, i) => ({ text, start_time: i, end_time: i + 1 }))) }) });
  await runCron(x.d, {});
  const st = await x.kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "ready"); assert.equal(st.results.tts.cached, true);
  assert.equal(x.calls.tts, 0); assert.equal(await x.kv.get(capKey(T0)), null);
});

test("下架按稿子 hash：同一份稿子丢掉；同一个 id 写出新稿子照常通过（不按 id 跳过）", async () => {
  const lines = [SCRIPT.part1.replace("{{name}}", BRIEF.name), SCRIPT.part2, SCRIPT.part3];
  const td = addTakedown(null, { hash: await scriptHash(lines), id: ID });
  const blocked = deps({ kv: memKV({ timeline: TL, takedown: td, "pipe:index": { seen: ["gh-boykopovar/AnyPS5"] } }) });
  await runCron(blocked.d, {});
  let st = await blocked.kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "dropped"); assert.match(st.why, /下架名单/); assert.equal(blocked.calls.tts, 0);

  const rewritten = deps({ kv: memKV({ timeline: TL, takedown: td, "pipe:index": { seen: ["gh-boykopovar/AnyPS5"] } }),
    script: { ...SCRIPT, part3: "拿它重绘现有文档里的架构图，对比输出是否比通用圆角框更贴切；动效默认关闭，需要时再打开。" } });
  await runCron(rewritten.d, {});
  st = await rewritten.kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "ready", st.why);
});

test("自动上线打开：插在当前在播那条后面，switchAt 在边界且 >= now+150s，现在播的不受影响", async () => {
  const x = deps();
  await runCron(x.d, { autoPublish: true });
  const tl = await x.kv.get("timeline");
  assert.ok(tl.next && tl.switchAt >= T0 + 150_000);
  assert.equal(tl.current.anchor, TL.current.anchor);
  assert.equal(tl.next.items[0].id, ID);
  assert.equal(tl.next.items.length, 16);
  assert.equal(locate(TL.current, tl.switchAt).t, 0);
  const st = await x.kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "published");
  assert.equal(effective(tl, tl.switchAt).current.items[0].id, ID);
});

const ago = (h) => T0 - h * 3600_000;
const aged = (n, h, p = "o") => Array.from({ length: n }, (_, i) => ({ id: `${p}${h}-${i}`, audio: `/audio/${(p + h + "x" + i).padEnd(16, "0").slice(0, 16)}.mp3`, duration: 20, publishedAt: ago(h), fetchedAt: T0 }));

test("72 小时：所有来源一个窗口，72 小时内全留，超过的一律下线（没有 15 条门槛和补位）", () => {
  assert.equal(dropOld([...aged(16, 1), ...aged(5, 50), ...aged(3, 73)], T0).length, 21);
  assert.equal(dropOld([...aged(3, 1), ...aged(20, 73)], T0).length, 3);
});

test("边界：全部超过 72 小时 → 不出空节目单，保留时间最新的 5 条，标 stale", () => {
  const out = dropOld([...aged(2, 80), ...aged(4, 73), ...aged(3, 90)], T0);
  assert.equal(out.length, 5); assert.equal(out.keptStale, true);
  assert.deepEqual(out.map((x) => x.id).sort(), ["o73-0", "o73-1", "o73-2", "o73-3", "o80-0"]);
  assert.ok(out.every((x) => x.stale === true));
  assert.equal(dropOld([...aged(4, 73)], T0, { others: 1 }).length, 0);          // 这一轮有新条目插进来：旧的照下
});

test("15 条门槛不挡新条目：只有 5 条在播也照样插", () => {
  const small = { current: { version: "v", ...buildSchedule(onAir.slice(0, 5), T0) }, next: null, switchAt: null };
  const it = { ...onAir[0], id: "new", audio: "/audio/ffffffffffffffff.mp3", take: "全新的点评开头" };
  const p = planPublish(small, T0, { newItem: it });
  assert.ok(p.ok, p.reason); assert.equal(p.count, 6); assert.deepEqual(p.inserted, ["new"]);
});

// T0 时正在播第 0 条（写稿时的上一条点评，开头不同）；切换点前后的邻居点评都以「拿它重」开头
const clashTL = { current: { version: "v1", ...buildSchedule(onAir.map((x, i) => ({ ...x, take: i === 0 ? "甲号点评内容" : "拿它重新看一遍" })), T0 - 3600_000) }, next: null, switchAt: null };
test("点评开头跟邻居撞：改写第一句 → 重新校验 → 重新合成（占额度）→ 当轮上线", async () => {
  const x = deps({ kv: memKV({ timeline: clashTL, "pipe:index": { seen: ["gh-boykopovar/AnyPS5"] } }) });
  const out = await runCron(x.d, { autoPublish: true });
  const tl = await x.kv.get("timeline");
  assert.equal(x.calls.rewrite, 1, JSON.stringify(out.log));
  assert.equal(x.calls.tts, 2);                              // 原稿一次 + 改写后一次
  assert.equal((await x.kv.get(capKey(T0))).count, 2);
  assert.equal(tl.next.items[0].id, ID, JSON.stringify(out.log));
  assert.match(tl.next.items[0].take, /^不妨先/);
});

test("改写一条一天只试一次：改了还撞就先不上，同一天不再改；插回 / 下线照做", async () => {
  const x = deps({ kv: memKV({ timeline: clashTL, "pipe:index": { seen: ["gh-boykopovar/AnyPS5"] } }), rewrite: "拿它重新画一遍现有文档里的架构图；", pubAt: T0 + 6 * 3600_000 });
  await runCron(x.d, { autoPublish: true });
  assert.equal(x.calls.rewrite, 1);
  assert.deepEqual(await x.kv.get("timeline"), clashTL);
  assert.equal((await x.kv.get("pipe:index")).ready[0], ID);
  await runCron({ ...x.d, now: T0 + 15 * 60_000 }, { autoPublish: true });
  assert.equal(x.calls.rewrite, 1);                          // 同一天不再改
  await runCron({ ...x.d, now: T0 + 11 * 3600_000 }, { autoPublish: true, maxNewPerDay: 0 });
  assert.equal(x.calls.rewrite, 2);                          // 第二天可以再改一次
});

test("use / rollback 之后：下一轮把 6 小时内、没下架的已上线条目插回来，零合成", async () => {
  const x = deps();
  await runCron(x.d, { autoPublish: true });
  assert.equal((await x.kv.get("pipe:item:" + ID)).status, "published");
  const tts0 = x.calls.tts, cap0 = (await x.kv.get(capKey(T0))).count;
  // 模拟 release.mjs use：换成一个不含新条目的版本（fresh），switchAt 过后生效
  const t1 = T0 + 20 * 60_000;
  const used = planTimeline(await x.kv.get("timeline"), t1, { version: "v2", items: onAir, mode: "fresh" }).timeline;
  await x.kv.put("timeline", used);
  const t2 = used.switchAt + 60_000;
  const out = await runCron({ ...x.d, now: t2 }, { autoPublish: true, maxNewPerDay: 1 });
  const tl = await x.kv.get("timeline");
  assert.deepEqual(out.plan.reinserted, [ID], JSON.stringify(out.log));
  assert.ok(tl.next.items.some((i) => i.id === ID));
  assert.ok(tl.switchAt >= t2 + 150_000);
  assert.equal(x.calls.tts, tts0);                            // 没有新合成
  assert.equal((await x.kv.get(capKey(T0))).count, cap0);
  // 已经在时间线里了：再跑一轮不重复插
  const again = await runCron({ ...x.d, now: tl.switchAt + 60_000 }, { autoPublish: true });
  assert.ok(!(again.plan?.reinserted || []).length);
});

test("插回只插 72 小时内、没下架的", async () => {
  const x = deps();
  await runCron(x.d, { autoPublish: true });
  const st = await x.kv.get("pipe:item:" + ID);
  const used = { current: { version: "v2", ...buildSchedule(onAir, T0) }, next: null, switchAt: null };
  await x.kv.put("timeline", used);
  const late = await runCron({ ...x.d, now: st.seedItem.publishedAt + 72 * 3600_000 + 60_000 }, { autoPublish: true, maxNewPerDay: 0 });
  assert.ok(!(late.plan?.reinserted || []).includes(ID));
  await x.kv.put("timeline", used);
  await x.kv.put("takedown", addTakedown(null, { audio: st.seedItem.audio }));
  const td = await runCron({ ...x.d, now: T0 + 3600_000 }, { autoPublish: true, maxNewPerDay: 0 });
  assert.ok(!(td.plan?.reinserted || []).includes(ID));
});

test("firstSentence 只取第一句", () => assert.equal(firstSentence("甲乙；丙丁。"), "甲乙；"));

test("年龄按 publishedAt，不按 fetchedAt；没有 publishedAt 的（GitHub Trending）当未知、下线", () => {
  const justFetched = (id, pubH) => ({ id, audio: `/audio/${id.padEnd(16, "0")}.mp3`, duration: 20, fetchedAt: T0, publishedAt: pubH == null ? null : ago(pubH) });
  const out = dropOld([justFetched("a", 2), justFetched("b", 73), justFetched("c", null), justFetched("d", 50)], T0);
  assert.deepEqual(out.map((x) => x.id), ["a", "d"]);
  // 下线经 switchAt：planPublish 只出下一版，现在播的不切
  const tl = { current: { version: "v", ...buildSchedule([justFetched("a", 2), justFetched("b", 73), justFetched("c", null)], T0) }, next: null, switchAt: null };
  const p = planPublish(tl, T0 + 1000, {});
  assert.ok(p.ok && p.timeline.switchAt >= T0 + 1000 + 150_000);
  assert.deepEqual(p.timeline.next.items.map((x) => x.id), ["a"]);
  assert.equal(p.timeline.current.anchor, T0);
});

test("全部超过 12 小时：保留最新 5 条标 stale，下一轮不再反复改；节目单每条都带 publishedAt", () => {
  const its = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, audio: `/audio/${("s" + i).padEnd(16, "0")}.mp3`, duration: 20, publishedAt: ago(73 + i) }));
  const tl = { current: { version: "v", ...buildSchedule(its, T0) }, next: null, switchAt: null };
  const p = planPublish(tl, T0, {});
  assert.ok(p.ok && p.keptStale); assert.equal(p.count, 5);
  assert.ok(p.timeline.next.items.every((x) => x.stale === true && typeof x.publishedAt === "number"));
  const later = planPublish({ current: p.timeline.next, next: null, switchAt: null }, p.timeline.switchAt + 1000, {});
  assert.ok(!later.ok && later.noop);
  assert.equal(buildSchedule([{ id: "g", audio: "/audio/x.mp3", duration: 1 }], 0).items[0].publishedAt, null);
});

test("RANKED_SOURCES 关掉 GitHub：候选没有发布时间 → skipped:no-pubdate，不开流水线", async () => {
  const x = deps();
  const out = await runCron({ ...x.d, fetchAll: undefined, ranked: new Set() }, {});
  const idx = await x.kv.get("pipe:index");
  assert.ok(!out.log.some((l) => l.startsWith("新条目")), out.log.join("\n"));
  assert.ok(idx.skipped.length > 0 && idx.skipped.every((s) => s.why === "no-pubdate"));
  assert.equal(x.calls.brief + x.calls.tts, 0);
});

test("RANKED_SOURCES 开着（默认）：GitHub 按第一次在 trending 看到的时间；第二次看到不刷新，过了 72 小时就跳过", async () => {
  const x = deps();
  const out = await runCron({ ...x.d, fetchAll: undefined, ranked: undefined }, {});
  assert.ok(out.log.some((l) => l.startsWith("新条目 gh-")), out.log.join("\n"));
  const seen = await x.kv.get("rank:firstSeen");
  assert.equal(seen[ID].first, T0);
  const st = await x.kv.get(`pipe:item:${ID}`);
  assert.equal(st.item.rankedAt, T0);
  await x.kv.put("pipe:index", { seen: [] });
  await x.kv.delete(`pipe:item:${ID}`);
  const later = await runCron({ ...x.d, fetchAll: undefined, ranked: undefined, now: T0 + 73 * 3600_000 }, { maxNewPerDay: 40 });
  assert.equal((await x.kv.get("rank:firstSeen"))[ID].first, T0);
  assert.ok((await x.kv.get("pipe:index")).skipped.some((s) => s.id === ID && s.why === "stale"), later.log.join("\n"));
});

// ---------- 2026-10-09 第二批：榜单 24 小时、每轮最多 2 条、按墙钟留余量 ----------
import { newPerRun, MAX_NEW_PER_RUN, STEP_BACK_AT, STEP_MAX_MS } from "../src/pipeline.js";

test("榜单类（PH / GitHub）按 rankedAt、文章按 publishedAt，同一个 72 小时窗口", () => {
  const r = (id, h, source = "Product Hunt") => ({ id, source, audio: `/audio/${id.padEnd(16, "0")}.mp3`, duration: 20, fetchedAt: T0, rankedAt: ago(h) });
  const a = (id, h) => ({ id, source: "Hacker News", audio: `/audio/${id.padEnd(16, "0")}.mp3`, duration: 20, fetchedAt: T0, publishedAt: ago(h) });
  const out = dropOld([r("ph70", 70), r("gh50", 50, "GitHub Trending"), r("ph73", 73), a("hn3", 3), a("hn71", 71), a("hn73", 73)], T0).map((x) => x.id);
  assert.deepEqual(out, ["ph70", "gh50", "hn3", "hn71"]);
});

test("每轮新上：在播有效条目 < 12 → 2 条；>= 12 → 1 条（常量）", () => {
  assert.equal(MAX_NEW_PER_RUN, 2); assert.equal(STEP_BACK_AT, 12);
  assert.equal(newPerRun(0), 2); assert.equal(newPerRun(11), 2); assert.equal(newPerRun(12), 1); assert.equal(newPerRun(30), 1);
});

const readyItem = (id, take) => ({ ...onAir[0], id, source: "Hacker News", publishedAt: T0 - 1800_000, audio: `/audio/${id.padEnd(16, "0")}.mp3`, take });
async function withReady(nFresh, ids) {
  const items = onAir.slice(0, nFresh);
  const tl = { current: { version: "v1", ...buildSchedule(items, T0 - 600_000) }, next: null, switchAt: null };
  const kv = memKV({ timeline: tl, "pipe:index": { ready: ids, seen: [] } });
  for (const [i, id] of ids.entries()) await kv.put(`pipe:item:${id}`, { id, status: "ready", seedItem: readyItem(id, `${"一二三"[i]}号新条目的点评`) });
  const x = deps({ kv });
  const out = await runCron(x.d, { autoPublish: true, maxNewPerDay: 0 });
  return { out, tl: await kv.get("timeline"), idx: await kv.get("pipe:index") };
}
test("在播有效 5 条：一轮上 2 条新的（经 switchAt），12 条起退回 1 条", async () => {
  const a = await withReady(5, ["n1", "n2", "n3"]);
  assert.deepEqual(a.out.plan.inserted, ["n1", "n2"], a.out.log.join("\n"));
  assert.deepEqual(a.tl.next.items.slice(0, 2).map((x) => x.id), ["n1", "n2"]);
  assert.ok(a.tl.switchAt >= T0 + 150_000);
  assert.deepEqual(a.idx.ready, ["n3"]);
  const b = await withReady(12, ["n1", "n2"]);
  assert.deepEqual(b.out.plan.inserted, ["n1"], b.out.log.join("\n"));
  assert.deepEqual(b.idx.ready, ["n2"]);
});

test("一轮开 2 条新候选（有效条目少时）", async () => {
  const tl = { current: { version: "v1", ...buildSchedule(onAir.slice(0, 3), T0 - 600_000) }, next: null, switchAt: null };
  const x = deps({ kv: memKV({ timeline: tl, "pipe:index": { seen: [] } }) });
  const out = await runCron(x.d, { maxNewPerDay: 40 });
  assert.equal(out.log.filter((l) => l.startsWith("新条目")).length, 2, out.log.join("\n"));
});

test("墙钟：剩下的时间不够跑完这一步就不开（留给下一轮），不会超过 cron 的 15 分钟", async () => {
  const x = deps();
  const st0 = { id: "z", item: { id: "z", source: "Hacker News", publishedAt: T0 }, step: "script", status: "pending", results: { brief: BRIEF }, tries: {}, errors: [] };
  const st = await advance(st0, x.d, { deadline: Date.now() + STEP_MAX_MS.script - 1000 });
  assert.equal(st.status, "pending"); assert.equal(st.step, "script"); assert.equal(x.calls.script, 0);
});

// ---------- 乔木 2026-10-09 14:48：72 小时窗口；插回线上 seed 里被下掉的；插入那批从新到旧 ----------
test("插回 seed 里被下掉的：72 小时内、音频在 R2、没下架、内容安全的回来（零合成），整批从新到旧排在当前条目后面", async () => {
  const hex = (id) => [...id].map((c) => c.charCodeAt(0).toString(16)).join("").padEnd(16, "0").slice(0, 16);
  const s = (id, h, extra = {}) => ({ ...onAir[0], id, source: "Hacker News", publishedAt: ago(h), audio: `/audio/${hex(id)}.mp3`, take: `${id} 的点评`,
    kind: "news", brief: { kind: "news", what: `${id} 是什么`, who: "谁会用" }, script: [{}, {}, {}], rounds: [{ part: "what" }, { part: "who" }, { part: "take" }], ...extra });
  const seedItems = [s("old20", 20), s("old5", 5), s("old80", 80), s("td", 3), s("noaudio", 4), s("bad", 6, { brief: { kind: "news", what: "免费下载盗版电影", who: "x" } }), s("onair", 1)];
  const tl = { current: { version: "v1", ...buildSchedule([s("onair", 1), s("cur", 2)], T0 - 600_000) }, next: null, switchAt: null };
  const r2init = {}; for (const it of seedItems) if (it.id !== "noaudio") r2init[it.audio.replace("/audio/", "")] = fakeMp3();
  const kv = memKV({ timeline: tl, pointer: { version: "v1" }, "seed:v1": { version: "v1", items: seedItems }, "pipe:index": { seen: [] },
    takedown: addTakedown(null, { audio: s("td", 3).audio }) });
  const x = deps({ kv, r2: memR2(r2init) });
  const out = await runCron(x.d, { autoPublish: true, maxNewPerDay: 0 });
  const t = await kv.get("timeline");
  assert.ok(out.plan, out.log.join("\n"));
  assert.deepEqual(out.plan.reinserted.sort(), ["old20", "old5"], out.log.join("\n"));
  assert.deepEqual(t.next.items.slice(0, 2).map((i) => i.id), ["old5", "old20"]); // 插进来的从新到旧，排在最前（切换那一刻之后）
  assert.deepEqual(t.next.items.slice(2).map((i) => i.id).sort(), ["cur", "onair"]);
  assert.ok(t.switchAt >= T0 + 150_000);
  assert.equal(x.calls.tts, 0);
  assert.ok(out.log.some((l) => /bad：内容安全没过/.test(l)), out.log.join("\n"));
  // 再跑一轮：已经在时间线里了，不重复插
  const again = await runCron({ ...x.d, now: t.switchAt + 1000 }, { autoPublish: true, maxNewPerDay: 0 });
  assert.ok(!(again.plan?.reinserted || []).length);
});
