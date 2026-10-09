import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSeed, makeVersion, MIN_PLAYABLE } from "../src/release.js";
import worker from "../src/worker.js";

const V = "20261009-1130";
const good = (i) => ({
  id: `x-${i}`, source: "GitHub Trending", url: "https://github.com/a/b", kind: "project",
  fields: { title: "a / b", what: "w", who: "x" }, brief: { kind: "project", what: "w", who: "x", highlight: "h" },
  take: "t", script: [{}, {}, {}], audio: `/seeds/${V}/audio/x-${i}.mp3`, duration: 20,
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

test("/api/schedule 按线上指针读版本，并返回 version", async () => {
  const seed = { version: V, anchorMs: 0, items: [good(0)] };
  const files = { "/current.json": { version: V, previous: "20261009-1057" }, [`/seeds/${V}/seed.json`]: seed };
  const env = { ASSETS: { fetch: async (u) => { const p = new URL(u).pathname; return p in files ? Response.json(files[p]) : new Response("", { status: 404 }); } } };
  const res = await worker.fetch(new Request("https://aitv.test/api/schedule"), env);
  const body = await res.json();
  assert.equal(body.version, V);
  assert.equal(body.items[0].kind, "project");
  assert.equal(body.items[0].audio, `/seeds/${V}/audio/x-0.mp3`);
});
