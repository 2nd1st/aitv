// 发布时间兜底：原文页面 → 官方 RSS → 包打听给的 X 时间 → 不播；永远不用抓取时间
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normUrl, parseFeedDates, rssPubDate, xPubDate, RSS_FEEDS, _clearFeedCache } from "../src/pubdate.js";
import { fetchMaterial, _clearHomepageCache } from "../src/enrich.js";
import { advance } from "../src/pipeline.js";
import { parseAIHOT } from "../src/sources.js";

const RSS = readFileSync(new URL("./fixtures/openai-rss.xml", import.meta.url), "utf8");
const T = Date.UTC(2026, 9, 9, 5, 0);
const ORACLE = Date.parse("Thu, 08 Oct 2026 16:00:00 GMT");
const body = (head = "") => `<html><head>${head}</head><body><article>${"Launch details and context. ".repeat(20)}</article></body></html>`;
const aihot = (url, extra = {}) => ({ id: "aihot-1", source: "AIHOT", url, fetchedAt: T, publishedAt: null, dateUnknown: true, aihotLatestAt: T,
  template: "title", fields: { title: "Oracle and ChatGPT", permalink: "https://aihot.news/items/1" }, ...extra });
// openai.com 页面 403（box 上实测如此），RSS 200；AIHOT 条目页能读
function site({ page = 403, rss = true } = {}) {
  const calls = [];
  const f = async (u) => {
    u = String(u); calls.push(u);
    if (u === RSS_FEEDS["openai.com"]) return rss ? new Response(RSS) : new Response("no", { status: 500 });
    if (u.startsWith("https://openai.com/")) return page === 200 ? new Response(body(`<meta property="article:published_time" content="2026-10-07T12:00:00Z">`)) : new Response("blocked", { status: page });
    if (u.startsWith("https://aihot.news/")) return new Response(body());
    return new Response("nope", { status: 404 });
  };
  return Object.assign(f, { calls });
}
beforeEach(() => { _clearFeedCache(); _clearHomepageCache?.(); });

test("链接规范化：去 query / hash / 结尾斜杠，忽略 www 和大小写主机名", () => {
  assert.equal(normUrl("https://www.OpenAI.com/index/oracle/?utm=x#a"), "openai.com/index/oracle");
  assert.equal(normUrl("https://openai.com/index/oracle"), "openai.com/index/oracle");
});

test("RSS 解析（fixture）：link / guid → pubDate", () => {
  const m = parseFeedDates(RSS);
  assert.equal(m.get("openai.com/index/oracle"), ORACLE);
  assert.ok(m.size >= 3);
});

test("① 原文页面能读到日期：用页面的，pubDateSource = page，不去查 RSS", async () => {
  const f = site({ page: 200 });
  const m = await fetchMaterial(aihot("https://openai.com/index/oracle/"), { fetchImpl: f, homepageCheck: false, now: T });
  assert.equal(m.patch.publishedAt, Date.parse("2026-10-07T12:00:00Z"));
  assert.equal(m.patch.pubDateSource, "page");
  assert.ok(!f.calls.includes(RSS_FEEDS["openai.com"]));
});

test("② 页面 403：按链接在官方 RSS 里找（结尾斜杠 / query 不影响），pubDateSource = rss", async () => {
  const m = await fetchMaterial(aihot("https://openai.com/index/oracle/?utm_source=aihot"), { fetchImpl: site(), homepageCheck: false, now: T });
  assert.equal(m.patch.dateUnknown, false);
  assert.equal(m.patch.publishedAt, ORACLE);
  assert.equal(m.patch.pubDateSource, "rss");
  assert.notEqual(m.patch.publishedAt, T);
});

test("③ RSS 里没有这条：用包打听给的 X 发布时间（pubDate + pubDateSource: x）", async () => {
  const x = "2026-10-08T18:30:00Z";
  const m = await fetchMaterial(aihot("https://openai.com/index/not-in-feed/", { pubDate: x, pubDateSource: "x" }), { fetchImpl: site(), homepageCheck: false, now: T });
  assert.equal(m.patch.publishedAt, Date.parse(x));
  assert.equal(m.patch.pubDateSource, "x");
  // pubDateSource 不是 x 的不认
  assert.equal(xPubDate({ pubDate: x, pubDateSource: "guess" }, T), null);
  assert.equal(xPubDate({ pubDate: "2030-01-01T00:00:00Z", pubDateSource: "x" }, T), null); // 未来时间不认
});

test("④ 都没有：不播（流水线读原文这步就丢），不拿抓取时间顶替", async () => {
  const it = aihot("https://openai.com/index/not-in-feed/");
  const m = await fetchMaterial(it, { fetchImpl: site(), homepageCheck: false, now: T });
  assert.equal(m.patch.dateUnknown, true); assert.equal(m.patch.publishedAt, null);
  const st = await advance({ id: it.id, item: it, step: "read", status: "pending", results: {}, tries: {}, errors: [] }, { now: T, fetch: site() });
  assert.equal(st.status, "dropped"); assert.match(st.why, /发布时间读不到/);
});

test("RSS 挂了 / 域名不在表里：不兜底（没有 X 时间就不播）", async () => {
  assert.equal(await rssPubDate("https://openai.com/index/oracle", { fetchImpl: site({ rss: false }), now: T }), null);
  assert.equal(await rssPubDate("https://example.com/post", { fetchImpl: site(), now: T }), null);
});

test("流水线：RSS 兜底拿到日期的条目继续往下走，进节目单的条目带 pubDateSource", async () => {
  const it = aihot("https://openai.com/index/oracle/");
  const st = await advance({ id: it.id, item: it, step: "read", status: "pending", results: {}, tries: {}, errors: [] },
    { now: Date.parse("2026-10-08T17:00:00Z"), fetch: site(), briefLLM: async () => { throw new Error("模型出错：停在 brief"); } }); // RSS 时间 1 小时后
  assert.equal(st.step, "brief"); assert.notEqual(st.status, "dropped");
  assert.equal(st.results.read.patch.pubDateSource, "rss");
});

test("AIHOT 输入里带 X 时间（pubDateSource: x）才透传", () => {
  const [a, b] = parseAIHOT({ items: [
    { id: "1", title: "t", rank: 1, links: { original: "https://openai.com/index/a", aihot: "https://aihot.news/items/1" }, pubDate: "2026-10-08T00:00:00Z", pubDateSource: "x" },
    { id: "2", title: "t", rank: 2, links: { original: "https://openai.com/index/b", aihot: "https://aihot.news/items/2" }, pubDate: "2026-10-08T00:00:00Z", pubDateSource: "web" },
  ] }, T);
  assert.equal(a.pubDateSource, "x"); assert.equal(a.pubDate, "2026-10-08T00:00:00Z");
  assert.ok(!("pubDateSource" in b));
});

test("流水线：RSS 兜底拿到的日期超过 6 小时 → skipped:stale，不进 brief", async () => {
  const it = aihot("https://openai.com/index/oracle/");
  let calls = 0;
  const st = await advance({ id: it.id, item: it, step: "read", status: "pending", results: {}, tries: {}, errors: [] },
    { now: T, fetch: site(), briefLLM: async () => { calls++; return "{}"; } });
  assert.equal(st.status, "skipped"); assert.match(st.why, /^stale/); assert.equal(calls, 0);
  // 日志里要看得到读出来的日期（以前记成 null）
  assert.equal(st.item.publishedAt, Date.parse("Thu, 08 Oct 2026 16:00:00 GMT")); assert.equal(st.item.pubDateSource, "rss");
});
