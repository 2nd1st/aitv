import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractPublishedAt, tweetTime, fetchMaterial, enrich, _clearHomepageCache } from "../src/enrich.js";
import { parseAIHOT } from "../src/sources.js";
import { toSeedItem } from "../src/writer.js";
import { seedItemOf } from "../src/pipeline.js";

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const NOW = Date.UTC(2026, 9, 9, 5);
const T = 1760000000000;

test("原文发布时间：meta / JSON-LD / <time> / 正文日期 / X 帖子 id；读不到就是 null", () => {
  const at = (f, u) => extractPublishedAt(fx(f), u, { now: NOW });
  assert.deepEqual(at("orig-techcrunch-gemini-agent.html", "https://techcrunch.com/x/"), { publishedAt: Date.parse("2026-10-08T18:18:00+00:00"), dateSource: "meta article:published_time" });
  assert.equal(at("orig-anthropic-usage-policy.html", "https://www.anthropic.com/news/x").publishedAt, Date.parse("2026-10-08T17:00:00.000Z"));
  // Anthropic 的 Sonnet 5.5 发布页没有结构化日期，只有页头的「September 28, 2026」
  const s = at("orig-anthropic-sonnet-5-5.html", "https://www.anthropic.com/claude-sonnet-5-5");
  assert.equal(s.publishedAt, Date.UTC(2026, 8, 28)); assert.match(s.dateSource, /正文/);
  const ld = '<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-10-07T09:00:00+08:00"}</script><p>x</p>';
  assert.equal(extractPublishedAt(ld, "https://a.test/x", { now: NOW }).publishedAt, Date.parse("2026-10-07T01:00:00Z"));
  const time = '<article><time datetime="2026-10-06T12:00:00Z">Oct 6</time><p>正文</p></article>';
  assert.equal(extractPublishedAt(time, "https://a.test/x", { now: NOW }).dateSource, "<time datetime>");
  assert.equal(extractPublishedAt("<p>2026年10月5日 发布</p>", "https://a.test/x", { now: NOW }).publishedAt, Date.UTC(2026, 9, 5));
  assert.equal(tweetTime("https://x.com/Google/status/2107836410254291345"), Date.parse("2026-10-07T14:12:16.568Z"));
  assert.equal(extractPublishedAt("<html></html>", "https://x.com/Google/status/2107836410254291345", { now: NOW }).dateSource, "tweet-id");
  assert.deepEqual(extractPublishedAt("<html><p>没有日期</p></html>", "https://a.test/x", { now: NOW }), { publishedAt: null, dateSource: null });
  // 未来的时间不认
  assert.equal(extractPublishedAt('<meta property="article:published_time" content="2030-01-01T00:00:00Z">', "https://a.test/x", { now: NOW }).publishedAt, null);
});

test("AIHOT 解析：latestAt 是最后活跃时间，不当 publishedAt；先标 dateUnknown，latestAt 只留着判断旧链接、不进 seed", () => {
  const raw = JSON.parse(fx("aihot-v1.json"));
  const [it] = parseAIHOT(raw, T);
  assert.equal(it.publishedAt, null);
  assert.equal(it.dateUnknown, true);
  assert.equal(it.aihotLatestAt, Date.parse(raw.items[0].latestAt));
  const seed = toSeedItem(it);
  assert.ok(!("aihotLatestAt" in seed));
  assert.equal(seed.dateUnknown, true);
});

const permalink = "https://aihot.news/items/x8r8kta42au39pp06f02shk9f";
const aihotItem = (url, latestAt) => ({ id: "aihot-x", source: "AIHOT", url, fetchedAt: T, publishedAt: null, dateUnknown: true, aihotLatestAt: Date.parse(latestAt),
  template: "title", fields: { title: "Anthropic 发布 Sonnet 5.5 与 Haiku 5.5，下调缓存读取价", origin: "Anthropic", rank: 1, permalink } });
const net = (map) => async (url) => (map[String(url)] ? new Response(map[String(url)]) : new Response("nope", { status: 404 }));

test("AIHOT 补料：原文比 latestAt 早三天以上 → 旧链接，url 退回 links.aihot，publishedAt null + dateUnknown", async () => {
  _clearHomepageCache();
  const sonnet = "https://www.anthropic.com/claude-sonnet-5-5";
  const it = aihotItem(sonnet, "2026-10-08T20:04:10.000Z");
  const m = await fetchMaterial(it, { now: NOW, fetchImpl: net({ [sonnet]: fx("orig-anthropic-sonnet-5-5.html"), [permalink]: fx("aihot-item-page.html") }) });
  assert.equal(m.url, permalink, "正文改读 AIHOT 条目页");
  assert.deepEqual(m.patch, { publishedAt: null, dateUnknown: true, url: permalink, staleOriginal: sonnet, staleOriginalPublishedAt: Date.UTC(2026, 8, 28) });
  assert.equal(m.image, null, "AIHOT 自己的分享卡不要");
  // enrich 把 patch 合并回 item
  const r = await enrich(it, { material: m });
  assert.equal(r.url, permalink); assert.equal(r.publishedAt, null); assert.equal(r.dateUnknown, true);
  // 流水线：seed 里用的是改过的 url / 日期
  const st = { item: it, results: { read: m, brief: { kind: "news", brief: { kind: "news", what: "a", who: "b" }, fields: it.fields },
    script: { kind: "news", parts: ["a", "b", "c"], lines: ["a", "b", "c"], fields: it.fields }, tts: { image: null, audio: "/audio/0123456789abcdef.mp3", duration: 10, rounds: [] } } };
  const seed = seedItemOf(st);
  assert.equal(seed.url, permalink); assert.equal(seed.publishedAt, null); assert.equal(seed.dateUnknown, true);
  assert.ok(!("staleOriginal" in seed) && !("aihotLatestAt" in seed));
});

test("AIHOT 补料：原文日期新 → publishedAt 用原文的，url 不动；读不出日期 → null + dateUnknown，不拿 latestAt 顶", async () => {
  _clearHomepageCache();
  const tc = "https://techcrunch.com/2026/10/08/google-brings-agentic-ai-to-gemini-starting-with-businesses/";
  const it = aihotItem(tc, "2026-10-08T18:55:17.000Z");
  const m = await fetchMaterial(it, { now: NOW, fetchImpl: net({ [tc]: fx("orig-techcrunch-gemini-agent.html") }) });
  assert.equal(m.url, tc);
  assert.deepEqual(m.patch, { publishedAt: Date.parse("2026-10-08T18:18:00Z"), dateUnknown: false, pubDateSource: "page" });
  assert.ok(m.image);
  const plain = "https://blog.example/post";
  const it2 = aihotItem(plain, "2026-10-08T18:55:17.000Z");
  const m2 = await fetchMaterial(it2, { now: NOW, fetchImpl: net({ [plain]: "<html><body><p>" + "没有日期的正文。".repeat(60) + "</p></body></html>" }) });
  assert.deepEqual(m2.patch, { publishedAt: null, dateUnknown: true });
  assert.equal(m2.url, plain);
  // 原文读不到、退到 AIHOT 条目页：AIHOT 页上的时间是事件开始时间，不当发布时间；url 不改
  const it3 = aihotItem("https://gone.example/x", "2026-10-08T18:55:17.000Z");
  const m3 = await fetchMaterial(it3, { now: NOW, fetchImpl: net({ [permalink]: fx("aihot-item-page.html") }) });
  assert.deepEqual(m3.patch, { publishedAt: null, dateUnknown: true });
  // 旧链接但 AIHOT 条目页也读不到：整条读不到（不拿旧页面的正文硬写）
  const sonnet = "https://www.anthropic.com/claude-sonnet-5-5";
  assert.equal(await fetchMaterial(aihotItem(sonnet, "2026-10-08T20:04:10.000Z"), { now: NOW, fetchImpl: net({ [sonnet]: fx("orig-anthropic-sonnet-5-5.html") }) }), null);
});
