// 时间线的纯函数：浏览器（app.js）和 Worker / 测试（src/timeline.js）共用这一份。
// 节目单 sched = { version, anchor, total, items: [{ start, duration, ... }] }，从 anchor 起连续排、循环播。
// 换节目单不立刻换：接口给 { current, next, switchAt }，所有设备按校准后的同一个时钟，到 switchAt 才换成 next。
// switchAt 总是 current 的某个条目边界，所以谁都不会在一条中间被切断。

export function locate(s, nowMs) {
  if (!s || !s.items?.length || !(s.total > 0)) return { i: 0, t: 0 };
  const pos = (((nowMs - s.anchor) % s.total) + s.total) % s.total;
  for (let i = 0; i < s.items.length; i++) {
    // 一条的结束 = 下一条的开始（start 是按整毫秒排的；用 duration*1000 会在边界留下不到 1 毫秒的缝，缝里会错落到第 0 条）
    const st = s.items[i].start - s.anchor, en = i + 1 < s.items.length ? s.items[i + 1].start - s.anchor : s.total;
    if (pos >= st && pos < en) return { i, t: (pos - st) / 1000 };
  }
  return { i: 0, t: 0 };
}

// 此刻该按哪份节目单播
export function pick(state, nowMs) {
  if (state?.next && state.switchAt != null && nowMs >= state.switchAt) return state.next;
  return state?.current || null;
}

// 接口返回 → 客户端状态。旧接口（没有 current）当成只有 current。
export function adopt(body) {
  const current = body.current || { version: body.version, anchor: body.anchor, total: body.total, items: body.items };
  return { version: body.version, current, next: body.next || null, switchAt: body.switchAt ?? null };
}

// 第一个 >= atMs 的条目开始时刻（考虑循环）
export function nextBoundary(s, atMs) {
  if (!s?.items?.length || !(s.total > 0)) return atMs;
  const loop = Math.floor((atMs - s.anchor) / s.total);
  for (let k = loop; k <= loop + 1; k++) {
    for (const it of s.items) {
      const b = s.anchor + k * s.total + (it.start - s.anchor);
      if (b >= atMs) return b;
    }
  }
  return s.anchor + (loop + 2) * s.total;
}

// 从时刻 ms 起往后数 k 条（跨 switchAt 时自动换成 next 的条目）。
// 一步一步跳到「下一个条目边界」（nextBoundary），不累加剩余时长：累加时四舍五入会落在边界前 / 后，
// 相邻两帧算出来的「当前条」来回跳，底部「接下来」就会一直重画（乔布斯 2026-10-09 报的闪烁）。
export function walk(state, ms, k) {
  const out = [];
  let cur = ms;
  for (let j = 0; j < k; j++) {
    const s = pick(state, cur);
    if (!s?.items?.length) break;
    const it = s.items[locate(s, cur).i];
    if (!it) break;
    out.push(it);
    let nb = nextBoundary(s, Math.floor(cur) + 1); // 严格大于 cur 的下一个边界（边界都是整毫秒，cur 可能带小数）
    if (state?.next && state.switchAt != null && cur < state.switchAt && state.switchAt < nb) nb = state.switchAt;
    cur = nb;
  }
  return out;
}
