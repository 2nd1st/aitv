import test from "node:test";
import assert from "node:assert/strict";
import { buildSpoken, checkTemplate } from "../src/validate.js";
import { buildSchedule, locate } from "../src/schedule.js";

const fields = { title: "Hy4 preview", points: 812, comments: 233 };

test("正确的模板通过", () => {
  assert.equal(buildSpoken("{{title}}，{{points}} 分，{{comments}} 条评论", fields), "Hy4 preview，812 分，233 条评论");
});
test("故意塞阿拉伯数字，整条被拦下", () => {
  assert.equal(buildSpoken("{{title}}，{{points}} 分，超过 9000 人在讨论", fields), null);
});
test("中文数字绕不过去", () => {
  assert.equal(buildSpoken("{{title}}，超过九千人在讨论", fields), null);
  assert.equal(buildSpoken("{{title}}，热度涨了三倍", fields), null);
  assert.equal(buildSpoken("{{title}}，翻了两番", fields), null);
});
test("字段对调被拦下：单位绑死在字段上", () => {
  assert.equal(buildSpoken("{{comments}} 分，{{points}} 条评论", fields), null);
  assert.ok(checkTemplate("{{comments}} 分", fields).errors[0].includes("条评论"));
});
test("引用不存在或没绑单位的字段，整条被拦下", () => {
  assert.equal(buildSpoken("{{stars}} 颗星", fields), null);
  assert.equal(buildSpoken("{{x}}", { x: 5 }), null);
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
