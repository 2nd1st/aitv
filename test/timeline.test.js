import { test } from "node:test";
import assert from "node:assert/strict";
import { planTimeline, effective, fresh, LEAD_MS } from "../src/timeline.js";
import { locate, pick, adopt, nextBoundary } from "../public/timeline.js";
import { buildSchedule } from "../src/schedule.js";
import { scheduleBody } from "../src/worker.js";
import { addTakedown } from "../src/release.js";

const mk = (id, dur, extra = {}) => ({ id, audio: `/audio/${id.padEnd(16, "0").slice(0, 16)}.mp3`, duration: dur, ...extra });
const T0 = Date.UTC(2026, 9, 9, 4, 0, 0);
const base = [mk("a", 30), mk("b", 25), mk("c", 33), mk("d", 28), mk("e", 31)];
const tl0 = { current: { version: "v1", ...buildSchedule(base, T0) }, next: null, switchAt: null };

// 模拟一个客户端：openedAt 打开（拉一次），之后每 60 秒拉一次；serverAt(ms) 返回那一刻服务器给的接口内容
function client(openedAt, serverAt) {
  let state = adopt(serverAt(openedAt)), lastPoll = openedAt;
  return {
    at(ms) {
      while (lastPoll + 60_000 <= ms) { lastPoll += 60_000; state = adopt(serverAt(lastPoll)); }
      const s = pick(state, ms), { i, t } = locate(s, ms);
      return { id: s.items[i].id, t, version: s.version };
    },
  };
}
// 服务器：changeAt 之前是 tl0，之后是 tlNew；接口同 Worker 的 scheduleBody（这里直接用 effective）
const api = (tl) => (ms) => { const e = effective(tl, ms); return { version: e.current.version, ...e, ...e.current }; };
const serverWith = (changeAt, tlNew) => (ms) => api(ms < changeAt ? tl0 : tlNew)(ms);

test("提前量是 150 秒", () => assert.equal(LEAD_MS, 150_000));

test("nextBoundary：现在 + 150 秒之后的第一个条目边界", () => {
  const s = tl0.current;
  assert.equal(nextBoundary(s, T0 + 1), T0 + 30_000);
  assert.equal(nextBoundary(s, T0 + 30_000), T0 + 30_000);
  assert.equal(nextBoundary(s, T0 + s.total + 31_000), T0 + s.total + 55_000); // 跨循环
});

test("插入新条目：紧跟在 switchAt 那条之前（= 当前在播的后面），switchAt 在边界、>= now+90s", () => {
  const now = T0 + 40_000; // 正在播 b（30–55s）
  const p = planTimeline(tl0, now, { items: base, insert: [mk("new", 20)] });
  assert.ok(p.ok);
  const { switchAt, next } = p.timeline;
  assert.ok(switchAt >= now + LEAD_MS);
  assert.equal(switchAt, nextBoundary(tl0.current, now + LEAD_MS));
  assert.equal(locate(tl0.current, switchAt).t, 0); // 旧时间线在这一刻正好换条
  // 新时间线从 new 开始，然后接着旧时间线本该放的那条
  const upcomingOld = tl0.current.items[locate(tl0.current, switchAt).i].id;
  assert.deepEqual(next.items.slice(0, 2).map((x) => x.id), ["new", upcomingOld]);
  assert.equal(next.anchor, switchAt);
  assert.equal(next.items.length, 6);
});

test("两个模拟客户端（刚打开 / 已经听了 10 分钟）在插入前后：位置差 < 1 秒，谁都不在一条中间切", () => {
  const changeAt = T0 + 10 * 60_000 + 17_000; // 定时任务这一刻写入
  const p = planTimeline(tl0, changeAt, { items: base, insert: [mk("new", 20)] });
  const server = serverWith(changeAt, p.timeline);
  const A = client(changeAt + 5_000, server); // 刚打开（写入之后才打开，第一次就拿到 next）
  const B = client(T0, server);               // 10 分钟前就开着，只靠每 60 秒轮询拿到 next
  let prevA = null, prevB = null, sawNew = false;
  for (let ms = changeAt + 5_000; ms < changeAt + 8 * 60_000; ms += 250) {
    const a = A.at(ms), b = B.at(ms);
    assert.equal(a.id, b.id, `@${ms - changeAt}`);
    assert.ok(Math.abs(a.t - b.t) < 1, `位置差 ${a.t - b.t}`);
    for (const [prev, cur] of [[prevA, a], [prevB, b]]) {
      // 换条只能发生在边界：新条目从 ~0 开始，旧条目已经放到结尾
      if (prev && prev.id !== cur.id) { assert.ok(cur.t < 0.3, `新条从 ${cur.t}s 开始`); }
    }
    if (a.id === "new") sawNew = true;
    prevA = a; prevB = b;
  }
  assert.ok(sawNew);
});

test("switchAt 之前接口继续给旧时间线（带 next）；之后给新的", () => {
  const now = T0 + 5_000;
  const p = planTimeline(tl0, now, { items: base, insert: [mk("new", 20)] });
  const before = effective(p.timeline, p.timeline.switchAt - 1);
  assert.equal(before.current, tl0.current);
  assert.ok(before.next);
  const after = effective(p.timeline, p.timeline.switchAt);
  assert.equal(after.current.items[0].id, "new");
  assert.equal(after.next, null);
});

test("普通下架：switchAt 才生效，被删的跳过，之后接着原来的顺序；紧急 --now 立刻切", () => {
  const now = T0 + 10_000; // 正在播 a；+150s = 160s；边界 a0 b30 c55 d88 e116，一圈 147 → 第一个 >=160s 的是第二圈 b（177s）
  const items = base.filter((x) => x.id !== "e");
  const p = planTimeline(tl0, now, { items });
  assert.equal(p.timeline.switchAt, T0 + 177_000);
  assert.deepEqual(p.timeline.next.items.map((x) => x.id), ["b", "c", "d", "a"]); // e 被跳过，从 b 接着
  const em = planTimeline(tl0, now, { items: base.filter((x) => x.id !== "a"), emergency: true });
  assert.equal(em.timeline.next, null);
  assert.equal(em.timeline.current.anchor, now);
  assert.equal(locate(em.timeline.current, now).i, 0);
  assert.equal(em.timeline.current.items[0].id, "b"); // 正在播的 a 立刻被切掉
});

test("还有一个快到点的切换没生效：拒绝再排（等它过了再来）；离得远就替换掉 next、沿用同一个 switchAt", () => {
  const p = planTimeline(tl0, T0, { items: base, insert: [mk("n1", 20)] });
  const soon = planTimeline(p.timeline, p.timeline.switchAt - (LEAD_MS - 1_000), { items: base }); // 离生效不足 150 秒 → 拒
  assert.equal(soon.ok, false);
  assert.match(soon.reason, /150 秒/);
  assert.equal(soon.ok, false);
  const far = planTimeline(p.timeline, p.timeline.switchAt - LEAD_MS - 10_000, { items: base, insert: [mk("n2", 20)] });
  assert.ok(far.ok);
  assert.equal(far.timeline.switchAt, p.timeline.switchAt);
  assert.equal(far.timeline.current, tl0.current);
  assert.equal(far.timeline.next.items[0].id, "n2");
});

test("超过 6 小时的条目下线（没时间戳的种子条目保留）", () => {
  const now = T0;
  const xs = [mk("old", 20, { fetchedAt: now - 7 * 3600_000 }), mk("ok", 20, { fetchedAt: now - 3600_000 }), mk("seed", 20)];
  assert.deepEqual(fresh(xs, now).map((x) => x.id), ["ok", "seed"]);
});

test("Worker /api/schedule：{current,next,switchAt} + 兼容旧字段；下架条目到 effectiveAt 才过滤", async () => {
  const p = planTimeline(tl0, T0 + 10_000, { items: base.filter((x) => x.id !== "e") });
  const h = base[4].audio.slice(7, 23);
  const td = addTakedown(null, { hash: h, effectiveAt: p.timeline.switchAt });
  const kv = { pointer: { version: "v1" }, timeline: p.timeline, takedown: td };
  const env = { SCHEDULE: { get: async (k) => kv[k] ?? null } };
  const before = await scheduleBody(env, T0 + 20_000);
  assert.equal(before.switchAt, p.timeline.switchAt);
  assert.ok(before.items.some((x) => x.id === "e")); // 还没到 switchAt：旧时间线原样，不重排
  assert.deepEqual(before.items, before.current.items);
  assert.equal(before.anchor, T0);
  const after = await scheduleBody(env, p.timeline.switchAt + 1);
  assert.equal(after.next, null);
  assert.ok(!after.items.some((x) => x.id === "e"));
  // 紧急：effectiveAt 已过，current 里还在的立刻过滤
  const kv2 = { ...kv, timeline: tl0, takedown: addTakedown(null, { hash: h, effectiveAt: T0 }) };
  const em = await scheduleBody({ SCHEDULE: { get: async (k) => kv2[k] ?? null } }, T0 + 1);
  assert.ok(!em.items.some((x) => x.id === "e"));
});
