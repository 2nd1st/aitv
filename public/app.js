// 时钟、节目单、音频（沃兹）。画面交给 screen/tv.js（艾维）。
import { createTV } from "/screen/tv.js";
import { locate, pick, adopt } from "/timeline.js";

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

async function loadSchedule() {
  for (let k = 0; ; k++) {
    try {
      const r = await fetch("/api/schedule", { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((ok) => setTimeout(ok, Math.min(30000, 2000 * 2 ** k)));
  }
}
let [clock, body] = await Promise.all([syncClock(), loadSchedule()]);
// state = { current, next, switchAt }：到 switchAt（条目边界，所有设备同一个服务器时钟）才换成 next，不会在一条中间切
let state = adopt(body);
const now = () => performance.timeOrigin + performance.now() + clock.offset;

// 每分钟重新校时 + 拉节目单。服务器保证 switchAt 至少在 90 秒后，所以切换前一定能拿到 next。
// 紧急下架时服务器直接换 current（没有 next），这里照收，下一帧就切。
setInterval(async () => {
  try { const c = await syncClock(); if (c.rtt < 1500) clock = c; } catch {}
  try {
    const r = await fetch("/api/schedule", { cache: "no-store" });
    if (r.ok) { state = adopt(await r.json()); primeNext(); }
  } catch {}
}, 60000);

let on = false, playing = null; // playing: { id, audio }
const switchLog = []; // 每次换条：什么时候开始换、什么时候真的出声（playing 事件），用来量切换有没有卡

// 预取：当前和下一条的音频。按音频地址缓存（不同版本同 id 不会串）
const cache = new Map();
let primed = null; // { audio, url, t }：switchAt 之后第一条，next 一到就预加载好，切换时不卡
function audioFor(item) {
  if (!cache.has(item.audio)) {
    const a = new Audio(item.audio); a.preload = "auto"; cache.set(item.audio, a);
    if (cache.size > 5) {
      for (const [k, old] of cache) {
        if (old !== playing?.audio && old !== primed?.audio) { cache.delete(k); break; }
      }
    }
  }
  return cache.get(item.audio);
}
// 拿到 next 就预加载 switchAt 那一刻要播的那条；切换点落在文件中间（比如紧急切换）就先 seek 到对应位置
function primeNext() {
  if (!state.next || state.switchAt == null) { primed = null; return; }
  const { i, t } = locate(state.next, state.switchAt);
  const it = state.next.items[i];
  if (!it || primed?.url === it.audio) return;
  const a = audioFor(it);
  primed = { audio: a, url: it.audio, t };
  const seek = () => { if (a !== playing?.audio && t > 0.05) a.currentTime = t; };
  if (a.readyState >= 1) seek(); else a.addEventListener("loadedmetadata", seek, { once: true });

}
primeNext();
// 从时刻 ms 起往后数 k 条（跨 switchAt 时自动换成 next 的条目）
function walk(ms, k) {
  const out = [];
  let cur = ms;
  for (let j = 0; j < k; j++) {
    const s = pick(state, cur), { i, t } = locate(s, cur), it = s.items[i];
    if (!it) break;
    out.push(it);
    cur += Math.max(1, Math.round((it.duration - t) * 1000)); // 跳到这条结束（= 下一条开始）
  }
  return out;
}
const prefetchAround = (ms) => walk(ms, 2).forEach(audioFor);
prefetchAround(now());

// 本地时间线：直播位置 = 服务器时间；暂停后继续会落后直播 lag 毫秒，「回到直播」清零。
let paused = false, frozenAt = 0, lag = 0;
const vnow = () => (paused ? frozenAt : now() - lag);
// 此刻（本地时间线上）在播的条目
function here(ms = vnow()) { const s = pick(state, ms); const { i, t } = locate(s, ms); return { s, i, t, item: s.items[i] }; }
window.__aitv = { get clock() { return clock; }, get state() { return state; }, get schedule() { return pick(state, now()); }, now, locate: () => { const h = here(now()); return { i: h.i, t: h.t, version: h.s.version, id: h.item?.id }; } };
// 这条音频此刻应该在第几秒（按服务器时钟现算；不在这条上了返回 null）
function targetT(audio) {
  const { item, t } = here();
  return item?.audio === audio ? t : null;
}

// 定位：元数据没到之前设 currentTime 会被浏览器忽略（iOS 尤甚）。
// 所以等 loadedmetadata 再按「那一刻」的服务器时间算位置；canplay 时再校一次。
function seekWhenReady(a, url) {
  const apply = () => {
    if (playing?.audio !== a || paused) return;
    const t = targetT(url);
    if (t != null && Math.abs(a.currentTime - t) > 0.25) a.currentTime = Math.min(Math.max(0, t), (a.duration || Infinity) - 0.05);
  };
  if (a.readyState >= 1) apply();
  else a.addEventListener("loadedmetadata", apply, { once: true });
  if (a.readyState < 3) a.addEventListener("canplay", apply, { once: true });
}

let lastFix = 0;
function syncAudio(item, t) {
  const a = audioFor(item);
  if (!playing || playing.audio !== a) {
    if (playing) playing.audio.pause();
    playing = { id: item.id, audio: a };
    const rec = { id: item.id, at: now(), ready: a.readyState, primed: primed?.audio === a };
    switchLog.push(rec); if (switchLog.length > 20) switchLog.shift();
    a.addEventListener("playing", () => { rec.playingAt = now(); rec.stallMs = Math.round(rec.playingAt - rec.at); }, { once: true });
    // 预加载好的那条已经停在正确位置：差得不多就不 seek（seek 本身要等几百毫秒），直接放，漂移交给后面的校正
    if (a.readyState >= 1 && Math.abs(a.currentTime - t) > 0.25) a.currentTime = Math.max(0, t);
    a.play().catch(() => {});      // 开机那次点击里同步调用，保住手势
    seekWhenReady(a, item.audio);
    prefetchAround(vnow());
    return;
  }
  // 暂停后继续：从时间线上的位置接着放
  if (a.paused && !a.ended && !(t >= (a.duration || Infinity) - 0.05)) {
    if (a.readyState >= 1) a.currentTime = Math.max(0, t);
    a.play().catch(() => {});
    seekWhenReady(a, item.audio);
    return;
  }
  // 漂移超过 0.25 秒就拉回来：只在缓冲够了、没在 seek 的时候，且最多每秒一次，避免来回拉扯
  const ms = performance.now();
  if (!a.paused && !a.seeking && a.readyState >= 3 && ms - lastFix > 1000 &&
      Math.abs(a.currentTime - t) > 0.25 && t < a.duration - 0.05) {
    a.currentTime = t; lastFix = ms;
  }
}

function pause() {
  if (paused || !on) return;
  frozenAt = now() - lag;   // 画面定格在这一刻
  paused = true;
  playing?.audio.pause();
  tv.setPaused(true);
}
function resume() {
  if (!paused) return;
  lag = now() - frozenAt;   // 从暂停处接着播
  paused = false;
  tv.setPaused(false);
  const { item, t } = here();
  syncAudio(item, t);
}
function goLive() {
  paused = false; lag = 0;  // 按服务器时钟重新定位到直播
  tv.setPaused(false);
  const { item, t } = here();
  if (on) syncAudio(item, t);
}

// 第一次点击里同步起播（保住手势）。screen-v4 叫 onListen，旧画面叫 onPower，两个都给。
function listen() {
  on = true;
  tv?.setMuted?.(false);
  const { item, t } = here();
  syncAudio(item, t);
}
const tv = createTV(document.getElementById("root"), {
  onListen: listen,
  onPower: listen,
  onScreenClick: () => (paused ? resume() : pause()),
  onGoLive: goLive,
});

// 底部滚动条：接下来的几条
function upcoming(ms, k = 5) {
  return walk(ms, k + 1).slice(1).map((it) => ({ title: it.fields?.title_zh || it.fields?.title || "", source: it.source }));
}

// 旧条目（节目单里 stale: true，12 小时内一条都没有时留下的）右上角小字「N 小时前」；画面本身归 screen/ 管，这里只叠一层
const ageTag = Object.assign(document.createElement("div"), { id: "age-tag" });
ageTag.style.cssText = "position:fixed;top:10px;right:12px;z-index:50;font:12px/1.4 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:2px 8px;border-radius:10px;pointer-events:none;display:none";
document.body.appendChild(ageTag);
function showAge(item) {
  const at = item?.stale ? (item.dateKind === "ranked" ? item.rankedAt : item.publishedAt) : null;
  const txt = at ? `${Math.max(1, Math.floor((now() - at) / 3600e3))} 小时前` : "";
  if (ageTag.textContent !== txt) { ageTag.textContent = txt; ageTag.style.display = txt ? "" : "none"; }
}

function frame() {
  const n = vnow();
  const { item, t } = here(n);
  showAge(item);
  if (on && !paused) syncAudio(item, t);
  // 暂停时画面定格；时钟仍走服务器时间
  tv.render(item, t, now(), { mode: "live", upcoming: upcoming(n) });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__aitv.player = { switchLog, get primed() { return primed && { url: primed.url, t: primed.t, ready: primed.audio.readyState }; }, pause, resume, goLive, get paused() { return paused; }, get lag() { return lag; }, get audio() { return playing?.audio; },
  drift() { const a = playing?.audio; if (!a) return null; const { t } = here(); return { cur: +a.currentTime.toFixed(2), target: +t.toFixed(2), ready: a.readyState, paused: a.paused }; } };
