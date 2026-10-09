// 电视这一屏（第二版：电视新闻台的画面语言）。
// 画面只由 (item, t, nowMs, ctx) 决定：两台设备这几个值相同，画面逐帧相同。
// 数字只从 item.fields 里读，只做角标，不读 spoken。
//
// render(item, t, nowMs, ctx)
//   ctx.mode      "live"（背景直播，默认）| "program"（准点节目）
//   ctx.episode   节目名，如 "早间 · 10月9日"（program 用）
//   ctx.index / ctx.count   本期第几条 / 共几条（program 用，画目录条）
//   ctx.upcoming  [{ title, source }]，底部滚动条用
// setPaused(bool)   暂停态：台标旁显示「已暂停」，右下出「回到直播」
// 回调：onPower(promise) / onScreenClick() / onGoLive()

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

// 角标：字段名 → 单位。只显示源数据里真有的数字。
const STAT = [
  ["rank", (v) => `第 ${fmt.format(v)} 名`],
  ["points", (v) => `${fmt.format(v)} 分`],
  ["comments", (v) => `${fmt.format(v)} 评论`],
  ["stars_today", (v) => `今日 +${fmt.format(v)} 星`],
  ["starsToday", (v) => `今日 +${fmt.format(v)} 星`], // sources.js 的字段名是 starsToday
  ["stars", (v) => `${fmt.format(v)} 星`],
  ["votes", (v) => `${fmt.format(v)} 票`],
];
const UNIT = { points: "分", comments: "条", stars: "颗", stars_today: "颗", votes: "票", forks: "次", rank: "名" };
const NUM_LABEL = { points: "Hacker News 得分", comments: "评论", stars: "GitHub 星标", stars_today: "今天新增星标", votes: "Product Hunt 票数", rank: "榜单名次" };

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const hasCJK = (s) => /[\u3400-\u9fff]/.test(s || "");

// 讲解分段：是什么 / 跟你有关 / AI 点评（没有点评就用亮点）
// 画面上的字和念的一致：rounds 标了 part 就用念的原句，没标才用提炼的简版
function spokenOf(item, key) {
  const rs = (item.rounds || []).filter((r) => r.part === key);
  return rs.length ? rs.map((r) => r.text).join("") : null;
}
function partsOf(item) {
  const f = item.fields || {};
  const take = item.take ?? f.take;
  const list = [];
  if (f.what) list.push({ key: "what", label: "是什么", text: spokenOf(item, "what") || f.what });
  if (f.who) list.push({ key: "who", label: "跟你有关", text: spokenOf(item, "who") || f.who });
  if (take) list.push({ key: "take", label: "AI 点评", text: spokenOf(item, "take") || take }); // 点评是模型写的，标明 AI，不署任何人名
  else if (f.highlight) list.push({ key: "highlight", label: "亮点", text: f.highlight });
  return list;
}
// 每段从第几秒开始念：优先用 rounds[i].part，否则按时长均分
function partStarts(item, parts) {
  const rounds = item.rounds || [];
  const dur = item.duration || 1;
  return parts.map((p, i) => {
    const r = rounds.find((r) => r.part === p.key);
    if (r) return r.start_time;
    return (dur * i) / parts.length;
  });
}

export function createTV(root, { brand = "AITV", channel = "AI 今天", onPower, onScreenClick, onGoLive } = {}) {
  root.innerHTML = "";
  const tv = el("div", "tv");
  const screen = el("div", "tv-screen");
  const picture = el("div", "tv-picture");
  const snow = el("canvas", "tv-snow");
  const glass = el("div", "tv-glass");
  const power = el("button", "tv-power");
  power.type = "button";
  power.setAttribute("aria-label", "开机");
  power.append(el("span", null, "开机"));
  screen.append(picture, snow, glass, power);
  const chin = el("div", "tv-chin");
  chin.append(el("span", null, brand), el("i", "tv-led"));
  tv.append(screen, chin);
  root.append(tv);

  // ---------- 固定的电视台外壳：台标、时钟、目录、底部滚动条、回到直播 ----------
  const studio = el("div", "studio");
  const bug = el("div", "bug");
  const state = el("div", "state");
  bug.append(el("div", "logo", channel), state);
  const clockbox = el("div", "clockbox");
  const clockT = el("b"); const clockS = el("small", null, "北京时间");
  clockbox.append(clockT, clockS);
  const rail = el("div", "rail");
  const stage = el("div");               // 每条的正文放这里
  const band = el("div", "band");
  const prog = el("div", "prog"); const progI = el("i"); prog.append(progI);
  const tag = el("div", "tag");
  const lane = el("div", "lane"); const track = el("div", "track"); lane.append(track);
  band.append(prog, tag, lane);
  const golive = el("button", "golive", "回到直播");
  golive.type = "button";
  picture.append(studio, bug, clockbox, rail, stage, band, golive);

  picture.addEventListener("click", (e) => {
    if (e.target.closest("a,button")) return;
    onScreenClick?.();
  });
  golive.addEventListener("click", (e) => { e.stopPropagation(); onGoLive?.(); });

  let paused = false;
  function setPaused(v) {
    paused = !!v;
    picture.toggleAttribute("data-paused", paused);
  }

  // ---------- 雪花 ----------
  snow.width = 192; snow.height = 108;
  const sctx = snow.getContext("2d");
  const img = sctx.createImageData(snow.width, snow.height);
  function drawSnow() {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) { const v = (Math.random() * 255) | 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    sctx.putImageData(img, 0, 0);
  }

  // ---------- 开机 ----------
  let audioCtx = null;
  function noise(ms) {
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const len = Math.floor(audioCtx.sampleRate * ms / 1000);
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
      const src = audioCtx.createBufferSource(); const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.12, audioCtx.currentTime);
      g.gain.linearRampToValueAtTime(0, audioCtx.currentTime + ms / 1000);
      src.buffer = buf; src.connect(g).connect(audioCtx.destination); src.start();
    } catch { /* 没声卡也照样开机 */ }
  }
  let booting = false;
  const BOOT_MS = 600;
  function powerOn({ instant = false } = {}) {
    if (booting || tv.hasAttribute("data-on")) return Promise.resolve();
    if (instant) { snow.style.opacity = "0"; tv.setAttribute("data-on", ""); return Promise.resolve(); }
    booting = true;
    noise(BOOT_MS);
    const motion = !reduceMotion();
    const t0 = performance.now();
    return new Promise((resolve) => {
      (function frame(now) {
        const p = (now - t0) / BOOT_MS;
        if (motion) { drawSnow(); snow.style.opacity = p < 1 ? "1" : "0"; }
        if (p < 1) return requestAnimationFrame(frame);
        tv.setAttribute("data-on", ""); booting = false; resolve();
      })(t0);
    });
  }
  power.addEventListener("click", () => { const p = powerOn(); onPower?.(p); });

  // ---------- 每条的正文 ----------
  let cur = null;
  function build(item) {
    stage.innerHTML = "";
    const f = item.fields || {};
    const card = el("div", "card");
    const n = { card };
    const parts = partsOf(item);

    const kicker = el("div", "kicker");
    kicker.append(el("b", null, item.source || ""));
    const stats = STAT.filter(([k]) => isNum(f[k])).slice(0, 2);
    for (const [k, show] of stats) { const s = el("i", "stat"); s.append(el("em", null, show(f[k]))); kicker.append(s); }
    kicker.append(link("open", item.url, "看原文 ↗"));

    if (item.template === "caughtup") {
      card.append(el("div", "caught", f.title || "已追平"), el("div", "caught-sub", f.note || ""));
    } else if (parts.length) {
      const title = f.title_zh || f.title || "";
      const h = link("headline", item.url, title);
      if (title.length > 34) h.classList.add("long");
      if (f.title_zh && f.title && f.title_zh !== f.title) h.append(el("span", "orig", f.title));
      const dl = el("dl", "parts");
      n.parts = parts.map((p) => {
        const row = el("div", `part ${p.key}`);
        const dt = el("dt", null, p.label), dd = el("dd", null, p.text);
        row.append(dt, dd); dl.append(row);
        return { row, dt, dd };
      });
      n.starts = partStarts(item, parts);
      card.append(kicker, h, dl);
    } else if (item.template === "number") {
      const key = isNum(f[item.focus]) ? item.focus : (Object.keys(f).find((k) => isNum(f[k]) && k !== "rank"));
      const num = el("div", "num"); const val = el("span");
      num.append(val, el("small", null, UNIT[key] || ""));
      card.append(kicker, link("headline long", item.url, f.title || ""), num, el("div", "num-label", NUM_LABEL[key] || key || ""));
      n.val = val; n.target = key ? f[key] : null;
    } else if (item.template === "source") {
      card.append(kicker, link("headline", item.url, f.title || item.source || ""), link("src-url", item.url, item.url || ""));
    } else {
      card.append(kicker, link("headline", item.url, f.title || ""));
    }
    stage.append(card);
    cur = { id: item.id, n };
  }

  let laneKey = "", trackW = 0;
  function setUpcoming(list, mode) {
    const key = mode + "|" + list.map((u) => u.title).join("|");
    if (key === laneKey) return;
    laneKey = key;
    track.innerHTML = "";
    tag.textContent = mode === "program" ? "本期" : "接下来";
    const one = () => list.forEach((u) => { const s = el("span"); s.append(el("b", null, u.source || ""), document.createTextNode(u.title || "")); track.append(s); });
    if (!list.length) return;
    one(); one();                         // 两份首尾相接，循环无缝
    trackW = track.scrollWidth / 2;
  }

  let railKey = "";
  function setRail(ctx) {
    const key = ctx.mode === "program" ? `${ctx.count}` : "";
    if (key === railKey) return;
    railKey = key; rail.innerHTML = "";
    if (ctx.mode !== "program" || !ctx.count) return;
    for (let i = 0; i < ctx.count; i++) { const s = el("i"); s.append(el("b")); rail.append(s); }
  }

  function render(item, t, nowMs = Date.now(), ctx = {}) {
    if (!item) return;
    const mode = ctx.mode === "program" ? "program" : "live";
    if (!cur || cur.id !== item.id) build(item);
    const n = cur.n;
    const motion = !reduceMotion();
    const dur = item.duration || 1;

    // 台标旁：直播 / 节目名 / 已暂停
    const kind = paused ? "paused" : mode;
    if (state.dataset.kind !== kind || state.dataset.ep !== (ctx.episode || "")) {
      state.dataset.kind = kind; state.dataset.ep = ctx.episode || "";
      state.textContent = paused ? "已暂停" : mode === "program" ? (ctx.episode || "准点节目") : "直播";
    }
    const d = new Date(nowMs);
    clockT.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    clockS.textContent = mode === "program" && ctx.count ? `第 ${ctx.index + 1} / ${ctx.count} 条` : "北京时间";

    setRail({ ...ctx, mode });
    if (mode === "program") {
      [...rail.children].forEach((s, i) => {
        const v = i < ctx.index ? 1 : i === ctx.index ? clamp01(t / dur) : 0;
        s.firstChild.style.transform = `scaleX(${v})`;
      });
    }

    // 换条：前 0.22 秒雪花
    const sp = t / 0.22;
    if (!booting) {
      if (motion && sp < 1 && !paused) { drawSnow(); snow.style.opacity = String(1 - sp * sp); }
      else snow.style.opacity = "0";
    }

    // 入场
    const e = motion ? easeOut(clamp01((t - 0.12) / 0.45)) : clamp01((t - 0.12) / 0.2);
    n.card.style.opacity = String(e);
    n.card.style.transform = motion ? `translateY(${(1 - e) * 1.2}cqw)` : "";

    // 讲解分段：念到哪段亮哪段，后面的还没出现
    if (n.parts) {
      let live = 0;
      n.starts.forEach((s, i) => { if (t >= s) live = i; });
      n.parts.forEach((p, i) => {
        const since = t - n.starts[i];
        const a = since < 0 ? 0 : motion ? easeOut(clamp01(since / 0.4)) : 1;
        p.row.toggleAttribute("data-live", i === live);
        for (const c of [p.dt, p.dd]) {
          c.style.opacity = String(a);
          c.style.transform = motion ? `translateY(${(1 - a) * 0.6}cqw)` : "";
        }
      });
    }

    // 旧数字卡：数到源值，停在精确值
    if (n.val) {
      if (n.target == null) n.val.textContent = "";
      else {
        const p = motion ? easeOut(clamp01((t - 0.3) / 0.9)) : 1;
        n.val.textContent = fmt.format(p >= 1 ? n.target : Math.round(n.target * p));
      }
    }

    progI.style.transform = `scaleX(${clamp01(t / dur)})`;

    // 底部滚动条：位置由服务器时间算，各设备一致
    setUpcoming(ctx.upcoming || [], mode);
    if (trackW > 0) {
      const pxPerSec = screen.clientWidth * 0.06;
      const x = paused ? null : ((nowMs / 1000) * pxPerSec) % trackW;
      if (x != null) track.style.transform = `translateX(${-x}px)`;
    }
  }

  return { render, powerOn, setPaused, get on() { return tv.hasAttribute("data-on"); }, get paused() { return paused; } };
}
