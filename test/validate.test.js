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

test("正常稿子里的「一句话点评」能通过：白名单词先去掉再查", () => {
  assert.equal(buildSpoken("一句话点评：{{title}} 是一个十分顺手的工具，唯一要做的就是今天试一下。", fields),
    "一句话点评：Hy4 preview 是一个十分顺手的工具，唯一要做的就是今天试一下。");
  // 白名单之外的「一」照样拦
  assert.equal(buildSpoken("{{title}} 是新一代工具", fields), null);
  assert.equal(buildSpoken("{{title}}，一键安装", fields), null);
});
test("what / who / highlight 是文本字段，可以原样插入", () => {
  const f = { what: "一个画图技能", who: "开发者", highlight: "风格统一" };
  assert.equal(buildSpoken("{{what}}，给{{who}}用，{{highlight}}。", f), "一个画图技能，给开发者用，风格统一。");
});
