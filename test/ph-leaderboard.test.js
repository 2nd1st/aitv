import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePHLeaderboard, phLeaderboardDate, phLeaderboardUrl, apolloBlobs, checkPHBatch, fetchAll, SOURCES } from "../src/sources.js";
import { checkTemplate, buildSpoken, UNITS } from "../src/validate.js";
import { checkScript, scriptFields, scriptPrompt } from "../src/writer.js";

// 真实页面裁剪（2026/10/7 的日榜，2026-10-09 抓的）：前 14 条 edge，第 5、11 条是广告（Viktor.com 广告里还嵌着一个 Post）
const HTML = readFileSync(new URL("./fixtures/ph-leaderboard-2026-10-07.html", import.meta.url), "utf8");
const T = Date.UTC(2026, 9, 9, 5, 18); // 2026-10-09 13:18 UTC+8 = 10/8 22:18 太平洋时间 → 昨天是 10/7
const TOP5 = [["IrisGo for Solopreneurs", 497], ["GenPage 3.0", 488], ["Velozity", 426], ["Databench by Alkera", 287], ["Pegasus 1.6 by TwelveLabs", 269]];

// 在测试里改 fixture 用：拿到 Apollo 数据 → 改 → 塞回同样形状的 HTML
function mutate(fn) {
  const [b] = apolloBlobs(HTML);
  const conn = Object.values(b.rehydrate).find((x) => x?.data?.homefeedItems).data.homefeedItems;
  fn(conn.edges);
  const title = HTML.match(/<title>[^<]*<\/title>/)[0];
  return `<html><head>${title}</head><body><script>(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push(${JSON.stringify(b)})</script></body></html>`;
}

test("PH 日榜日期：太平洋时间的昨天（PH 按太平洋时间零点切榜）", () => {
  assert.deepEqual(phLeaderboardDate(T), { y: 2026, m: 10, d: 7 });
  assert.equal(phLeaderboardUrl(T), "https://www.producthunt.com/leaderboard/daily/2026/10/7");
  // 太平洋时间 10/9 00:30（UTC 07:30）→ 昨天是 10/8；跨月
  assert.deepEqual(phLeaderboardDate(Date.UTC(2026, 9, 9, 7, 30)), { y: 2026, m: 10, d: 8 });
  assert.deepEqual(phLeaderboardDate(Date.UTC(2026, 10, 1, 12)), { y: 2026, m: 10, d: 31 });
  assert.equal(SOURCES.producthunt.url(T), phLeaderboardUrl(T));
});

test("PH 日榜：真实 Post 按顺序排名，广告跳过（也不数广告里嵌着的 Post），分数取 launchDayScore，取前十", () => {
  const items = parsePHLeaderboard(HTML, T);
  assert.equal(items.check.ok, true, items.check.errors.join("；"));
  assert.equal(items.length, 10);
  assert.deepEqual(items.slice(0, 5).map((x) => [x.fields.title, x.fields.phScore]), TOP5);
  assert.deepEqual(items.map((x) => x.fields.phDailyRank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(!items.some((x) => /Viktor|TinyFish|Dropbox/.test(x.fields.title)), "广告和广告里的产品不能上榜");
  const first = items[0];
  assert.equal(first.id, "ph-1271031");
  assert.equal(first.source, "Product Hunt");
  assert.equal(first.url, "https://www.producthunt.com/posts/irisgo-for-solopreneurs");
  assert.equal(first.fields.tagline, "AI workflow automation: show it once, let it run");
  assert.equal(first.fields.comments, 117);
  assert.ok(!("rank" in first.fields) && !("votes" in first.fields), "PH 不用 rank / votes 这两个名字");
  assert.ok(!("image" in first), "缩略图是产品图标（logo），不当配图");
  assert.equal(first.publishedAt, Date.parse("2026-10-07T00:01:00-07:00"));
  for (let i = 1; i < items.length; i++) assert.ok(items[i].fields.phScore <= items[i - 1].fields.phScore);
});

test("PH 日榜：有官方 TopPostBadge（日榜、同一天）时以它为准；跟顺序对不上就整批不给名次和分数", () => {
  // fixture 里这一天没有徽章；这里人为加上（形状照 PH 的 TopPostBadge）
  const withBadge = mutate((edges) => {
    edges[0].node.badges = { edges: [{ node: { __typename: "TopPostBadge", position: 1, period: "daily", date: "2026-10-07" } }] };
    edges[1].node.badges = { edges: [{ node: { __typename: "TopPostBadge", position: 1, period: "weekly", date: "2026-10-05" } }] }; // 周榜：不算
  });
  const ok = parsePHLeaderboard(withBadge, T);
  assert.equal(ok.check.ok, true, ok.check.errors.join("；"));
  assert.deepEqual(ok.slice(0, 2).map((x) => x.fields.phDailyRank), [1, 2]);
  const bad = parsePHLeaderboard(mutate((edges) => {
    edges[1].node.badges = { edges: [{ node: { __typename: "TopPostBadge", position: 5, period: "daily", date: "2026-10-07" } }] };
  }), T);
  assert.equal(bad.check.ok, false);
  assert.equal(bad.length, 10, "条目照留");
  assert.ok(bad.every((x) => !("phDailyRank" in x.fields) && !("phScore" in x.fields)), "整批拿掉名次和分数");
  assert.ok(bad.every((x) => typeof x.fields.comments === "number"), "评论数照留");
});

test("PH 日榜合理性检查：分数不随名次递减 / dailyRank 对不上 / 页面日期不对 → 整批不给名次和分数", () => {
  const swapped = parsePHLeaderboard(mutate((edges) => { edges[1].node.launchDayScore = 999; }), T);
  assert.equal(swapped.check.ok, false);
  assert.match(swapped.check.errors.join(), /递减/);
  assert.ok(swapped.every((x) => x.fields.phDailyRank === undefined && x.fields.phScore === undefined));
  const rankOff = parsePHLeaderboard(mutate((edges) => { edges[2].node.dailyRank = "7"; }), T);
  assert.equal(rankOff.check.ok, false);
  // 拿 10/7 的页面当 10/8 的榜：日期对不上
  const wrongDay = parsePHLeaderboard(HTML, Date.UTC(2026, 9, 9, 12));
  assert.equal(wrongDay.check.ok, false);
  assert.match(wrongDay.check.errors.join(), /日期/);
  assert.equal(checkPHBatch([{ typename: "Post", name: "a", rank: 2, orderRank: 1, score: 3 }]).ok, false, "名次要从 1 开始");
  // 广告排在第一位也不占名次
  const adFirst = parsePHLeaderboard(mutate((edges) => { edges.unshift(edges[4]); }), T);
  assert.equal(adFirst.check.ok, true);
  assert.equal(adFirst[0].fields.title, "IrisGo for Solopreneurs");
});

test("PH 解析不到榜单 → 0 条（fetchAll 记成这个源出错，别的源照常）", async () => {
  assert.equal(parsePHLeaderboard("<html>Just a moment...</html>", T).length, 0);
  const r = await fetchAll({ now: T, only: ["producthunt"], fetchImpl: async (url) => {
    assert.equal(url, "https://www.producthunt.com/leaderboard/daily/2026/10/7");
    return new Response("<html>Just a moment...</html>");
  } });
  assert.match(r.errors.producthunt, /0 条/);
  const ok = await fetchAll({ now: T, only: ["producthunt"], fetchImpl: async () => new Response(HTML) });
  assert.equal(ok.items.length, 10);
});

test("PH 数字字段：单位绑死，名次只能念成「昨天 Product Hunt 日榜第 N 名」，分数是「分」", () => {
  const [it] = parsePHLeaderboard(HTML, T);
  const f = it.fields;
  assert.ok(UNITS.phDailyRank && UNITS.phScore);
  assert.equal(buildSpoken("{{title}} 拿了昨天 Product Hunt 日榜第 {{phDailyRank}} 名。", f), "IrisGo for Solopreneurs 拿了昨天 Product Hunt 日榜第 1 名。");
  assert.equal(buildSpoken("{{title}} 综合分 {{phScore}} 分。", f), "IrisGo for Solopreneurs 综合分 497 分。");
  assert.equal(checkTemplate("今天 Product Hunt 日榜第 {{phDailyRank}} 名", f).ok, false);
  assert.equal(checkTemplate("日榜第 {{phDailyRank}} 名", f).ok, false);
  assert.equal(checkTemplate("拿了 {{phScore}} 票", f).ok, false, "综合分不是票数");
  assert.equal(checkTemplate("{{phDailyRank}} 分", f).ok, false);
});

test("PH 稿子：全文不许说「今天」；提示词告诉模型这是昨天的榜", () => {
  const [raw] = parsePHLeaderboard(HTML, T);
  const it = { ...raw, brief: { kind: "product", what: "演示过就能自己跑的工作流工具", who: "一个人做生意的人", highlight: "看你操作过就学会" },
    fields: { ...raw.fields, what: "演示过就能自己跑的工作流工具", who: "一个人做生意的人", highlight: "看你操作过就学会" } };
  const fields = scriptFields(it);
  assert.equal(fields.phDailyRank, 1); assert.equal(fields.phScore, 497);
  const p1 = "{{title}} 是一个演示过就能自己跑的工作流工具，你在电脑上先做给它看，它就学着自己跑下去，适合重复的杂事。";
  const p2 = "一个人做生意、手上琐事多的人最用得上，它拿了昨天 Product Hunt 日榜第 {{phDailyRank}} 名，说明不少人对这种做法感兴趣，可以留意。";
  const p3 = "挑件每周都要重复做的杂事，先演示给它看，再对比它自己跑出来的结果，确认能不能放心交给它。";
  assert.equal(checkScript([p1, p2, p3], fields, { kind: "product", source: "Product Hunt" }).ok, true, checkScript([p1, p2, p3], fields, { kind: "product", source: "Product Hunt" }).errors.join());
  const bad = checkScript([p1, p2.replace("昨天 Product Hunt 日榜第 {{phDailyRank}} 名", "今天很火"), p3], fields, { kind: "product", source: "Product Hunt" });
  assert.ok(bad.errors.some((e) => /不许说「今天」/.test(e)));
  const prompt = scriptPrompt(it);
  assert.match(prompt, /昨天/);
  assert.match(prompt, /昨天 Product Hunt 日榜第 \{\{phDailyRank\}\} 名/);
  assert.match(prompt, /不是票数/);
});
