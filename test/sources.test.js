import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHN, parseGitHubTrending, parseProductHunt, parseAIHOT, fetchAll, dedupe, interleave } from "../src/sources.js";
import { buildSpoken } from "../src/validate.js";

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const T = 1760000000000;

function shape(it) {
  assert.match(it.id, /^(hn|gh|ph|aihot)-\S+$/);
  assert.match(it.url, /^https:\/\//);
  assert.equal(it.fetchedAt, T);
  assert.ok(it.fields.title, "要有标题");
  if (it.template === "number") assert.equal(typeof it.fields[it.focus], "number");
}

test("HN：分数、评论数原样保留", () => {
  const raw = JSON.parse(fx("hn.json"));
  const items = parseHN(raw, T);
  assert.equal(items.length, raw.hits.length);
  items.forEach(shape);
  assert.equal(items[0].fields.points, raw.hits[0].points);
  assert.equal(items[0].fields.comments, raw.hits[0].num_comments);
});

test("GitHub Trending：仓库、总星数、今日星数", () => {
  const items = parseGitHubTrending(fx("gh-trending.html"), T);
  assert.equal(items.length, 3);
  items.forEach(shape);
  for (const it of items) {
    assert.ok(it.fields.stars > 0 && it.fields.starsToday > 0);
    assert.equal(it.template, "number");
    assert.equal(it.focus, "starsToday");
  }
});

test("Product Hunt：标题、标语、链接", () => {
  const items = parseProductHunt(fx("ph.xml"), T);
  assert.equal(items.length, 3);
  items.forEach(shape);
  assert.ok(items.every((x) => x.url.startsWith("https://www.producthunt.com/")));
});

test("AIHOT：中文标题和信源数", () => {
  const raw = JSON.parse(fx("aihot.json"));
  const items = parseAIHOT(raw, T);
  assert.equal(items.length, raw.items.length);
  items.forEach(shape);
  assert.equal(items[0].fields.sourceCount, raw.items[0].sourceCount);
});

test("抓到的数字能过硬校验，编出来的数字被拦", () => {
  const [it] = parseGitHubTrending(fx("gh-trending.html"), T);
  assert.ok(buildSpoken("{{title}} 今天涨了 {{starsToday}} 颗星，总共 {{stars}}。", it.fields));
  assert.equal(buildSpoken(`{{title}} 今天涨了 ${it.fields.starsToday + 1} 颗星。`, it.fields), null);
});

test("一个源挂了，别的源照常出", async () => {
  const fake = async (url) => {
    if (url.includes("producthunt")) return new Response("x", { status: 503 });
    if (url.includes("hn.algolia")) return new Response(fx("hn.json"));
    if (url.includes("github.com")) return new Response(fx("gh-trending.html"));
    return new Response(fx("aihot.json"));
  };
  const r = await fetchAll({ fetchImpl: fake, now: T });
  assert.match(r.errors.producthunt, /503/);
  assert.equal(Object.keys(r.errors).length, 1);
  assert.ok(r.items.length >= 9);
});

test("去重和轮流排", () => {
  const a = parseHN(JSON.parse(fx("hn.json")), T);
  const b = parseAIHOT(JSON.parse(fx("aihot.json")), T);
  const fresh = dedupe([...a, ...a, ...b], new Set([a[0].id]));
  assert.equal(fresh.length, a.length - 1 + b.length);
  const mixed = interleave(fresh);
  assert.notEqual(mixed[0].source, mixed[1].source);
});
