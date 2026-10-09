import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSeed, makeVersion, MIN_PLAYABLE } from "../src/release.js";
import worker from "../src/worker.js";

const V = "20261009-1130";
const good = (i) => ({
  id: `x-${i}`, source: "GitHub Trending", url: "https://github.com/a/b", kind: "project",
  fields: { title: "a / b", what: "w", who: "x" }, brief: { kind: "project", what: "w", who: "x", highlight: "h" },
  take: "t", script: [{}, {}, {}], audio: `/audio/${V}/x-${i}.mp3`, duration: 20,
  rounds: [{ part: "what" }, { part: "who" }, { part: "take" }],
});
const bytes = () => 50000;

test("版本号是东八区时间", () => {
  assert.equal(makeVersion(Date.UTC(2026, 9, 9, 3, 30)), "20261009-1130");
});

test("可播不到 15 条不切换；够了才行", () => {
  const few = { version: V, items: Array.from({ length: MIN_PLAYABLE - 1 }, (_, i) => good(i)) };
  const r = checkSeed(few, V, { audioBytes: bytes });
  assert.equal(r.ok, false);
  assert.match(r.errors.at(-1), /少于 15 条/);
  const enough = { version: V, items: Array.from({ length: MIN_PLAYABLE }, (_, i) => good(i)) };
  assert.equal(checkSeed(enough, V, { audioBytes: bytes }).ok, true);
});

test("缺音频、缺 part、带原文、kind 不一致、PH 有 rank，整批不通过", () => {
  const items = Array.from({ length: 16 }, (_, i) => good(i));
  items[0].audio = "/audio/old.mp3";
  items[1].rounds = [{ part: "what" }];
  items[2].materialText = "原文";
  items[3].kind = "news";
  items[4] = { ...items[4], source: "Product Hunt", fields: { ...items[4].fields, rank: 4 } };
  const r = checkSeed({ version: V, items }, V, { audioBytes: (p) => (p.includes("x-5") ? 0 : 50000) });
  assert.equal(r.ok, false);
  assert.equal(r.playable, 10);
  for (const k of ["x-0", "x-1", "x-2", "x-3", "x-4", "x-5"]) assert.ok(r.errors.some((e) => e.startsWith(k)), k);
});

test("/api/schedule 按 KV 指针读版本，并返回 version；没有指针返回 503", async () => {
  const seed = { anchorMs: 0, items: [good(0)] };
  const kv = { pointer: { version: V, previous: "20261009-1057" }, [`seed:${V}`]: seed };
  const env = { SCHEDULE: { get: async (k) => kv[k] ?? null } };
  const res = await worker.fetch(new Request("https://aitv.test/api/schedule"), env);
  const body = await res.json();
  assert.equal(body.version, V);
  assert.equal(body.items[0].kind, "project");
  assert.equal(body.items[0].audio, `/audio/${V}/x-0.mp3`);
  const none = await worker.fetch(new Request("https://aitv.test/api/schedule"), { SCHEDULE: { get: async () => null } });
  assert.equal(none.status, 503);
});

import { audioPathOk } from "../src/release.js";
test("音频地址：内容寻址和旧的按版本目录都认，别的版本目录不认", () => {
  assert.ok(audioPathOk("/audio/0123456789abcdef.mp3", "20261009-1200"));
  assert.ok(audioPathOk("/audio/20261009-1200/hn-1.mp3", "20261009-1200"));
  assert.ok(!audioPathOk("/audio/20261009-1133/hn-1.mp3", "20261009-1200"));
  assert.ok(!audioPathOk("/seeds/20261009-1200/audio/hn-1.mp3", "20261009-1200"));
});

import { applyTakedown, addTakedown, removeTakedown, migrateTakedown, takedownMatches, isVoid, markVoid, planRollback } from "../src/release.js";
import { scriptHash } from "../src/scripthash.js";
import { readFileSync } from "node:fs";

test("下架按稿子 hash：旧稿子被拦，同一个 id 换了新稿子照常播；旧版地址照样拦", () => {
  const items = [{ id: "a", audio: "/audio/aaaaaaaaaaaaaaaa.mp3" }, { id: "b", audio: "/audio/bbbbbbbbbbbbbbbb.mp3" }, { id: "c", audio: "/audio/20261009-1133/c.mp3" }];
  let td = addTakedown(null, { hash: "bbbbbbbbbbbbbbbb", id: "b" });
  td = addTakedown(td, { audio: "/audio/20261009-1133/c.mp3", id: "c" });
  assert.deepEqual(applyTakedown(items, td).map((i) => i.id), ["a"]);
  assert.equal(td.refs.bbbbbbbbbbbbbbbb, "b");
  // 同一个 id，改写后的新稿子（新 hash）照常播
  assert.deepEqual(applyTakedown([{ id: "b", audio: "/audio/cccccccccccccccc.mp3" }], td).length, 1);
  // 别的 id 用了同一版稿子（同 hash）照样拦
  assert.deepEqual(applyTakedown([{ id: "b-renamed", audio: "/audio/bbbbbbbbbbbbbbbb.mp3" }], td), []);
  td = removeTakedown(td, { hash: "bbbbbbbbbbbbbbbb" });
  assert.equal(applyTakedown(items, td).length, 2);
  assert.throws(() => addTakedown(null, { hash: "AnyPS5" }));
});

test("旧格式（按 id）迁移成按 hash：id 不再拦", () => {
  const old = { ids: ["gh-boykopovar/AnyPS5"], audio: ["/audio/20261009-1057/gh-boykopovar-AnyPS5.mp3", "/audio/37075b5af4251b3e.mp3"] };
  const t = migrateTakedown(old);
  assert.deepEqual(t.hashes, ["37075b5af4251b3e"]);
  assert.deepEqual(t.audio, ["/audio/20261009-1057/gh-boykopovar-AnyPS5.mp3"]);
  assert.equal(t.refs["37075b5af4251b3e"], "gh-boykopovar/AnyPS5");
  assert.ok(!("ids" in t));
  assert.equal(takedownMatches(old, { id: "gh-boykopovar/AnyPS5", audio: "/audio/1111111111111111.mp3" }), false);
  assert.equal(takedownMatches(old, { id: "x", audio: "/audio/37075b5af4251b3e.mp3" }), true);
});

test("作废：use / rollback 都不切到作废版本；回滚计划 dry-run", () => {
  const ptr = markVoid({ version: "20261009-1227", previous: "20261009-1159" }, ["20261009-1159"], "含已下架条目 gh-boykopovar/AnyPS5");
  assert.ok(isVoid(ptr, "20261009-1159")); assert.ok(!isVoid(ptr, "20261009-1227"));
  const plan = planRollback(ptr);
  assert.equal(plan.ok, false); assert.match(plan.reason, /已作废/);
  assert.equal(planRollback({ version: "x", previous: "y" }).ok, true);
  assert.equal(planRollback({ version: "x" }).ok, false);
});

test("模拟：即使指针被切回 20261009-1159，/api/schedule 也不播 AnyPS5，且开始时间连续、总长变短", async () => {
  const seed = JSON.parse(readFileSync(new URL("../releases/20261009-1159/seed.json", import.meta.url)));
  const id = "gh-boykopovar/AnyPS5";
  const any = seed.items.find((i) => i.id === id);
  assert.ok(any, "1159 里确实有 AnyPS5");
  const kv = new Map([["pointer", { version: "20261009-1159" }], ["seed:20261009-1159", seed], ["takedown", addTakedown(null, { audio: any.audio, id })]]);
  const env = { SCHEDULE: { get: async (k) => kv.get(k) ?? null } };
  const body = await (await worker.fetch(new Request("https://x/api/schedule"), env)).json();
  assert.equal(body.version, "20261009-1159");
  assert.equal(body.items.length, seed.items.length - 1);
  assert.ok(!JSON.stringify(body).includes("AnyPS5"));
  let t = body.anchor;
  for (const it of body.items) { assert.equal(it.start, t); t += Math.round(it.duration * 1000); }
  assert.equal(body.total, t - body.anchor);
  const full = seed.items.reduce((a, i) => a + Math.round(i.duration * 1000), 0);
  assert.equal(body.total, full - Math.round(any.duration * 1000));
});

test("稿子 hash 跟音频文件名（Python audio_key）一致；AnyPS5 改写后的新稿子同 id 可以回来", async () => {
  const seed = JSON.parse(readFileSync(new URL("../releases/20261009-1159/seed.json", import.meta.url)));
  for (const it of seed.items) assert.equal(`/audio/${await scriptHash(it.script.map((p) => p.text))}.mp3`, it.audio, it.id);
  const any = seed.items.find((i) => i.id === "gh-boykopovar/AnyPS5");
  const td = migrateTakedown({ ids: [any.id], audio: [any.audio] });
  const rewritten = [any.script[0].text, any.script[1].text, "这条只做报道，不建议去试。"];
  const h2 = await scriptHash(rewritten);
  assert.notEqual(`/audio/${h2}.mp3`, any.audio);
  assert.equal(applyTakedown([{ ...any }], td).length, 0);
  assert.equal(applyTakedown([{ ...any, audio: `/audio/${h2}.mp3` }], td).length, 1);
});
