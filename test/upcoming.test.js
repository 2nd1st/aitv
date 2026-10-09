// 底部「接下来」闪烁（乔布斯 2026-10-09）：相邻两帧算出来的接下来列表必须一样（除非中间真的跨过了一个条目边界）
import { test } from "node:test";
import assert from "node:assert/strict";
import { walk, locate, pick } from "../public/timeline.js";
import { buildSchedule } from "../src/schedule.js";
import { planTimeline } from "../src/timeline.js";

const durs = [37.6325, 41.0004, 29.9996, 33.3333, 52.5005, 18.4999, 44.7777];
const items = durs.map((duration, i) => ({ id: `i${i}`, audio: `/audio/${String(i).padStart(16, "a")}.mp3`, duration }));
const A = 1791520000123;
const cur = { version: "v1", ...buildSchedule(items, A) };
const ids = (l) => l.map((x) => x.id).join(",");

function boundaries(s, from, to) {
  const out = [];
  for (let k = Math.floor((from - s.anchor) / s.total) - 1; s.anchor + k * s.total <= to; k++) for (const it of s.items) out.push(s.anchor + k * s.total + (it.start - s.anchor));
  return out.filter((b) => b >= from && b <= to);
}

function sweep(state, from, to) {
  const s0 = pick(state, from), s1 = pick(state, to);
  const bs = [...new Set([...boundaries(s0, from, to), ...(s1 !== s0 ? boundaries(s1, from, to) : []), ...(state.switchAt ? [state.switchAt] : [])])];
  const times = [];
  for (const b of bs) for (const d of [-17, -2, -1, -0.5, 0, 0.5, 1, 2, 17]) times.push(b + d);
  for (let t = from; t < to; t += 997) times.push(t);
  let checked = 0;
  for (const t of times) {
    for (const frame of [1, 16.7]) {
      const crosses = bs.some((b) => b > t && b <= t + frame);
      if (crosses) continue;
      assert.equal(ids(walk(state, t + frame, 6)), ids(walk(state, t, 6)), `t=${t} 下一帧 +${frame}ms 列表变了`);
      checked++;
    }
    // 第一条就是此刻在播的那条，后面按顺序循环
    const s = pick(state, t), l = walk(state, t, 6);
    assert.equal(l[0].id, s.items[locate(s, t).i].id);
  }
  return checked;
}

test("单份节目单：扫很多时刻（含边界 ±1ms），相邻两帧接下来列表一样；顺序就是节目单循环顺序", () => {
  assert.ok(sweep({ current: cur, next: null, switchAt: null }, A - 5000, A + 3 * cur.total) > 500);
  const l = walk({ current: cur }, A + 1, 9);
  assert.equal(ids(l), "i0,i1,i2,i3,i4,i5,i6,i0,i1");
});

test("跨 switchAt：切换前后也不闪，切换后接的是 next 的条目", () => {
  const now = A + 10 * 60_000;
  const p = planTimeline({ current: cur, next: null, switchAt: null }, now, { version: "v2", items: items.slice(0, 4).reverse(), mode: "fresh" });
  const st = p.timeline;
  sweep(st, now, st.switchAt + 2 * st.next.total);
  const before = walk(st, st.switchAt - 1, 3);
  assert.equal(before[1].id, st.next.items[0].id);
});

test("条目边界上的那不到 1 毫秒的缝不再落回第 0 条", () => {
  const b = cur.items[3].start; // 前一条 duration*1000 不是整数
  assert.equal(locate(cur, b - 0.3).i, 2);
  assert.equal(locate(cur, b).i, 3);
});
