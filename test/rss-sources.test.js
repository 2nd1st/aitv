// 三个 RSS 源（OpenAI News、Google DeepMind 博客、TechCrunch AI 频道）：解析、pubDate、TechCrunch 融资过滤、每轮按新到旧挑候选。
// fixtures 是 2026-10-09 从线上各抓一次裁出来的；TechCrunch 里两条标了 SYNTHETIC 的是手工编的（模型公司无金额融资、无金额融资）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseOpenAINews, parseDeepMindBlog, parseTechCrunchAI, parseRssEntries, techcrunchVerdict, fundingAmounts, modelCompanyOf, rssText, fetchAll, SOURCES } from "../src/sources.js";
import { newestFirst } from "../src/freshness.js";
import { isStale, runCron } from "../src/pipeline.js";
import { buildSpoken, UNITS } from "../src/validate.js";
import { buildSchedule } from "../src/schedule.js";
import { enrich } from "../src/enrich.js";
import { needsTitleZh } from "../src/writer.js";

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const NOW = Date.UTC(2026, 9, 9, 6, 0, 0); // 2026-10-09 14:00 UTC+8
const ID_RE = /^(hn|gh|ph|aihot|oai|gdm|tc)-\S+$/;

function shape(it, prefix, source) {
  assert.match(it.id, ID_RE);
  assert.match(it.id, new RegExp(`^${prefix}-[0-9a-z]+$`));
  assert.equal(it.source, source);
  assert.match(it.url, /^https:\/\//);
  assert.equal(it.fetchedAt, NOW);
  assert.equal(typeof it.publishedAt, "number");
  assert.ok(it.fields.title && !/<|&#|CDATA/.test(it.fields.title), it.fields.title);
  if (it.fields.description) assert.ok(!/<|&#|CDATA/.test(it.fields.description) && it.fields.description.length <= 241);
  assert.equal(it.template, "title");
  assert.equal(it.kindFixed, "news");
}

test("OpenAI News：标题、链接、pubDate 原样、简介去 CDATA", () => {
  const items = parseOpenAINews(fx("rss-openai.xml"), NOW);
  assert.equal(items.length, 6);
  items.forEach((x) => shape(x, "oai", "OpenAI"));
  assert.equal(items[0].fields.title, "How Oracle turns days of work into minutes with ChatGPT and Codex");
  assert.equal(items[0].url, "https://openai.com/index/oracle");
  assert.equal(items[0].publishedAt, Date.UTC(2026, 9, 8, 16, 0, 0));
  assert.match(items[0].fields.description, /^Across recruiting/);
  // 同一个链接每轮同一个 id（跨轮去重靠它）
  assert.equal(parseOpenAINews(fx("rss-openai.xml"), NOW + 1)[0].id, items[0].id);
  assert.equal(new Set(items.map((x) => x.id)).size, items.length);
});

test("Google DeepMind：没有 pubDate 的条目跳过；空简介不进 fields", () => {
  const xml = fx("rss-deepmind.xml");
  assert.ok(xml.includes("synthetic-no-date"));
  const items = parseDeepMindBlog(xml, NOW);
  assert.equal(items.length, 6);
  items.forEach((x) => shape(x, "gdm", "Google DeepMind"));
  assert.ok(!items.some((x) => x.url.includes("synthetic-no-date")));
  assert.equal(items[0].publishedAt, Date.parse("Tue, 06 Oct 2026 19:57:04 +0000"));
  assert.ok(!("description" in items[0].fields));
  assert.ok(items.some((x) => x.fields.description));
});

test("RSS：坏 pubDate / 未来时间 / 非 https 链接跳过；按 pubDate 新到旧；实体和转义 HTML 去干净", () => {
  const xml = `<rss><channel>
    <item><title>Old</title><link>https://a.com/1</link><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate></item>
    <item><title>Bad date</title><link>https://a.com/2</link><pubDate>someday</pubDate></item>
    <item><title>Future</title><link>https://a.com/3</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate></item>
    <item><title>Plain http</title><link>http://a.com/4</link><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate></item>
    <item><title>It&#8217;s new</title><link>https://a.com/5</link><pubDate>Thu, 08 Oct 2026 10:00:00 +0000</pubDate><description>&lt;p&gt;Hello &amp;amp; <b>bye</b>&lt;/p&gt;</description></item>
  </channel></rss>`;
  const e = parseRssEntries(xml, NOW);
  assert.deepEqual(e.map((x) => x.title), ["It’s new", "Old"]);
  assert.equal(e[0].description, "Hello & bye");
  assert.equal(rssText("<![CDATA[<p>A &#x2014; B</p>]]>"), "A — B");
});

test("TechCrunch：留 ≥1 亿美元融资、模型公司融资、普通 AI 新闻；丢小额、无金额、活动宣传", () => {
  const items = parseTechCrunchAI(fx("rss-techcrunch-ai.xml"), NOW);
  items.forEach((x) => shape(x, "tc", "TechCrunch"));
  const t = (x) => x.fields.title;
  assert.deepEqual(items.map(t), [
    "Popular AI leaderboard Arena nearly doubles valuation to $3.1B valuation in 10 months", // 描述里 raised $200 million
    "Google brings agentic AI to Gemini, starting with businesses",                          // 普通 AI 新闻
    "China’s Manus raises over $500M in first funding round since split with Meta",           // over $500M ≥ 1 亿
    "Mistral AI raises new funding round to expand its frontier models",                      // 模型公司（SYNTHETIC，无金额）
  ]);
  const arena = items[0], manus = items[2], mistral = items[3];
  assert.equal(arena.fields.fundingUsd, 200_000_000);       // 取融资额，不取 $3.1B 估值
  assert.ok(!("fundingUsd" in manus.fields));               // 「over」不是确数：条目留，数不给
  assert.ok(!("fundingUsd" in mistral.fields));
  assert.ok(!("fundingUsd" in items[1].fields));
  const why = (start) => items.dropped.find((d) => d.title.startsWith(start))?.why;
  assert.match(why("Cal AI"), /\$10,000,000 不到 1 亿美元/);          // $10M
  assert.match(why("Nous Research"), /\$90,000,000 不到 1 亿美元/);   // $90M Series B（$1.5B 是估值，不算）
  assert.match(why("Acme Robotics"), /没有美元金额/);                  // SYNTHETIC 无金额
  assert.match(why("5 days to TechCrunch"), /活动宣传/);
  assert.equal(items.dropped.length, 4);
});

test("融资金额：只认 $ 美元、只认跟融资动作挨着的数；欧元 / 估值 / 没金额都不算", () => {
  const usd = (s) => fundingAmounts(s).map((a) => a.usd);
  assert.deepEqual(usd("Acme raises $1.2B Series C"), [1.2e9, 1.2e9]);
  assert.deepEqual(usd("Acme secured US$150 million in new funding"), [150e6, 150e6]);
  assert.deepEqual(usd("Acme raised $250,000,000"), [250e6]);
  assert.deepEqual(usd("Acme raises €500 million"), []);
  assert.deepEqual(usd("Acme hits $3B valuation"), []);
  assert.deepEqual(usd("Acme valued at $2B after raising"), []);
  const v = (title, description = "") => techcrunchVerdict({ title, description, categories: ["AI"] });
  assert.equal(v("Acme AI raises €200 million").keep, false);                 // 非美元 → 丢
  assert.equal(v("Acme AI raises $100 million Series B").keep, true);         // 正好 1 亿 → 留
  assert.equal(v("Acme AI raises $100 million Series B").fundingUsd, 100e6);
  assert.equal(v("Acme AI raises nearly $100 million").keep, false);         // nearly = 不到
  assert.equal(v("Anthropic raises $5M from employees").keep, true);          // 模型公司，金额不限
  assert.equal(v("Anthropic raises $5M from employees").fundingUsd, 5e6);
  assert.equal(v("Perplexity raises $50M for AI search").keep, false);        // Perplexity 不是模型公司
  assert.equal(v("Ex-OpenAI researchers raise $20M for AI startup").keep, false); // 前员工创业不算模型公司
  assert.equal(modelCompanyOf("Startup backed by OpenAI raises $20M"), null);
  assert.equal(modelCompanyOf("DeepSeek raises funding"), "DeepSeek");
  assert.equal(v("Pretend you're sitting at Elizabeth Holmes' desk", "A website with trial documents").keep, false); // 非 AI
  assert.equal(techcrunchVerdict({ title: "Manus raises over $500M", description: "", categories: ["AI", "Manus AI"] }).keep, true); // 标签里有 AI 也算
});

test("fundingUsd 有单位绑定：只能念「融资 N 美元」；编的数被拦", () => {
  assert.deepEqual(UNITS.fundingUsd, { before: "融资 ", after: " 美元" });
  const f = { fundingUsd: 200_000_000 };
  assert.ok(buildSpoken("这次融资 {{fundingUsd}} 美元。", f));
  assert.equal(buildSpoken("这次拿了 {{fundingUsd}} 美元。", f), null);
  assert.equal(buildSpoken("这次融资 {{fundingUsd}} 元。", f), null);
});

test("三个 RSS 源都是文章：6 小时发布时间规则（不是榜单）", () => {
  const [it] = parseOpenAINews(fx("rss-openai.xml"), NOW); // 2026-10-08 16:00 UTC，14 小时前
  assert.ok(isStale(it, NOW));
  assert.ok(!isStale(it, it.publishedAt + 5 * 3600_000));
  assert.ok(isStale(it, it.publishedAt + 6 * 3600_000 + 1));
});

test("fetchAll：三个 RSS 源走同一套重试（503 后重试成功），带 RSS accept 头", async () => {
  const seen = {};
  const fake = async (url, init) => {
    seen[url] = (seen[url] || 0) + 1;
    assert.match(init.headers.accept, /rss\+xml/);
    if (url.includes("openai.com") && seen[url] === 1) return new Response("x", { status: 503 });
    if (url.includes("openai.com")) return new Response(fx("rss-openai.xml"));
    if (url.includes("deepmind.google")) return new Response(fx("rss-deepmind.xml"));
    return new Response(fx("rss-techcrunch-ai.xml"));
  };
  const r = await fetchAll({ fetchImpl: fake, now: NOW, only: ["openai", "deepmind", "techcrunch"], sleep: async () => {} });
  assert.deepEqual(r.errors, {});
  assert.equal(seen[SOURCES.openai.url], 2);
  assert.equal(r.items.length, 6 + 6 + 4);
});

test("类型固定为新闻：模型判成 product 也按 news；需要中文标题", async () => {
  const [it] = parseOpenAINews(fx("rss-openai.xml"), NOW);
  const brief = { safety: "ok", safetyReason: "", kind: "product", name: null, what: "甲骨文用 ChatGPT 和 Codex 加快招聘、工程和运营流程", who: "关心企业怎么落地 AI 工具的人", highlight: "把专家经验变成可重复的工作流", limit: "" };
  const e = await enrich(it, { llm: async () => JSON.stringify(brief), material: { url: it.url, text: "x".repeat(300), image: null } });
  assert.equal(e.kind, "news");
  assert.equal(e.brief.kind, "news");
  assert.ok(needsTitleZh(it));
});

test("候选按时间新到旧：文章按 publishedAt、榜单按 rankedAt；AIHOT 没日期时按 aihotLatestAt；同时间保持原顺序", () => {
  const H = 3600_000;
  const c = [
    { id: "tc-a", source: "TechCrunch", publishedAt: NOW - 3 * H },
    { id: "tc-b", source: "TechCrunch", publishedAt: NOW - 2 * H },
    { id: "ph-1", source: "Product Hunt", rankedAt: NOW - 1 * H, publishedAt: NOW - 30 * H },
    { id: "oai-1", source: "OpenAI", publishedAt: NOW - 0.5 * H },
    { id: "aihot-1", source: "AIHOT", publishedAt: null, dateUnknown: true, aihotLatestAt: NOW - 2.5 * H },
    { id: "x-1", source: "X", publishedAt: null },
    { id: "tc-c", source: "TechCrunch", publishedAt: NOW - 2 * H },
  ];
  assert.deepEqual(newestFirst(c, new Set(["producthunt", "github"])).map((x) => x.id), ["oai-1", "ph-1", "tc-b", "tc-c", "aihot-1", "tc-a", "x-1"]);
  // 榜单开关关掉：PH 按 featuredAt（publishedAt），排到后面
  assert.equal(newestFirst(c, new Set()).at(-2).id, "ph-1");
});

test("每轮挑 2 条：TechCrunch 量大也挤不掉更新的厂商条目（runCron）", async () => {
  const H = 3600_000;
  const m = new Map();
  const kv = { get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => { m.delete(k); } };
  const onAir = Array.from({ length: 3 }, (_, i) => ({ id: `x${i}`, audio: `/audio/${String(i).padStart(16, "a")}.mp3`, duration: 30, publishedAt: NOW - H, take: `${"甲乙丙"[i]}号点评` }));
  m.set("timeline", { current: { version: "v1", ...buildSchedule(onAir, NOW - H) }, next: null, switchAt: null });
  m.set("pipe:index", { seen: [] });
  const tc = (i, h) => ({ id: `tc-${i}`, source: "TechCrunch", url: `https://techcrunch.com/${i}`, fetchedAt: NOW, publishedAt: NOW - h * H, template: "title", fields: { title: `AI story ${i}` }, kindFixed: "news" });
  const items = [tc(5, 3), tc(4, 2.5), tc(3, 2), tc(2, 1.5), tc(1, 1), // 原来的轮流排会先拿 tc-5（3 小时前）
    { id: "oai-z", source: "OpenAI", url: "https://openai.com/index/z", fetchedAt: NOW, publishedAt: NOW - 0.2 * H, template: "title", fields: { title: "OpenAI thing" }, kindFixed: "news" },
    { id: "gdm-y", source: "Google DeepMind", url: "https://deepmind.google/blog/y/", fetchedAt: NOW, publishedAt: NOW - 1.2 * H, template: "title", fields: { title: "DeepMind thing" }, kindFixed: "news" }];
  const d = { now: NOW, kv, r2: { head: async () => null, get: async () => null, put: async () => {} }, ranked: new Set(["producthunt", "github"]),
    fetchAll: async () => ({ fetchedAt: NOW, items, errors: {} }),
    fetch: async () => new Response("nope", { status: 404 }), // 读原文失败也没关系，这里只看挑了谁
    briefLLM: async () => { throw new Error("不该调"); }, scriptLLM: async () => { throw new Error("不该调"); }, tts: async () => { throw new Error("不该调"); } };
  const out = await runCron(d, { maxNewPerDay: 40 });
  assert.deepEqual(out.log.filter((l) => l.startsWith("新条目")), ["新条目 oai-z", "新条目 tc-1"], out.log.join("\n"));
});
