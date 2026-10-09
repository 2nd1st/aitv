// 新鲜度（乔布斯 2026-10-09，Whistle 事故）：按来源的真实发布时间 publishedAt 判，超过 6 小时的跳过（skipped:stale），
// 不做摘要、不合成；上线时再判一次。
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCron, advance, planPublish, isStale, STALE_MS } from "../src/pipeline.js";
import { buildSchedule } from "../src/schedule.js";
import { parseHN } from "../src/sources.js";

const T0 = Date.UTC(2026, 9, 9, 5, 45, 0); // 13:45 UTC+8
function memKV(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => { m.delete(k); } };
}
const memR2 = () => ({ head: async () => null, get: async () => null, put: async () => {} });
const onAir = Array.from({ length: 15 }, (_, i) => ({ id: `x${i}`, audio: `/audio/${String(i).padStart(16, "a")}.mp3`, duration: 30, publishedAt: T0 - 3600_000, take: `${"甲乙丙丁戊己庚辛壬癸子丑寅卯辰"[i]}号点评内容` }));
const TL = { current: { version: "v1", ...buildSchedule(onAir, T0 - 3600_000) }, next: null, switchAt: null };
const hit = (id, hoursAgo) => ({ objectID: String(id), title: `Story ${id}`, url: `https://example.com/${id}`, points: 100, num_comments: 10, created_at_i: Math.floor((T0 - hoursAgo * 3600_000) / 1000) });

function deps(hits) {
  const calls = { other: [], brief: 0, script: 0, tts: 0 };
  const kv = memKV({ timeline: TL, "pipe:index": {} });
  return { calls, kv, d: {
    now: T0, kv, r2: memR2(), ttsCap: 40,
    fetch: async (url) => {
      url = String(url);
      if (url.includes("hn.algolia.com")) return new Response(JSON.stringify({ hits }));
      if (/github\.com\/trending|producthunt|aihot/.test(url)) return new Response("nope", { status: 404 });
      calls.other.push(url); return new Response("nope", { status: 404 });
    },
    briefLLM: async () => { calls.brief++; throw new Error("不该调"); },
    scriptLLM: async () => { calls.script++; throw new Error("不该调"); },
    tts: async () => { calls.tts++; throw new Error("不该调"); },
  } };
}

test("HN publishedAt = 帖子发到 HN 的时间（created_at_i），不是抓取时间", () => {
  const [it] = parseHN({ hits: [hit(1, 13)] }, T0);
  assert.equal(it.publishedAt, T0 - 13 * 3600_000);
  assert.equal(it.fetchedAt, T0);
  assert.ok(isStale(it, T0));
});

test("Whistle 场景：候选全超过 6 小时 → 全部 skipped:stale，不开新条目、不读原文、不调模型 / 豆包", async () => {
  const x = deps([hit(50008427, 12.8), hit(2, 6.1)]);
  const out = await runCron(x.d, { autoPublish: true, maxNewPerDay: 40 });
  const idx = await x.kv.get("pipe:index");
  assert.ok(!out.log.some((l) => l.startsWith("新条目")), out.log.join("\n"));
  assert.deepEqual(idx.skipped.map((s) => [s.id, s.why]), [["hn-50008427", "stale"], ["hn-2", "stale"]]);
  assert.deepEqual(x.calls.other, []);
  assert.equal(x.calls.brief + x.calls.script + x.calls.tts, 0);
  assert.equal(await x.kv.get("pipe:item:hn-50008427"), null);
  assert.ok(idx.seen.includes("hn-50008427"));  // 记成看过，下一轮不再判
});

test("新鲜的照常开：跳过超龄的，选 6 小时内的那条", async () => {
  const x = deps([hit(1, 13), hit(2, 2)]);
  const out = await runCron(x.d, { maxNewPerDay: 40 });
  assert.ok(out.log.includes("新条目 hn-2"), out.log.join("\n"));
  assert.deepEqual((await x.kv.get("pipe:index")).skipped.map((s) => s.id), ["hn-1"]);
});

test("在途变旧（或 AIHOT 读原文后才知道日期）：下一步之前就跳过，不调模型 / 豆包", async () => {
  const x = deps([]);
  const base = { id: "a1", step: "brief", status: "pending", results: {}, tries: {}, errors: [] };
  // AIHOT：读原文那步补出来的发布时间 7 小时前
  let st = await advance({ ...base, item: { id: "a1", source: "AIHOT", publishedAt: null, dateUnknown: true }, results: { read: { text: "x", patch: { publishedAt: T0 - 7 * 3600_000, dateUnknown: false } } } }, x.d);
  assert.equal(st.status, "skipped"); assert.match(st.why, /^stale/);
  // 等额度等到第二天：tts 之前再判
  st = await advance({ ...base, step: "tts", item: { id: "h", source: "Hacker News", publishedAt: T0 - 5 * 3600_000 }, results: { validate: { hash: "0".repeat(16) }, script: { lines: ["a", "b", "c"] } } }, { ...x.d, now: T0 + 2 * 3600_000 });
  assert.equal(st.status, "skipped");
  assert.equal(x.calls.brief + x.calls.tts, 0);
});

test("上线时再判一次：做好了但已经超过 6 小时 → 不插，标 skipped；planPublish 也不插超龄的", async () => {
  const x = deps([]);
  const seedItem = { ...onAir[0], id: "hn-9", audio: "/audio/9999999999999999.mp3", take: "全新的点评开头", publishedAt: T0 - STALE_MS - 60_000, fetchedAt: T0 - 3600_000 };
  await x.kv.put("pipe:item:hn-9", { id: "hn-9", status: "ready", seedItem });
  await x.kv.put("pipe:index", { ready: ["hn-9"] });
  const out = await runCron(x.d, { autoPublish: true, maxNewPerDay: 0 });
  assert.deepEqual(await x.kv.get("timeline"), TL, out.log.join("\n"));
  assert.equal((await x.kv.get("pipe:item:hn-9")).status, "skipped");
  const idx = await x.kv.get("pipe:index");
  assert.deepEqual(idx.ready, []); assert.equal(idx.skipped[0].step, "insert");
  const p = planPublish(TL, T0, { newItem: seedItem });
  assert.ok(!p.ok || !p.inserted.length);
  const fresh = planPublish(TL, T0, { newItem: { ...seedItem, publishedAt: T0 - 3600_000 } });
  assert.deepEqual(fresh.inserted, ["hn-9"]);
});

test("没有发布时间的来源（GitHub Trending，publishedAt = null）：这条规则不判", () => {
  assert.equal(isStale({ publishedAt: null }, T0), false);
});
