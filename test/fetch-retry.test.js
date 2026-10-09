import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchAll } from "../src/sources.js";

const html = readFileSync(new URL("./fixtures/gh-trending.html", import.meta.url), "utf8");
const noSleep = async () => {};

function seq(responses) {
  let n = 0;
  const fn = async () => {
    const r = responses[Math.min(n, responses.length - 1)];
    n++;
    if (r instanceof Error) throw r;
    return new Response(r.body ?? "", { status: r.status });
  };
  fn.calls = () => n;
  return fn;
}

test("GitHub 504 后重试成功", async () => {
  const f = seq([{ status: 504 }, { status: 200, body: html }]);
  const r = await fetchAll({ fetchImpl: f, only: ["github"], sleep: noSleep });
  assert.equal(f.calls(), 2);
  assert.ok(r.items.length > 0);
  assert.equal(r.errors.github, undefined);
});

test("超时也重试，三次都失败才记错误", async () => {
  const f = seq([new Error("The operation was aborted due to timeout")]);
  const r = await fetchAll({ fetchImpl: f, only: ["github"], sleep: noSleep });
  assert.equal(f.calls(), 3);
  assert.equal(r.items.length, 0);
  assert.match(r.errors.github, /timeout/);
});

test("404 不重试", async () => {
  const f = seq([{ status: 404 }]);
  const r = await fetchAll({ fetchImpl: f, only: ["github"], sleep: noSleep });
  assert.equal(f.calls(), 1);
  assert.equal(r.errors.github, "HTTP 404");
});
