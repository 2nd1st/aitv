// 生成 Android 单测用的时间线对照数据：用网页端真实的 public/timeline.js 算一遍，Kotlin 版必须逐条一致。
//   node android/scripts/timeline-fixture.mjs
import { writeFileSync } from "node:fs";
import { locate, pick, walk } from "../../public/timeline.js";
import { buildSchedule } from "../../src/schedule.js";
import { planTimeline } from "../../src/timeline.js";

const durs = [37.6325, 41.0004, 29.9996, 33.3333, 52.5005, 18.4999, 44.7777];
const items = durs.map((duration, i) => ({ id: `i${i}`, audio: `/audio/${String(i).padStart(16, "a")}.mp3`, duration }));
const A = 1791520000123;
const cur = { version: "v1", ...buildSchedule(items, A) };
const now = A + 10 * 60_000;
const switched = planTimeline({ current: cur, next: null, switchAt: null }, now, { version: "v2", items: items.slice(0, 4).reverse(), mode: "fresh" }).timeline;

function times(state, from, to) {
  const out = [];
  for (const s of [state.current, state.next].filter(Boolean)) {
    for (let k = Math.floor((from - s.anchor) / s.total) - 1; s.anchor + k * s.total <= to; k++) {
      for (const it of s.items) {
        const b = s.anchor + k * s.total + (it.start - s.anchor);
        if (b >= from && b <= to) for (const d of [-17, -1, -0.3, 0, 0.5, 1, 17]) out.push(b + d);
      }
    }
  }
  if (state.switchAt) for (const d of [-1, 0, 1]) out.push(state.switchAt + d);
  for (let t = from; t < to; t += 7919) out.push(t);
  return out;
}

const cases = [];
for (const [name, state, from, to] of [
  ["single", { current: cur, next: null, switchAt: null }, A - 5000, A + 2 * cur.total],
  ["switch", switched, now, switched.switchAt + switched.next.total],
]) {
  const queries = times(state, from, to).map((t) => {
    const s = pick(state, t), p = locate(s, t);
    return { t, version: s.version, i: p.i, pos: p.t, walk: walk(state, t, 6).map((x) => x.id) };
  });
  cases.push({ name, state, queries });
}
writeFileSync(new URL("../app/src/test/resources/timeline-fixture.json", import.meta.url), JSON.stringify({ cases }));
console.log(cases.map((c) => `${c.name}: ${c.queries.length} queries`).join(", "));
