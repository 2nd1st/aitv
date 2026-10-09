// 原文（补料时读的页面正文）只用来提炼 brief，不进节目单：对外只留 brief + url。
export const SAFE_IMAGE = /^\/img\/[0-9a-f]{16}\.(jpg|png|webp)$/;
const PRIVATE_KEYS = ["materialText", "material", "lines", "briefError"];
export function publicItem(it) {
  const out = { ...it };
  for (const k of PRIVATE_KEYS) delete out[k];
  // 配图只许是自家 R2 的 /img/<key>，第三方地址一律不进节目单
  if ("image" in out && !SAFE_IMAGE.test(String(out.image))) out.image = null;
  return out;
}

// 节目单：每条带绝对开始时间和时长，连续排、无空档；没有音频的条目直接跳过。
export function buildSchedule(items, anchorMs) {
  let t = anchorMs;
  const out = [];
  for (const it of items) {
    if (!it.audio || !(it.duration > 0)) continue;
    out.push({ ...publicItem(it), start: t });
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
