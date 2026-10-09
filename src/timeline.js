// 时间线（迪恩的全局时钟安全）：KV "timeline" = { current: sched, next: sched|null, switchAt: ms|null }。
// - 每次换节目单（切版本、下架重排、定时任务插新条、超过 6 小时的条目下线）都算一个 switchAt：
//   「现在 + 90 秒」之后的第一个条目边界。到 switchAt 之前服务器继续给旧时间线（同时带上 next），
//   客户端每 60 秒拉一次，一定能在 switchAt 之前拿到 next，到点按同一个时钟一起换，谁都不会在一条中间被切。
// - 紧急下架（--now）：立刻换，哪怕切断正在播的那条。
// - 续播：新时间线从「switchAt 那一刻本该开始的那条」接着排（被删的跳过），定时任务的新条目插在它前面
//   （= 紧跟在当前正在播的那条后面）。
import { locate, pick, nextBoundary } from "../public/timeline.js";
import { buildSchedule } from "./schedule.js";
export { locate, pick, nextBoundary };

export const LEAD_MS = 90_000;
export const MAX_AGE_MS = 6 * 3600_000;
const keyOf = (it) => `${it.id}|${it.audio}`;

// 读的时候用：此刻的 { current, next, switchAt }（switchAt 过了就把 next 当 current）
export function effective(tl, nowMs) {
  if (!tl?.current) return null;
  if (tl.next && tl.switchAt != null && nowMs >= tl.switchAt) return { current: tl.next, next: null, switchAt: null };
  return { current: tl.current, next: tl.next || null, switchAt: tl.next ? tl.switchAt : null };
}

// 规划一次切换。
//   items：新时间线里要有的条目（已过滤下架 / 超龄）；insert：要插在最前面的新条目
//   mode："continue" 按旧时间线的顺序接着播；"fresh" 新版本从它自己的第一条开始
//   emergency：立刻生效（从正在播的那条之后接着排，正在播的被切掉）
// 返回 { ok, timeline } 或 { ok: false, reason }
export function planTimeline(tl, nowMs, { version, items, insert = [], mode = "continue", emergency = false, lead = LEAD_MS } = {}) {
  const eff = effective(tl, nowMs);
  if (eff?.next && !emergency && eff.switchAt - nowMs < lead) {
    return { ok: false, reason: `上一次切换（${new Date(eff.switchAt).toISOString()}）还没到，离现在不足 ${lead / 1000} 秒，等它过了再来` };
  }
  // 有待生效的 next 且离 switchAt 还够远：直接替换掉它，沿用同一个 switchAt（边界属于 current）
  const base = eff?.current || null;
  let switchAt, upcoming;
  if (!base) { switchAt = nowMs; upcoming = 0; }
  else if (emergency) {
    switchAt = nowMs;
    upcoming = (locate(base, nowMs).i + 1) % base.items.length;
  } else {
    switchAt = eff.next ? eff.switchAt : nextBoundary(base, nowMs + lead);
    upcoming = locate(base, switchAt).i; // switchAt 是边界：这就是那一刻要开始的那条
  }
  const wanted = new Map(items.map((it) => [keyOf(it), it]));
  let order = [];
  if (mode === "continue" && base) {
    const n = base.items.length;
    for (let k = 0; k < n; k++) {
      const it = base.items[(upcoming + k) % n];
      const w = wanted.get(keyOf(it));
      if (w) { order.push(w); wanted.delete(keyOf(it)); }
    }
  }
  order.push(...wanted.values()); // fresh：全部按给定顺序；continue：旧时间线里没有的排在后面
  const ins = insert.filter((it) => !order.some((o) => keyOf(o) === keyOf(it)));
  order = [...ins, ...order];
  const next = { version: version ?? base?.version ?? null, ...buildSchedule(order, switchAt) };
  if (!next.items.length) return { ok: false, reason: "新时间线是空的" };
  if (emergency || !base) return { ok: true, timeline: { current: next, next: null, switchAt: null } };
  return { ok: true, timeline: { current: base, next, switchAt } };
}

// 超过 maxAge 的条目（按 fetchedAt / publishedAt）
export const fresh = (items, nowMs, maxAge = MAX_AGE_MS) =>
  items.filter((it) => { const t = it.fetchedAt ?? it.publishedAt; return t == null || nowMs - t <= maxAge; });
