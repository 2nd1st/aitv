// 节目单：每条带绝对开始时间和时长，连续排、无空档；没有音频的条目直接跳过。
export function buildSchedule(items, anchorMs) {
  let t = anchorMs;
  const out = [];
  for (const it of items) {
    if (!it.audio || !(it.duration > 0)) continue;
    out.push({ ...it, start: t });
    t += Math.round(it.duration * 1000);
  }
  return { anchor: anchorMs, total: t - anchorMs, items: out };
}

// 按服务器校准后的时间定位：播完就循环，永不黑屏。
export function locate(schedule, nowMs) {
  const { anchor, total, items } = schedule;
  if (!items.length || total <= 0) return null;
  const pos = (((nowMs - anchor) % total) + total) % total;
  for (let i = 0; i < items.length; i++) {
    const s = items[i].start - anchor;
    const e = s + items[i].duration * 1000;
    if (pos >= s && pos < e) return { index: i, t: (pos - s) / 1000 };
  }
  return { index: 0, t: 0 };
}
