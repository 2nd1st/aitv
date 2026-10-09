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
const good = { what: "一个把游戏主机程序移植到电脑上的工具", who: "想在电脑上跑主机游戏的开发者", highlight: "不靠模拟器，直接转成本机格式" };

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
  assert.equal(r.fields.what, good.what);
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
