// 时钟、节目单、音频（沃兹）。画面交给 screen/tv.js（艾维）。
import { locate, pick, adopt, walk as walkAt } from "/timeline.js";
import { fetchJSON, measureClock, validSchedule } from "/client.js";
const status = document.getElementById("player-status");
const showStatus = (message = "") => { if (status.textContent !== message) status.textContent = message; status.hidden = !message; };
// 画面：默认 /screen/（现在这版）；?ui=v4 用艾维的第四版（/screen/v4/，分支 screen-v4 原样拷过来）
const UI = new URLSearchParams(location.search).get("ui") === "v4" ? "v4" : "default";
if (UI === "v4") document.querySelector('link[href="/screen/tv.css"]')?.setAttribute("href", "/screen/v4/tv.css");
const { createTV } = await import(UI === "v4" ? "/screen/v4/tv.js" : "/screen/tv.js");

// 校时：测 7 次往返，取往返最短的那次，偏差 = 服务器时间 - 本地中点
const syncClock = () => measureClock();
async function initialClock() {
  for (;;) {
    try { return await syncClock(); }
    catch { showStatus("暂时无法连接直播，正在重试…"); await new Promise(resolve => setTimeout(resolve, 3000)); }
  }
}
async function loadSchedule() {
  for (let k = 0; ; k++) {
    try {
      const body = await fetchJSON("/api/schedule?compact=1", { timeout: 15000 });
      if (validSchedule(body)) return body;
    } catch {}
    showStatus("节目单暂时不可用，正在重试…");
    await new Promise(resolve => setTimeout(resolve, Math.min(30000, 2000 * 2 ** Math.min(k, 4))));
  }
}
let [clock, body] = await Promise.all([initialClock(), loadSchedule()]);
// state = { current, next, switchAt }：到 switchAt（条目边界，所有设备同一个服务器时钟）才换成 next，不会在一条中间切
let state = adopt(body);
showStatus();
const now = () => performance.timeOrigin + performance.now() + clock.offset;

// 每分钟重新校时 + 拉节目单。服务器保证 switchAt 至少在 90 秒后，所以切换前一定能拿到 next。
// 紧急下架时服务器直接换 current（没有 next），这里照收，下一帧就切。
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [c, schedule] = await Promise.allSettled([syncClock(), fetchJSON("/api/schedule?compact=1", { timeout: 15000 })]);
    if (c.status === "fulfilled" && c.value.rtt < 1500) clock = c.value;
    if (schedule.status === "fulfilled" && validSchedule(schedule.value)) {
      state = adopt(schedule.value); primeNext();
    }
  } finally { refreshing = false; }
}
setInterval(refresh, 60000);
window.addEventListener("online", refresh);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

let on = false, playing = null; // playing: { id, audio }
const switchLog = []; // 每次换条：什么时候开始换、什么时候真的出声（playing 事件），用来量切换有没有卡

// 预取：当前和下一条的音频。按音频地址缓存（不同版本同 id 不会串）
const cache = new Map();
let primed = null; // { audio, url, t }：switchAt 之后第一条，next 一到就预加载好，切换时不卡
function audioFor(item) {
  if (!cache.has(item.audio)) {
    const a = new Audio(item.audio); a.preload = "auto"; a.muted = !on; cache.set(item.audio, a);
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
// 从时刻 ms 起往后数 k 条（跨 switchAt 时自动换成 next 的条目）：见 timeline.js walk
const walk = (ms, k) => walkAt(state, ms, k);
const prefetchAround = (ms) => walk(ms, 2).forEach(audioFor);
prefetchAround(now());

// 本地时间线：直播位置 = 服务器时间；暂停后继续会落后直播 lag 毫秒，「回到直播」清零。
let paused = false, frozenAt = 0, lag = 0;
const vnow = () => (paused ? frozenAt : now() - lag);
// 此刻（本地时间线上）在播的条目
function here(ms = vnow()) { const s = pick(state, ms); const { i, t } = locate(s, ms); return { s, i, t, item: s?.items?.[i] }; }
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

// 点之前就静音跟着直播在放（浏览器允许静音自动播放）：点一下只是取消静音，几乎没有延迟。
// 浏览器不让静音自动播放（warmBlocked）时退一步：每秒把当前这条定位到直播位置附近（只缓冲、不播），点的时候只差一点点。
let warmBlocked = false;
const playA = (a) => a.play().catch(() => { if (!on) warmBlocked = true; });
let lastPos = 0;
function positionOnly(item, t) {
  const a = audioFor(item), ms = performance.now();
  if (ms - lastPos < 1000 || a.readyState < 1 || a.seeking) return;
  lastPos = ms;
  if (Math.abs(a.currentTime - t) > 1) a.currentTime = Math.min(t + 0.5, (a.duration || Infinity) - 0.05);
}

let lastFix = 0;
function syncAudio(item, t) {
  if (!item) { playing?.audio.pause(); playing = null; return; }
  const a = audioFor(item);
  if (!playing || playing.audio !== a) {
    if (playing) playing.audio.pause();
    const kind = playing ? "switch" : "start";
    playing = { id: item.id, audio: a };
    const rec = { id: item.id, kind, at: now(), ready: a.readyState, primed: primed?.audio === a };
    switchLog.push(rec); if (switchLog.length > 20) switchLog.shift();
    a.addEventListener("playing", () => { rec.playingAt = now(); rec.stallMs = Math.round(rec.playingAt - rec.at); }, { once: true });
    // 预加载好的那条已经停在正确位置：差得不多就不 seek（seek 本身要等几百毫秒），直接放，漂移交给后面的校正
    if (a.readyState >= 1 && Math.abs(a.currentTime - t) > 0.25) a.currentTime = Math.max(0, t);
    playA(a);                       // 开机那次点击里同步调用，保住手势
    seekWhenReady(a, item.audio);
    prefetchAround(vnow());
    return;
  }
  // 暂停后继续：从时间线上的位置接着放
  if (a.paused && !a.ended && !(t >= (a.duration || Infinity) - 0.05)) {
    if (a.readyState >= 1) a.currentTime = Math.max(0, t);
    playA(a);
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
  if (document.activeElement?.matches(".tv-power,.listen")) document.activeElement.blur();
  on = true;
  tv?.setMuted?.(false);
  for (const a of cache.values()) a.muted = false; // 已经静音在放的话，这一下就出声
  const { item, t } = here();
  if (playing && playing.audio.paused) playing.audio.play().catch(() => {}); // 在这次点击里同步调用，保住手势
  syncAudio(item, t);
  tapLog.push({ at: performance.now(), wasPlaying: playing ? !playing.audio.paused : false, warmBlocked });
}
const tapLog = [];
const tv = createTV(document.getElementById("root"), {
  onListen: listen,
  onPower: listen,
  onScreenClick: () => (paused ? resume() : pause()),
  onGoLive: goLive,
});

// 底部滚动条：接下来的几条
// 列表没变就交出同一个数组（屏幕那边按内容比较，这里再挡一层：只有真的变了才重画）
let lastUp = [], lastUpKey = "";
function upcoming(ms, k = 5) {
  const list = walk(ms, k + 1).slice(1);
  const key = list.map((it) => `${it.id}|${it.audio}`).join(",");
  if (key !== lastUpKey) { lastUpKey = key; lastUp = list.map((it) => ({ title: it.fields?.title_zh || it.fields?.title || "", source: it.source })); }
  return lastUp;
}

// 旧条目（节目单里 stale: true，12 小时内一条都没有时留下的）右上角小字「N 小时前」；画面本身归 screen/ 管，这里只叠一层
const ageTag = Object.assign(document.createElement("div"), { id: "age-tag" });
ageTag.style.cssText = "position:fixed;top:10px;right:12px;z-index:50;font:12px/1.4 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:2px 8px;border-radius:10px;pointer-events:none;display:none";
document.body.appendChild(ageTag);
function showAge(item) {
  if (UI === "v4") return; // 第四版自己在来源行标「N 小时前」
  const at = item?.stale ? (item.dateKind === "ranked" ? item.rankedAt : item.publishedAt) : null;
  const txt = at ? `${Math.max(1, Math.floor((now() - at) / 3600e3))} 小时前` : "";
  if (ageTag.textContent !== txt) { ageTag.textContent = txt; ageTag.style.display = txt ? "" : "none"; }
}

// 离条目边界还有 30 秒时再确认一次下一条的音频在缓冲（readyState < 3 就 load()），换条时不等网络。
// 平时换条那一刻已经预取了下一条；这里兜住浏览器丢了预取 / 缓存被挤掉的情况。
let lastWarm = 0;
function warmNext(ms) {
  const p = performance.now();
  if (p - lastWarm < 1000) return;
  lastWarm = p;
  const { item, t } = here(ms);
  if (!item || item.duration - t > 30) return;
  const nx = walk(ms, 2)[1];
  if (!nx || nx.audio === item.audio) return;
  const a = audioFor(nx);
  if (a.readyState < 3 && a.networkState !== 2 /* 没在加载 */) a.load();
}

function frame() {
  const n = vnow();
  const { item, t } = here(n);
  if (!item) {
    playing?.audio.pause(); playing = null;
    showStatus("暂无可播节目，更新后将自动接上直播");
    requestAnimationFrame(frame); return;
  }
  showStatus();
  if (!paused) warmNext(n);
  showAge(item);
  if (!paused) { if (on || !warmBlocked) syncAudio(item, t); else positionOnly(item, t); }
  // 暂停时画面定格；时钟仍走服务器时间
  tv.render(item, t, now(), { mode: "live", upcoming: upcoming(n) });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__aitv.player = { switchLog, tapLog, get warmBlocked() { return warmBlocked; }, get primed() { return primed && { url: primed.url, t: primed.t, ready: primed.audio.readyState }; }, pause, resume, goLive, get paused() { return paused; }, get lag() { return lag; }, get audio() { return playing?.audio; },
  drift() { const a = playing?.audio; if (!a) return null; const { t } = here(); return { cur: +a.currentTime.toFixed(2), target: +t.toFixed(2), ready: a.readyState, paused: a.paused }; } };

// Keyboard shortcuts never override links, buttons or editable fields.
document.addEventListener("keydown", (event) => {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.target.closest("a,button,input,textarea,select,[contenteditable],dialog")) return;
  if (event.code === "Space") { event.preventDefault(); if (!on) { tv.powerOn?.(true); listen(); } else if (paused) resume(); else pause(); }
  if (event.key.toLowerCase() === "l") goLive();
});

performance.mark("aitv-ready");
