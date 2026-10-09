import { test } from "node:test";
import assert from "node:assert/strict";
import { laMidnightAfter, phListEnd, timeOf, annotate, parseRanked } from "../src/freshness.js";
import { dropOld } from "../src/pipeline.js";

const NOW = Date.UTC(2026, 9, 9, 6, 0); // 2026-10-09 14:00 UTC+8 = 10-08 23:00 PDT

test("洛杉矶午夜：夏令时 UTC-7、冬令时 UTC-8", () => {
  assert.equal(new Date(laMidnightAfter({ y: 2026, m: 10, d: 7 })).toISOString(), "2026-10-08T07:00:00.000Z");
  assert.equal(new Date(laMidnightAfter({ y: 2026, m: 12, d: 1 })).toISOString(), "2026-12-02T08:00:00.000Z");
});

test("PH rankedAt = 抓的那份日榜（洛杉矶「昨天」）结束的时间", () => {
  assert.equal(new Date(phListEnd(NOW)).toISOString(), "2026-10-08T07:00:00.000Z"); // 10-07 那份榜，10-08 00:00 PDT 结束
  assert.equal(new Date(phListEnd(Date.UTC(2026, 9, 9, 7, 30))).toISOString(), "2026-10-09T07:00:00.000Z"); // 15:30 UTC+8 之后换成 10-08 那份
});

test("timeOf / annotate：榜单类按 rankedAt，文章类按 publishedAt，都没有 = unknown；开关可关", () => {
  const ph = { source: "Product Hunt", fetchedAt: NOW, publishedAt: Date.UTC(2026, 9, 7) };
  const gh = { source: "GitHub Trending", fetchedAt: NOW - 3600e3, publishedAt: null };
  const hn = { source: "Hacker News", fetchedAt: NOW, publishedAt: NOW - 2 * 3600e3 };
  assert.deepEqual(timeOf(ph), { t: Date.UTC(2026, 9, 8, 7), kind: "ranked" });
  assert.deepEqual(timeOf(gh), { t: NOW - 3600e3, kind: "ranked" });
  assert.deepEqual(timeOf({ ...gh, rankedAt: NOW - 5 * 3600e3 }), { t: NOW - 5 * 3600e3, kind: "ranked" });
  assert.deepEqual(timeOf(hn), { t: NOW - 2 * 3600e3, kind: "published" });
  const off = parseRanked("none");
  assert.deepEqual(timeOf(ph, off), { t: Date.UTC(2026, 9, 7), kind: "published" });
  assert.deepEqual(timeOf(gh, off), { t: null, kind: "unknown" });
  assert.deepEqual([...parseRanked("github")], ["github"]);
  const a = annotate(gh);
  assert.equal(a.dateKind, "ranked"); assert.equal(a.rankedAt, NOW - 3600e3); assert.equal(a.publishedAt, null);
  const b = annotate({ ...gh, rankedAt: 1 }, off);
  assert.equal(b.dateKind, "unknown"); assert.ok(!("rankedAt" in b));
});

test("下线规则用同一套时间：开着 GitHub 留，关了就下", () => {
  const a = (id, o) => ({ id, audio: `/audio/${id.padEnd(16, "0")}.mp3`, duration: 20, ...o });
  const items = [a("gh", { source: "GitHub Trending", fetchedAt: NOW - 2 * 3600e3 }), a("hn", { source: "Hacker News", fetchedAt: NOW, publishedAt: NOW - 13 * 3600e3 }),
    a("hn2", { source: "Hacker News", fetchedAt: NOW, publishedAt: NOW - 3600e3 })];
  assert.deepEqual(dropOld(items, NOW).map((x) => x.id), ["gh", "hn2"]);
  assert.deepEqual(dropOld(items, NOW, { ranked: parseRanked("none") }).map((x) => x.id), ["hn2"]);
});
