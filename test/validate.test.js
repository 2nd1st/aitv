import test from "node:test";
import assert from "node:assert/strict";
import { buildSpoken, checkNumbers } from "../src/validate.js";
import { buildSchedule, locate } from "../src/schedule.js";

const fields = { title: "Hy4 preview", points: 812, comments: 233 };

test("正确的稿子通过", () => {
  assert.equal(buildSpoken("{{title}}，{{points}} 分，{{comments}} 条评论", fields), "Hy4 preview，812 分，233 条评论");
});
test("故意塞错数字，整条被拦下", () => {
  assert.equal(buildSpoken("{{title}}，{{points}} 分，超过 9000 人在讨论", fields), null);
  assert.deepEqual(checkNumbers("812 分，9000 人", fields).bad, ["9000"]);
});
test("引用不存在的字段，整条被拦下", () => {
  assert.equal(buildSpoken("{{stars}} 星", fields), null);
});
test("节目单连续无空档，缺音频的跳过，播完循环", () => {
  const s = buildSchedule([
    { id: "a", audio: "a.mp3", duration: 10 },
    { id: "b", audio: null, duration: 10 },
    { id: "c", audio: "c.mp3", duration: 5 },
  ], 1000);
  assert.equal(s.items.length, 2);
  assert.equal(s.items[1].start, 11000);
  assert.deepEqual(locate(s, 1000 + 12000), { index: 1, t: 2 });
  assert.deepEqual(locate(s, 1000 + 15000 + 3000), { index: 0, t: 3 });
});
