// 时钟、节目单、音频（沃兹）。画面交给 screen/tv.js（艾维）。
import { createTV } from "/screen/tv.js";

// 校时：测 7 次往返，取往返最短的那次，偏差 = 服务器时间 - 本地中点
async function syncClock() {
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    const r = await fetch("/api/time", { cache: "no-store" });
    const { now } = await r.json();
    const t1 = performance.now();
    samples.push({ rtt: t1 - t0, offset: now - (performance.timeOrigin + (t0 + t1) / 2) });
  }
  samples.sort((a, b) => a.rtt - b.rtt);
  return samples[0];
}

function locate(s, nowMs) {
  const pos = (((nowMs - s.anchor) % s.total) + s.total) % s.total;
  for (let i = 0; i < s.items.length; i++) {
    const st = s.items[i].start - s.anchor, en = st + s.items[i].duration * 1000;
    if (pos >= st && pos < en) return { i, t: (pos - st) / 1000 };
  }
  return { i: 0, t: 0 };
}

const [clock, schedule] = await Promise.all([
  syncClock(),
  fetch("/api/schedule", { cache: "no-store" }).then((r) => r.json()),
]);
const now = () => performance.timeOrigin + performance.now() + clock.offset;
window.__aitv = { clock, schedule, now, locate: () => locate(schedule, now()) };

// 预取：当前和下一条的音频
const cache = new Map();
function audioFor(item) {
  if (!cache.has(item.id)) {
    const a = new Audio(item.audio); a.preload = "auto"; cache.set(item.id, a);
    if (cache.size > 4) cache.delete(cache.keys().next().value);
  }
  return cache.get(item.id);
}
function prefetchAround(i) {
  const n = schedule.items.length;
  audioFor(schedule.items[i]); audioFor(schedule.items[(i + 1) % n]);
}
prefetchAround(locate(schedule, now()).i);

let on = false, playing = null; // playing: { id, audio }
function syncAudio(item, t) {
  const a = audioFor(item);
  if (!playing || playing.id !== item.id) {
    if (playing) playing.audio.pause();
    playing = { id: item.id, audio: a };
    a.currentTime = Math.max(0, t);
    a.play().catch(() => {});
    prefetchAround(schedule.items.indexOf(item));
    return;
  }
  // 漂移超过 0.25 秒就拉回来
  if (!a.paused && Math.abs(a.currentTime - t) > 0.25 && t < a.duration) a.currentTime = t;
}

const tv = createTV(document.getElementById("root"), {
  onPower: () => {
    on = true;
    // 这次点击里起播，开机雪花盖住起播
    const { i, t } = locate(schedule, now());
    syncAudio(schedule.items[i], t);
  },
});

function frame() {
  const n = now();
  const { i, t } = locate(schedule, n);
  const item = schedule.items[i];
  if (on) syncAudio(item, t);
  tv.render(item, t, n);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
