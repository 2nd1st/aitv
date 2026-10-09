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
