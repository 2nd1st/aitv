// 电视这一屏（第三版：打开就在播，像电视台）。
// 画面只由 (item, t, nowMs, ctx) 决定：两台设备这几个值相同，画面逐帧相同。
// 数字只从 item.fields 读，只做角标。
//
// createTV(root, { onListen, onScreenClick, onGoLive })
//   打开就在播，只是静音。点「点一下收听」或静音时点画面任意处，会在这次点击里调 onListen 起播。
//   没传 onListen 时调 onPower，兼容旧播放层。
// render(item, t, nowMs, ctx)  ctx: { mode: "live"|"program", episode, index, count, upcoming:[{title,source}] }
// setPaused(bool) / setMuted(bool)

function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (u) => ((ax * u + bx) * u + cx) * u;
  const sy = (u) => ((ay * u + by) * u + cy) * u;
  const dx = (u) => (3 * ax * u + 2 * bx) * u + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let u = x;
    for (let i = 0; i < 6; i++) { const d = dx(u); if (Math.abs(d) < 1e-6) break; u -= (sx(u) - x) / d; }
    return sy(Math.min(1, Math.max(0, u)));
  };
}
const easeOut = bezier(0.23, 1, 0.32, 1);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const fmt = new Intl.NumberFormat("zh-CN");
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const link = (cls, href, text) => {
  const a = el("a", cls, text);
  a.href = href || "#"; a.target = "_blank"; a.rel = "noopener";
  return a;
};
const pad = (n) => String(n).padStart(2, "0");
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

const STAT = [
  ["points", (v) => `${fmt.format(v)} 分`],
  ["comments", (v) => `${fmt.format(v)} 评论`],
  ["stars_today", (v) => `今日 +${fmt.format(v)} 星`],
  ["starsToday", (v) => `今日 +${fmt.format(v)} 星`],
  ["stars", (v) => `${fmt.format(v)} 星`],
  ["votes", (v) => `${fmt.format(v)} 票`],
];
const KIND = { product: "产品", project: "开源项目", commentary: "评论", news: "新闻" };
const PART_LABEL = { what: "是什么", who: "跟你有关", take: "AI 点评", highlight: "亮点" };
const SRC_KEY = (s = "") => /hacker/i.test(s) ? "hn" : /github/i.test(s) ? "gh" : /product/i.test(s) ? "ph" : "ai";

// 配图：有 item.image 就用；GitHub 仓库用公开的社交卡片图；都没有就用排版海报
function imageOf(item) {
  if (item.image) return item.image;
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/.exec(item.url || "");
  if (m) return `https://opengraph.githubassets.com/1/${m[1]}/${m[2]}`;
  return null;
}
// 字幕：此刻在念的那句
function lineAt(item, t) {
  let cur = null;
  for (const r of item.rounds || []) { if (t >= r.start_time) cur = r; else break; }
  if (cur) return { part: cur.part || "", text: cur.text, start: cur.start_time };
  return { part: "what", text: item.fields?.what || "", start: 0 };
}
const SPEAKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h3.5L12 5v14l-4.5-4H4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

export function createTV(root, { channel = "AI 今天", onListen, onPower, onScreenClick, onGoLive } = {}) {
  root.innerHTML = "";
  const tv = el("div", "tv");
  const screen = el("div", "tv-screen");
  const picture = el("div", "tv-picture");
  const snow = el("canvas", "tv-snow");
  screen.append(picture, snow, el("div", "tv-glass"));
  tv.append(screen, el("i", "tv-led"));
  tv.setAttribute("data-on", "");
  root.append(tv);

  const visual = el("div", "visual");
  const img = el("img"); img.alt = ""; img.decoding = "async"; img.referrerPolicy = "no-referrer";
  const poster = el("div", "poster"); const posterB = el("b"); poster.append(posterB);
  visual.append(poster, img, el("div", "scrim"));
  img.addEventListener("load", () => { img.setAttribute("data-ready", ""); visual.setAttribute("data-has-img", ""); });
  img.addEventListener("error", () => { img.removeAttribute("data-ready"); visual.removeAttribute("data-has-img"); });

  const bug = el("div", "bug"); const state = el("div", "state");
  bug.append(el("div", "logo", channel), state);
  const clockbox = el("div", "clockbox"); const clockT = el("b"); const clockS = el("small", null, "北京时间");
  clockbox.append(clockT, clockS);
  const rail = el("div", "rail");
  const lower = el("div", "lower3");
  const band = el("div", "band");
  const prog = el("div", "prog"); const progI = el("i"); prog.append(progI);
  const tag = el("div", "tag"); const lane = el("div", "lane"); const track = el("div", "track"); lane.append(track);
  band.append(prog, tag, lane);
  const listen = el("button", "listen"); listen.type = "button";
  listen.innerHTML = SPEAKER; listen.append(document.createTextNode("点一下收听"));
  const golive = el("button", "golive", "回到直播"); golive.type = "button";
  picture.append(visual, bug, clockbox, rail, lower, band, listen, golive);

  let muted = true, paused = false;
  picture.setAttribute("data-muted", "");
  const setMuted = (v) => { muted = !!v; picture.toggleAttribute("data-muted", muted); };
  const setPaused = (v) => { paused = !!v; picture.toggleAttribute("data-paused", paused); };
  function doListen() {
    if (!muted) return;
    setMuted(false);
    (onListen || onPower)?.(Promise.resolve());   // 在这次点击里同步调用，保住浏览器的手势
  }
  listen.addEventListener("click", (e) => { e.stopPropagation(); doListen(); });
  golive.addEventListener("click", (e) => { e.stopPropagation(); onGoLive?.(); });
  picture.addEventListener("click", (e) => {
    if (e.target.closest("a,button")) return;
    if (muted) doListen(); else onScreenClick?.();
  });

  snow.width = 160; snow.height = 90;
  const sctx = snow.getContext("2d");
  const sImg = sctx.createImageData(snow.width, snow.height);
  function drawSnow() {
    const d = sImg.data;
    for (let i = 0; i < d.length; i += 4) { const v = (Math.random() * 255) | 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    sctx.putImageData(sImg, 0, 0);
  }

  let cur = null;
  function build(item) {
    const f = item.fields || {};
    visual.dataset.src = SRC_KEY(item.source);
    // 没配图时，背景只放来源的大号水印，不重复标题
    posterB.textContent = item.source || "";
    visual.removeAttribute("data-has-img"); img.removeAttribute("data-ready");
    const im = imageOf(item);
    if (im) img.src = im; else img.removeAttribute("src");

    lower.innerHTML = "";
    if (item.template === "caughtup") {
      const c = el("div", "caught"); c.append(el("b", null, f.title || "已追平"), el("small", null, f.note || ""));
      lower.append(c);
      cur = { id: item.id, lower, txt: null };
      return;
    }
    const meta = el("div", "meta");
    meta.append(el("span", "src", item.source || ""));
    const kind = KIND[item.kind || f.kind];
    if (kind) meta.append(el("span", null, kind));
    for (const [k, show] of STAT.filter(([k]) => isNum(f[k])).slice(0, 2)) meta.append(el("span", "stat", show(f[k])));
    meta.append(link("open", item.url, "看原文 ↗"));
    const head = link("headline", item.url, f.title_zh || f.title || "");
    const sub = el("div", "sub"); const lab = el("span", "lab"); const txt = el("span", "txt");
    sub.append(lab, txt);
    lower.append(meta, head, sub);
    cur = { id: item.id, lower, sub, lab, txt, lineKey: "" };
  }

  let laneKey = "", trackW = 0;
  function setUpcoming(list, mode) {
    const key = mode + "|" + list.map((u) => u.title).join("|");
    if (key === laneKey) return;
    laneKey = key; track.innerHTML = "";
    tag.textContent = mode === "program" ? "本期" : "接下来";
    if (!list.length) { trackW = 0; return; }
    const one = () => list.forEach((u) => { const s = el("span"); s.append(el("b", null, u.source || ""), document.createTextNode(u.title || "")); track.append(s); });
    one(); one();
    trackW = track.scrollWidth / 2;
  }
  let railKey = "";
  function setRail(ctx) {
    const key = ctx.mode === "program" ? String(ctx.count || "") : "";
    if (key === railKey) return;
    railKey = key; rail.innerHTML = "";
    if (!key) return;
    for (let i = 0; i < ctx.count; i++) { const s = el("i"); s.append(el("b")); rail.append(s); }
  }

  function render(item, t, nowMs = Date.now(), ctx = {}) {
    if (!item) return;
    const mode = ctx.mode === "program" ? "program" : "live";
    if (!cur || cur.id !== item.id) build(item);
    const motion = !reduceMotion();
    const dur = item.duration || 1;

    const kind = paused ? "paused" : muted ? "muted" : mode;
    const label = paused ? "已暂停" : muted ? "直播中 · 静音" : mode === "program" ? (ctx.episode || "准点节目") : "直播";
    if (state.dataset.kind !== kind || state.textContent !== label) { state.dataset.kind = kind; state.textContent = label; }
    const d = new Date(nowMs);
    clockT.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    clockS.textContent = mode === "program" && ctx.count ? `第 ${ctx.index + 1} / ${ctx.count} 条` : "北京时间";
    setRail({ ...ctx, mode });
    if (mode === "program") [...rail.children].forEach((s, i) => {
      s.firstChild.style.transform = `scaleX(${i < ctx.index ? 1 : i === ctx.index ? clamp01(t / dur) : 0})`;
    });

    // 换条时一瞬雪花，按 t 算
    const sp = t / 0.2;
    if (motion && sp < 1 && !paused) { drawSnow(); snow.style.opacity = String(0.85 * (1 - sp * sp)); }
    else snow.style.opacity = "0";

    // 慢推镜头：整条从 1.03 推到 1.09
    const z = motion ? 1.03 + 0.06 * clamp01(t / dur) : 1;
    poster.style.transform = `scale(${z})`;
    img.style.transform = `scale(${motion ? 1 + 0.02 * clamp01(t / dur) : 1})`;  // 小框里的图只轻轻推一点

    const e = motion ? easeOut(clamp01((t - 0.15) / 0.5)) : 1;
    cur.lower.style.opacity = String(e);
    cur.lower.style.transform = motion ? `translateY(${(1 - e) * 1.4}cqw)` : "";

    if (cur.txt) {
      const ln = lineAt(item, t);
      const key = ln.start + "|" + ln.text;
      if (key !== cur.lineKey) {
        cur.lineKey = key;
        cur.sub.dataset.part = ln.part;
        cur.lab.textContent = PART_LABEL[ln.part] || "";
        cur.txt.textContent = ln.text;
      }
      const se = motion ? easeOut(clamp01((t - ln.start) / 0.35)) : 1;
      cur.txt.style.opacity = String(0.25 + 0.75 * se);
    }

    progI.style.transform = `scaleX(${clamp01(t / dur)})`;
    setUpcoming(ctx.upcoming || [], mode);
    if (trackW > 0 && !paused) {
      const x = ((nowMs / 1000) * screen.clientWidth * 0.05) % trackW;
      track.style.transform = `translateX(${-x}px)`;
    }
  }

  // 旧接口：现在打开就在播，powerOn 等同于点收听
  const powerOn = () => { doListen(); return Promise.resolve(); };
  return { render, powerOn, setPaused, setMuted, get on() { return true; }, get muted() { return muted; }, get paused() { return paused; } };
}
