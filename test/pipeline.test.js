import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runCron, advance, dropOld, planInsert, planPublish, tagParts, firstSentence } from "../src/pipeline.js";
import { planTimeline } from "../src/timeline.js";
import { mp3Duration } from "../src/mp3.js";
import { scriptHash } from "../src/scripthash.js";
import { addTakedown } from "../src/release.js";
import { buildSchedule } from "../src/schedule.js";
import { effective, locate } from "../src/timeline.js";
import { capKey } from "../src/ttscap.js";

const GH = readFileSync(new URL("./fixtures/gh-trending.html", import.meta.url), "utf8");
const ID = "gh-cathrynlavery/diagram-design";
const T0 = Date.UTC(2026, 9, 9, 5, 0, 0);

// 假 mp3：n 帧 MPEG2 Layer III 24kHz 64kbps（每帧 192 字节、0.024 秒）
const fakeMp3 = (n = 1000) => { const b = new Uint8Array(192 * n); for (let i = 0; i < n; i++) b.set([0xff, 0xf3, 0x84, 0x00], i * 192); return b; };

const BRIEF = { safety: "ok", safetyReason: "", kind: "project", name: "cathrynlavery / diagram-design",
  what: "一个给 AI 编程助手用的图表技能，生成自包含的 HTML 加 SVG 编辑级图表，还能重绘别的图表源。",
  who: "写文档、做架构图的人，尤其是用 AI 助手画图却总得到通用圆角框的人。",
  highlight: "图表类型丰富，静态输出是默认，可选动效，作者强调每个节点都要有意义。",
  limit: "官方构建只来自该仓库，其他名字的插件列表是非官方副本；动效是可选的，静态才是默认。" };
const SCRIPT = {
  part1: "{{name}} 是给 AI 编程助手用的图表技能，生成自包含的 HTML 加 SVG 编辑级图表，还能重绘别的图表源。图表类型丰富，静态输出是默认，作者强调每个节点都要有意义。",
  part2: "写文档、做架构图的人，尤其用 AI 助手画图却总得到通用圆角框的，可以用它生成可编辑图表。官方构建只来自该仓库，其他名字的插件列表是非官方副本，下载前先确认来源。",
  part3: "拿它重绘现有文档里的架构图，对比输出是否比通用圆角框更贴切；动效是可选的，静态才是默认，按需开启。",
};
const README = "# diagram-design\n\n" + "Editorial diagram design skill for coding agents. Produces self-contained HTML and SVG diagrams. ".repeat(6);

function memKV(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => { m.delete(k); } };
}
function memR2(init = {}) {
  const m = new Map(Object.entries(init));
  const obj = (v) => ({ arrayBuffer: async () => (typeof v === "string" ? new TextEncoder().encode(v).buffer : v.buffer.slice(0)), json: async () => JSON.parse(typeof v === "string" ? v : new TextDecoder().decode(v)) });
  return { m, head: async (k) => (m.has(k) ? { key: k } : null), get: async (k) => (m.has(k) ? obj(m.get(k)) : null), put: async (k, v) => { m.set(k, v); } };
}
// 15 条在播（点评开头各不相同），给插入用
const onAir = Array.from({ length: 15 }, (_, i) => ({ id: `x${i}`, audio: `/audio/${String(i).padStart(16, "a")}.mp3`, duration: 30, take: `${"甲乙丙丁戊己庚辛壬癸子丑寅卯辰"[i]}号点评内容` }));
const TL = { current: { version: "v1", ...buildSchedule(onAir, T0 - 3600_000) }, next: null, switchAt: null };

function deps({ now = T0, kv = memKV({ timeline: TL, "pipe:index": { seen: ["gh-boykopovar/AnyPS5"] } }), r2 = memR2(), script = SCRIPT, briefFail = 0, ttsFail = 0, ttsCap = 40, rewrite = "不妨先拿它重绘现有文档里的架构图，对比输出是否比通用圆角框更贴切；" } = {}) {
  const calls = { readme: 0, brief: 0, script: 0, tts: 0 };
  let bf = briefFail, tf = ttsFail;
  return { calls, kv, r2, d: {
    now, kv, r2, ttsCap,
    fetch: async (url) => {
      url = String(url);
      if (url.includes("github.com/trending")) return new Response(GH);
      if (url.includes("raw.githubusercontent.com/cathrynlavery/diagram-design")) { calls.readme++; return new Response(README); }
      return new Response("nope", { status: 404 });
    },
    briefLLM: async (p) => { calls.brief++; if (bf-- > 0) throw new Error("DeepSeek 503"); return /title_zh/.test(p) ? "{}" : JSON.stringify(BRIEF); },
    scriptLLM: async (p) => { if (/"first"/.test(p)) { calls.rewrite = (calls.rewrite || 0) + 1; return JSON.stringify({ first: rewrite }); } calls.script++; return JSON.stringify(script); },
    tts: async (payload) => { calls.tts++; if (tf-- > 0) throw new Error("豆包 500");
      return { audio: fakeMp3(), rounds: payload.nlp_texts.map((x, i) => ({ text: x.text, start_time: i * 8, end_time: i * 8 + 8 })) }; },
  } };
}

test("mp3Duration：按帧头累加；tagParts 三段一一对应", () => {
  assert.equal(Math.round(mp3Duration(fakeMp3(1000)) * 1000), 24000);
  assert.deepEqual(tagParts([{ text: "a" }, { text: "b" }, { text: "c" }], ["a", "b", "c"]).map((r) => r.part), ["what", "who", "take"]);
});

test("一轮跑完：抓 → 读原文 → brief → 稿 → 校验 → 合成 → R2；自动上线关闭时线上时间线不动，只记计划", async () => {
  const { d, kv, r2, calls } = deps();
  const out = await runCron(d, { autoPublish: false });
  const st = await kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "ready", JSON.stringify(st.errors));
  assert.deepEqual(Object.keys(st.results), ["read", "brief", "script", "validate", "tts"]);
  const hash = await scriptHash(st.results.script.lines);
  assert.equal(st.seedItem.audio, `/audio/${hash}.mp3`);
  assert.ok(r2.m.has(`${hash}.mp3`) && r2.m.has(`${hash}.json`));
  assert.equal(st.seedItem.kind, "project");
  assert.ok(!("lines" in st.seedItem) && !JSON.stringify(st.seedItem).includes("Editorial diagram design skill")); // 原文不进条目
  assert.equal(calls.tts, 1);
  assert.equal((await kv.get(capKey(T0))).count, 1);
  assert.deepEqual(await kv.get("timeline"), TL); // 没上线
  assert.ok(out.plan.switchAt >= T0 + 150_000 && out.plan.count === 16, JSON.stringify(out.plan));
  // 每天最多开一条：第二轮不再抓新的
  const again = await runCron({ ...d, now: T0 + 15 * 60_000 }, {});
  assert.ok(!again.log.some((l) => l.startsWith("新条目")));
});

test("断点续跑：brief 这步模型挂了，下一轮从 brief 接着跑，不重新读原文", async () => {
  const x = deps({ briefFail: 1 }); // 模型出错 enrich 直接返回 → 这一轮停在 brief
  await runCron(x.d, {});
  let st = await x.kv.get(`pipe:item:${ID}`);
  assert.equal(st.step, "brief");
  assert.equal(st.status, "pending");
  assert.ok(st.results.read.text.length > 200);
  assert.equal(x.calls.readme, 1);
  await runCron({ ...x.d, now: T0 + 15 * 60_000 }, {});
  st = await x.kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "ready");
  assert.equal(x.calls.readme, 1); // 没再读原文
});

test("每日额度：用完了就等（不调豆包）；同一条一天最多试两次（一次重试），第二天再来", async () => {
  const capped = deps({ ttsCap: 0 });
  await runCron(capped.d, {});
  let st = await capped.kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "waiting"); assert.match(st.why, /额度/); assert.equal(capped.calls.tts, 0);

  const x = deps({ ttsFail: 5 });
  await runCron(x.d, {});                                  // 第 1 次：失败
  await runCron({ ...x.d, now: T0 + 15 * 60_000 }, {});    // 第 2 次（重试）：失败
  await runCron({ ...x.d, now: T0 + 30 * 60_000 }, {});    // 第 3 次：今天试够了，不调
  st = await x.kv.get(`pipe:item:${ID}`);
  assert.equal(x.calls.tts, 2);
  assert.equal(st.status, "waiting"); assert.match(st.why, /试过 2 次/);
  await runCron({ ...x.d, now: T0 + 24 * 3600_000 }, {});  // 第二天：又能试（还是失败 → 累计 3 次）
  assert.equal(x.calls.tts, 3);
  await runCron({ ...x.d, now: T0 + 24 * 3600_000 + 15 * 60_000 }, {}); // 累计失败 4 次 → 丢
  st = await x.kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "dropped");
});

test("内容寻址：R2 里已有这份稿子的音频就不调豆包、不占额度", async () => {
  const lines = [SCRIPT.part1.replace("{{name}}", BRIEF.name), SCRIPT.part2, SCRIPT.part3];
  const h = await scriptHash(lines);
  const x = deps({ r2: memR2({ [`${h}.mp3`]: fakeMp3(), [`${h}.json`]: JSON.stringify(lines.map((text, i) => ({ text, start_time: i, end_time: i + 1 }))) }) });
  await runCron(x.d, {});
  const st = await x.kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "ready"); assert.equal(st.results.tts.cached, true);
  assert.equal(x.calls.tts, 0); assert.equal(await x.kv.get(capKey(T0)), null);
});

test("下架按稿子 hash：同一份稿子丢掉；同一个 id 写出新稿子照常通过（不按 id 跳过）", async () => {
  const lines = [SCRIPT.part1.replace("{{name}}", BRIEF.name), SCRIPT.part2, SCRIPT.part3];
  const td = addTakedown(null, { hash: await scriptHash(lines), id: ID });
  const blocked = deps({ kv: memKV({ timeline: TL, takedown: td, "pipe:index": { seen: ["gh-boykopovar/AnyPS5"] } }) });
  await runCron(blocked.d, {});
  let st = await blocked.kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "dropped"); assert.match(st.why, /下架名单/); assert.equal(blocked.calls.tts, 0);

  const rewritten = deps({ kv: memKV({ timeline: TL, takedown: td, "pipe:index": { seen: ["gh-boykopovar/AnyPS5"] } }),
    script: { ...SCRIPT, part3: "拿它重绘现有文档里的架构图，对比输出是否比通用圆角框更贴切；动效默认关闭，需要时再打开。" } });
  await runCron(rewritten.d, {});
  st = await rewritten.kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "ready", st.why);
});

test("自动上线打开：插在当前在播那条后面，switchAt 在边界且 >= now+150s，现在播的不受影响", async () => {
  const x = deps();
  await runCron(x.d, { autoPublish: true });
  const tl = await x.kv.get("timeline");
  assert.ok(tl.next && tl.switchAt >= T0 + 150_000);
  assert.equal(tl.current.anchor, TL.current.anchor);
  assert.equal(tl.next.items[0].id, ID);
  assert.equal(tl.next.items.length, 16);
  assert.equal(locate(TL.current, tl.switchAt).t, 0);
  const st = await x.kv.get(`pipe:item:${ID}`);
  assert.equal(st.status, "published");
  assert.equal(effective(tl, tl.switchAt).current.items[0].id, ID);
});

const ago = (h) => T0 - h * 3600_000;
const aged = (n, h, p = "o") => Array.from({ length: n }, (_, i) => ({ id: `${p}${h}-${i}`, audio: `/audio/${(p + h + "x" + i).padEnd(16, "0").slice(0, 16)}.mp3`, duration: 20, fetchedAt: ago(h) }));

test("超龄：6 小时内全留；不足 15 条用 6–12 小时的补（越新越先）；超过 12 小时一律下线", () => {
  assert.equal(dropOld([...aged(16, 1), ...aged(5, 7)], T0).length, 16);                 // 6 小时内够 15，超龄的全下
  const f = dropOld([...aged(10, 1), ...aged(3, 7), ...aged(4, 9)], T0);                  // 10 + 补 5（先 7 小时的 3 条，再 9 小时的 2 条）
  assert.equal(f.length, 15);
  assert.equal(f.filter((x) => x.id.startsWith("o7")).length, 3);
  assert.equal(f.filter((x) => x.id.startsWith("o9")).length, 2);
  assert.equal(dropOld([...aged(3, 1), ...aged(20, 13)], T0).length, 3);                // 超过 12 小时的不当补位，哪怕只剩 3 条
});

test("边界：全部超过 12 小时 → 不出空节目单，保留最新的那一批（keptStale）", () => {
  const out = dropOld([...aged(4, 13), ...aged(2, 20)], T0);
  assert.equal(out.length, 4); assert.equal(out.keptStale, true);
});

test("15 条门槛不挡新条目：只有 5 条在播也照样插", () => {
  const small = { current: { version: "v", ...buildSchedule(onAir.slice(0, 5), T0) }, next: null, switchAt: null };
  const it = { ...onAir[0], id: "new", audio: "/audio/ffffffffffffffff.mp3", take: "全新的点评开头" };
  const p = planPublish(small, T0, { newItem: it });
  assert.ok(p.ok, p.reason); assert.equal(p.count, 6); assert.deepEqual(p.inserted, ["new"]);
});

// T0 时正在播第 0 条（写稿时的上一条点评，开头不同）；切换点前后的邻居点评都以「拿它重」开头
const clashTL = { current: { version: "v1", ...buildSchedule(onAir.map((x, i) => ({ ...x, take: i === 0 ? "甲号点评内容" : "拿它重新看一遍" })), T0 - 3600_000) }, next: null, switchAt: null };
test("点评开头跟邻居撞：改写第一句 → 重新校验 → 重新合成（占额度）→ 当轮上线", async () => {
  const x = deps({ kv: memKV({ timeline: clashTL, "pipe:index": { seen: ["gh-boykopovar/AnyPS5"] } }) });
  const out = await runCron(x.d, { autoPublish: true });
  const tl = await x.kv.get("timeline");
  assert.equal(x.calls.rewrite, 1, JSON.stringify(out.log));
  assert.equal(x.calls.tts, 2);                              // 原稿一次 + 改写后一次
  assert.equal((await x.kv.get(capKey(T0))).count, 2);
  assert.equal(tl.next.items[0].id, ID, JSON.stringify(out.log));
  assert.match(tl.next.items[0].take, /^不妨先/);
});

test("改写一条一天只试一次：改了还撞就先不上，同一天不再改；插回 / 下线照做", async () => {
  const x = deps({ kv: memKV({ timeline: clashTL, "pipe:index": { seen: ["gh-boykopovar/AnyPS5"] } }), rewrite: "拿它重新画一遍现有文档里的架构图；" });
  await runCron(x.d, { autoPublish: true });
  assert.equal(x.calls.rewrite, 1);
  assert.deepEqual(await x.kv.get("timeline"), clashTL);
  assert.equal((await x.kv.get("pipe:index")).ready[0], ID);
  await runCron({ ...x.d, now: T0 + 15 * 60_000 }, { autoPublish: true });
  assert.equal(x.calls.rewrite, 1);                          // 同一天不再改
  await runCron({ ...x.d, now: T0 + 24 * 3600_000 }, { autoPublish: true, maxNewPerDay: 0 });
  assert.equal(x.calls.rewrite, 2);                          // 第二天可以再改一次
});

test("use / rollback 之后：下一轮把 6 小时内、没下架的已上线条目插回来，零合成", async () => {
  const x = deps();
  await runCron(x.d, { autoPublish: true });
  assert.equal((await x.kv.get("pipe:item:" + ID)).status, "published");
  const tts0 = x.calls.tts, cap0 = (await x.kv.get(capKey(T0))).count;
  // 模拟 release.mjs use：换成一个不含新条目的版本（fresh），switchAt 过后生效
  const t1 = T0 + 20 * 60_000;
  const used = planTimeline(await x.kv.get("timeline"), t1, { version: "v2", items: onAir, mode: "fresh" }).timeline;
  await x.kv.put("timeline", used);
  const t2 = used.switchAt + 60_000;
  const out = await runCron({ ...x.d, now: t2 }, { autoPublish: true, maxNewPerDay: 1 });
  const tl = await x.kv.get("timeline");
  assert.deepEqual(out.plan.reinserted, [ID], JSON.stringify(out.log));
  assert.ok(tl.next.items.some((i) => i.id === ID));
  assert.ok(tl.switchAt >= t2 + 150_000);
  assert.equal(x.calls.tts, tts0);                            // 没有新合成
  assert.equal((await x.kv.get(capKey(T0))).count, cap0);
  // 已经在时间线里了：再跑一轮不重复插
  const again = await runCron({ ...x.d, now: tl.switchAt + 60_000 }, { autoPublish: true });
  assert.ok(!(again.plan?.reinserted || []).length);
});

test("插回只插 6 小时内、没下架的", async () => {
  const x = deps();
  await runCron(x.d, { autoPublish: true });
  const st = await x.kv.get("pipe:item:" + ID);
  const used = { current: { version: "v2", ...buildSchedule(onAir, T0) }, next: null, switchAt: null };
  await x.kv.put("timeline", used);
  const late = await runCron({ ...x.d, now: st.seedItem.fetchedAt + 6 * 3600_000 + 60_000 }, { autoPublish: true, maxNewPerDay: 0 });
  assert.ok(!(late.plan?.reinserted || []).includes(ID));
  await x.kv.put("timeline", used);
  await x.kv.put("takedown", addTakedown(null, { audio: st.seedItem.audio }));
  const td = await runCron({ ...x.d, now: T0 + 3600_000 }, { autoPublish: true, maxNewPerDay: 0 });
  assert.ok(!(td.plan?.reinserted || []).includes(ID));
});

test("firstSentence 只取第一句", () => assert.equal(firstSentence("甲乙；丙丁。"), "甲乙；"));
