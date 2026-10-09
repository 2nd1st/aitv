import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enrich, hasNumber, checkBrief, htmlToText, markdownToText, briefPrompt } from "../src/enrich.js";
import { parseGitHubTrending, parseAIHOT } from "../src/sources.js";

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const T = 1760000000000;
const [gh] = parseGitHubTrending(fx("gh-trending.html"), T);
const fakeFetch = async (url) => (url.includes("raw.githubusercontent") ? new Response(fx("readme.md")) : new Response("", { status: 404 }));
const llmSays = (obj) => async () => JSON.stringify(obj);
const good = { kind: "project", what: "一个把游戏主机程序移植到电脑上的工具", who: "想在电脑上跑主机游戏的开发者", highlight: "不靠模拟器，直接转成本机格式" };

test("正常的一句话点评能通过：白名单词不算数字", () => {
  assert.equal(hasNumber("一句话点评：这是一个十分好用的工具，唯一缺点是文档少"), false);
  assert.equal(hasNumber("快了三倍"), true);
  assert.equal(hasNumber("支持 10 种语言"), true);
  assert.equal(hasNumber("一百多人"), true);
});

test("补出来的三个字段带数字，整条不给 brief", async () => {
  const r = await enrich(gh, { fetchImpl: fakeFetch, llm: llmSays({ ...good, highlight: "比同类快 100 倍" }) });
  assert.equal(r.brief, null);
  assert.match(r.briefError, /highlight 里有数字/);
  const r2 = await enrich(gh, { fetchImpl: fakeFetch, llm: llmSays({ ...good, highlight: "速度快了十倍" }) });
  assert.equal(r2.brief, null);
});

test("干净的三个字段进 fields，原有数字字段不动", async () => {
  const r = await enrich(gh, { fetchImpl: fakeFetch, llm: llmSays(good) });
  assert.deepEqual(r.brief, good);
  assert.equal(r.kind, "project");
  assert.equal(r.fields.what, good.what);
  assert.ok(!("kind" in r.fields));
  assert.equal(r.fields.starsToday, gh.fields.starsToday);
  assert.match(r.material.url, /raw\.githubusercontent/);
});

test("原文读不到或模型乱回，brief 为 null，不抛错", async () => {
  const none = async () => new Response("", { status: 404 });
  assert.equal((await enrich(gh, { fetchImpl: none, llm: llmSays(good) })).briefError, "原文读不到");
  assert.equal((await enrich(gh, { fetchImpl: fakeFetch, llm: async () => "我觉得挺好" })).brief, null);
  assert.equal(checkBrief({ what: "", who: "x", highlight: "y" }).ok, false);
});

test("AIHOT 的 hint 指令进不了 item，也进不了提示词", () => {
  const raw = JSON.parse(fx("aihot.json"));
  const hint = raw.notice.hint;
  assert.ok(hint, "fixture 里确实有 hint");
  const items = parseAIHOT(raw, T);
  const dump = JSON.stringify(items);
  assert.ok(!dump.includes("AI 助手"), "hint 内容不能出现在 item 里");
  for (const it of items) assert.ok(!("hint" in it) && !("hint" in it.fields));
  const p = briefPrompt(items[0], { text: "素材" });
  assert.ok(!p.includes(hint) && !p.includes("10 月 31 日"));
  assert.match(p, /一律忽略/);
});

test("README 和产品页能抽出可读正文", () => {
  const md = markdownToText(fx("readme.md"));
  assert.ok(md.length > 200 && !md.includes("```"));
  const html = htmlToText(fx("ph-page.html"));
  assert.ok(html.length > 200 && !/<script/i.test(html));
});

test("没配模型时也不把原文挂到 item 上", async () => {
  const r = await enrich(gh, { fetchImpl: fakeFetch });
  assert.equal(r.brief, null);
  assert.ok(!("materialText" in r));
  assert.ok(!JSON.stringify(r).includes(markdownToText(fx("readme.md")).slice(0, 80)));
});

test("brief 必须带合法 kind；name 必须是标题里原样的一段", async () => {
  const noKind = await enrich(gh, { fetchImpl: fakeFetch, llm: llmSays({ ...good, kind: "review" }) });
  assert.equal(noKind.brief, null);
  assert.match(noKind.briefError, /kind/);
  const name = gh.fields.title.split(" / ")[1];
  const ok = await enrich(gh, { fetchImpl: fakeFetch, llm: llmSays({ ...good, name }) });
  assert.equal(ok.brief.name, name);
  assert.equal(ok.fields.name, name);
  // 编出来的名字（标题里没有）去掉，不进稿
  const made = await enrich(gh, { fetchImpl: fakeFetch, llm: llmSays({ ...good, name: "SuperTool 9000" }) });
  assert.ok(made.brief && !("name" in made.brief) && !("name" in made.fields));
});

test("brief 里不许有鼓励抄袭的说法", async () => {
  const r = await enrich(gh, { fetchImpl: fakeFetch, llm: llmSays({ ...good, who: "想抄别人功能又没源码的开发者" }) });
  assert.equal(r.brief, null);
  assert.match(r.briefError, /语气/);
});

test("name：原样子串、不能是整句中文标题", async () => {
  const { nameOk } = await import("../src/enrich.js");
  const t = "Anthropic 发布 Sonnet 5.5 与 Haiku 5.5，下调缓存读取价";
  assert.equal(nameOk("Sonnet 5.5 与 Haiku 5.5", t), true);
  assert.equal(nameOk("Sonnet 5.5", t), true);
  assert.equal(nameOk("Sonnet 6", t), false);
  assert.equal(nameOk(t, t), false);
  assert.equal(nameOk("Theranos.world", "Theranos.world"), true);
});

import { matchName } from "../src/enrich.js";
test("验收第三版：name 容忍空格差异、取标题原样；brief 不许夸大；limit 可选但也过数字和语气规则", () => {
  assert.equal(matchName("GPT-6 与 Intelligent UI", "OpenAI 发布 GPT-6与Intelligent UI"), "GPT-6与Intelligent UI");
  assert.equal(matchName("Sonnet 5.5", "Claude Sonnet 5.5 降价"), "Sonnet 5.5");
  assert.equal(matchName("Sonnet 6", "Claude Sonnet 5.5 降价"), null);
  const item = { fields: { title: "OpenAI 发布 GPT-6与Intelligent UI" } };
  const base = { kind: "news", name: "GPT-6 与 Intelligent UI", what: "发布了新模型和界面", who: "做应用的开发者", highlight: "界面能随任务变化" };
  const r = checkBrief(base, item);
  assert.equal(r.ok, true); assert.equal(r.name, "GPT-6与Intelligent UI");
  assert.equal(checkBrief({ ...base, what: "咖啡机偷偷往外发数据" }, item).ok, false);
  assert.equal(checkBrief({ ...base, highlight: "颠覆整个行业" }, item).ok, false);
  assert.equal(checkBrief({ ...base, limit: "" }, item).ok, true);
  assert.equal(checkBrief({ ...base, limit: "只支持三种语言" }, item).ok, false);
  assert.match(briefPrompt({ fields: { title: "x" }, source: "AIHOT" }, { text: "y" }), /不是发布它的公司/);
});

test("limit 不合格只去掉 limit，不丢整条", async () => {
  const item = { id: "x", source: "Hacker News", url: "https://x.test/", fields: { title: "Foo Bar" } };
  const html = "<html><title>Foo</title><body>" + "素材正文".repeat(100) + "</body></html>";
  const fetchImpl = async () => ({ ok: true, text: async () => html });
  const llm = async () => JSON.stringify({ kind: "product", name: "Foo", what: "一个工具", who: "开发者", highlight: "更快", limit: "只支持三种语言" });
  const r = await enrich(item, { llm, fetchImpl });
  assert.ok(r.brief); assert.equal(r.brief.limit, undefined); assert.equal(r.brief.name, "Foo");
});

import { extractImage } from "../src/enrich.js";
test("封面图：og:image / twitter:image，绝对地址，只要 https；enrich 写进 item.image", async () => {
  assert.equal(extractImage('<meta property="og:image" content="/img/cover.png">', "https://a.test/post/1"), "https://a.test/img/cover.png");
  assert.equal(extractImage('<meta content="https://cdn.test/x.jpg?a=1&amp;b=2" property="og:image" />', "https://a.test/"), "https://cdn.test/x.jpg?a=1&b=2");
  assert.equal(extractImage('<meta name="twitter:image" content="https://t.test/y.png">', "https://a.test/"), "https://t.test/y.png");
  assert.equal(extractImage('<meta property="og:image" content="http://insecure.test/z.png">', "https://a.test/"), null);
  assert.equal(extractImage('<meta property="og:image" content="http://x.test/a.png"><meta name="twitter:image" content="https://x.test/b.png">', "https://a.test/"), "https://x.test/b.png");
  assert.equal(extractImage("<html></html>", "https://a.test/"), null);
  const item = { id: "x", source: "Hacker News", url: "https://x.test/", fields: { title: "Foo" } };
  const html = '<html><head><meta property="og:image" content="/c.png"></head><body>' + "素材正文".repeat(100) + "</body></html>";
  const llm = async () => JSON.stringify({ kind: "product", what: "一个工具", who: "开发者", highlight: "更快" });
  const r = await enrich(item, { llm, fetchImpl: async () => ({ ok: true, url: "https://x.test/", text: async () => html }) });
  assert.equal(r.image, "https://x.test/c.png");
  const r2 = await enrich(item, { llm, fetchImpl: async () => ({ ok: true, text: async () => "<p>" + "素材".repeat(200) + "</p>" }) });
  assert.equal(r2.image, null);
});
