// 发布时间读不到的条目不播：流水线读原文那步就丢，发布前 checkSeed 再拦一次，不拿抓取时间顶替
import { test } from "node:test";
import assert from "node:assert/strict";
import { advance } from "../src/pipeline.js";
import { checkSeed } from "../src/release.js";
import { fetchMaterial } from "../src/enrich.js";

const T = Date.UTC(2026, 9, 9, 5, 0);
const aihot = { id: "aihot-x", source: "AIHOT", url: "https://example.com/post", fetchedAt: T, publishedAt: null, dateUnknown: true, aihotLatestAt: T,
  template: "title", fields: { title: "Some launch", permalink: "https://aihot.news/items/x" } };
const page = (head = "") => `<html><head>${head}</head><body><article>${"Body text about the launch. ".repeat(20)}</article></body></html>`;
const fetchOf = (html) => async () => new Response(html);

test("原文读不到日期：fetchMaterial 标 dateUnknown，流水线在读原文这步直接丢（不进 brief、不调模型）", async () => {
  const m = await fetchMaterial(aihot, { fetchImpl: fetchOf(page()), homepageCheck: false, now: T });
  assert.equal(m.patch.dateUnknown, true);
  assert.equal(m.patch.publishedAt, null);
  let calls = 0;
  const st = await advance({ id: aihot.id, item: aihot, step: "read", status: "pending", results: {}, tries: {}, errors: [] },
    { now: T, fetch: fetchOf(page()), briefLLM: async () => { calls++; return "{}"; } });
  assert.equal(st.status, "dropped");
  assert.match(st.why, /发布时间读不到/);
  assert.equal(calls, 0);
});

test("原文能读到日期：照常往下走，publishedAt 是原文时间（不是抓取时间）", async () => {
  const html = page(`<meta property="article:published_time" content="2026-10-08T16:00:00Z">`);
  const m = await fetchMaterial(aihot, { fetchImpl: fetchOf(html), homepageCheck: false, now: T });
  assert.equal(m.patch.dateUnknown, false);
  assert.equal(m.patch.publishedAt, Date.parse("2026-10-08T16:00:00Z"));
  assert.notEqual(m.patch.publishedAt, T);
  const st = await advance({ id: aihot.id, item: aihot, step: "read", status: "pending", results: {}, tries: {}, errors: [] },
    { now: Date.parse("2026-10-08T17:00:00Z"), fetch: fetchOf(html), briefLLM: async () => { throw new Error("模型出错：停在这"); } }); // 发布 1 小时后（6 小时内才往下走）
  assert.notEqual(st.status, "dropped");
  assert.equal(st.step, "brief");
});

test("发布前校验：dateUnknown / AIHOT 没 publishedAt 的条目不算可播", () => {
  const base = { id: "a", source: "AIHOT", audio: "/audio/aaaaaaaaaaaaaaaa.mp3", duration: 20, kind: "news", brief: { kind: "news", what: "w", who: "w" }, take: "t",
    script: [{}, {}, {}], rounds: [{ part: "what" }, { part: "who" }, { part: "take" }] };
  const r = (it) => checkSeed({ version: "v", items: [it] }, "v", { audioBytes: () => 5000, minPlayable: 0 });
  assert.ok(r({ ...base, publishedAt: T - 3600e3, dateUnknown: false }).ok, r({ ...base, publishedAt: T - 3600e3 }).errors.join());
  assert.match(r({ ...base, publishedAt: null, dateUnknown: true }).errors.join(), /发布时间读不到/);
  assert.match(r({ ...base, publishedAt: null }).errors.join(), /发布时间读不到/);
  assert.match(r({ ...base, source: "Hacker News", publishedAt: T, dateUnknown: true }).errors.join(), /发布时间读不到/);
});
