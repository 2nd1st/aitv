import { test } from "node:test";
import assert from "node:assert/strict";
import { guardProblems } from "../scripts/guard.mjs";
import worker, { COMMIT } from "../src/worker.js";

const ok = { branch: "main", porcelain: "", head: "abc1234def", originMain: "abc1234def" };
test("部署闸门：只放行干净的 main 且 HEAD == origin/main", () => {
  assert.deepEqual(guardProblems(ok), []);
  assert.match(guardProblems({ ...ok, branch: "screen-v3" }).join(), /只能从 main/);
  assert.match(guardProblems({ ...ok, porcelain: " M screen/tv.js" }).join(), /工作区不干净/);
  assert.match(guardProblems({ ...ok, porcelain: "?? releases/x/seed.json" }).join(), /工作区不干净/);
  assert.match(guardProblems({ ...ok, originMain: "fff0000" }).join(), /≠ origin\/main/);
  assert.equal(guardProblems({ branch: "HEAD", porcelain: "x", head: "a", originMain: "b" }).length, 3);
});

test("/api/schedule 带 version、commit（Worker 构建时注入，测试里是 dev）和 releaseCommit（指针里记的）", async () => {
  const kv = new Map([["pointer", { version: "20261009-1227", previous: "20261009-1159", commit: "c0ffee1" }],
    ["seed:20261009-1227", { version: "20261009-1227", anchorMs: 1000, items: [{ id: "a", duration: 2, audio: "/audio/0123456789abcdef.mp3" }] }]]);
  const env = { SCHEDULE: { get: async (k) => kv.get(k) ?? null } };
  const res = await worker.fetch(new Request("https://x/api/schedule"), env);
  const body = await res.json();
  assert.equal(body.version, "20261009-1227");
  assert.equal(body.commit, COMMIT); assert.equal(COMMIT, "dev");
  assert.equal(body.releaseCommit, "c0ffee1");
  assert.equal(body.items.length, 1);
});
