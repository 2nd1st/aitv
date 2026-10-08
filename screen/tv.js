// 电视这一屏。只认一个函数：render(item, t)。
// 画面完全由 t 决定，不靠事件顺序：两台设备 t 相同，画面逐帧相同。
// 数字卡只读 item.fields，不读 spoken。

// 与 CSS 的 --ease-out: cubic-bezier(0.23, 1, 0.32, 1) 同一条曲线
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
    for (let i = 0; i < 6; i++) {
      const d = dx(u);
      if (Math.abs(d) < 1e-6) break;
      u -= (sx(u) - x) / d;
    }
    return sy(Math.min(1, Math.max(0, u)));
  };
}
const easeOut = bezier(0.23, 1, 0.32, 1);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

const LABELS = {
  points: "分", score: "分", comments: "条", stars: "颗", stars_today: "颗",
  forks: "次", votes: "票", upvotes: "票", rank: "名", downloads: "次",
};
const SOURCE_LABEL = { points: "Hacker News 得分", comments: "评论", stars: "GitHub 星标",
  stars_today: "今天新增星标", forks: "Fork", votes: "Product Hunt 票数", upvotes: "票数", rank: "榜单名次" };

const fmt = new Intl.NumberFormat("zh-CN");
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function numericFields(fields = {}) {
  return Object.entries(fields).filter(([, v]) => typeof v === "number" && Number.isFinite(v));
}
function focusField(item) {
  const nums = numericFields(item.fields);
  if (item.focus && typeof item.fields?.[item.focus] === "number") return [item.focus, item.fields[item.focus]];
  return nums[0] || null;
}
function domain(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u || ""; }
}
// 当前在念哪一句：豆包 rounds 的 start_time / end_time（秒）
function roundAt(rounds = [], t) {
  for (let i = 0; i < rounds.length; i++) {
    if (t >= rounds[i].start_time && t < rounds[i].end_time) return i;
  }
  return -1;
}

export function createTV(root, { channel = "AI 今天", brand = "AITV", onPower } = {}) {
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

  // ---------- 雪花：低分辨率噪点，拉伸显示 ----------
  snow.width = 192; snow.height = 108;
  const sctx = snow.getContext("2d");
  const img = sctx.createImageData(snow.width, snow.height);
  function drawSnow() {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);
  }

  // ---------- 开机：用户手势里起声，雪花盖住音频起播 ----------
  let audioCtx = null;
  function noise(ms) {
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const len = Math.floor(audioCtx.sampleRate * ms / 1000);
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
      const src = audioCtx.createBufferSource();
      const g = audioCtx.createGain();
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
        tv.setAttribute("data-on", "");
        booting = false;
        resolve();
      })(t0);
    });
  }
  power.addEventListener("click", async () => {
    const p = powerOn();
    onPower?.(p);
    await p;
  });

  // ---------- 画面 ----------
  let current = null;   // { id, nodes }
  function build(item) {
    picture.innerHTML = "";
    const card = el("div", "card");
    const nodes = { card };

    if (item.template === "number") {
      const f = focusField(item);
      const kicker = el("div", "kicker");
      kicker.append(el("b", null, item.source || ""), el("i", null, item.fields?.title || ""));
      const num = el("div", "num");
      const val = el("span");
      const unit = el("small", null, f ? (LABELS[f[0]] || "") : "");
      num.append(val, unit);
      const label = el("div", "num-label", f ? (SOURCE_LABEL[f[0]] || f[0]) : "");
      card.append(kicker, num, label);
      // 第二个数字只在源数据里有时出现，原样显示，不做加工
      const rest = numericFields(item.fields).filter(([k]) => !f || k !== f[0]).slice(0, 1);
      if (rest.length) card.append(el("div", "num-delta", `${SOURCE_LABEL[rest[0][0]] || rest[0][0]} ${fmt.format(rest[0][1])}`));
      Object.assign(nodes, { val, target: f ? f[1] : null });
    } else if (item.template === "source") {
      card.append(el("div", "kicker", "原文出处"),
        el("div", "src-name", item.source || domain(item.url)),
        Object.assign(el("a", "src-url", item.url || ""), { href: item.url || "#", target: "_blank", rel: "noopener" }),
        el("div", "src-cta", "点下方「看原文」打开"));
    } else {
      const kicker = el("div", "kicker");
      kicker.append(el("b", null, item.source || ""));
      if (item.fields?.rank) kicker.append(el("i", null, `第 ${fmt.format(item.fields.rank)} 名`));
      const h = el("h1", "headline", item.fields?.title || "");
      const terms = el("div", "terms");
      const termNodes = (item.rounds || []).slice(0, 6).map((r, i) => {
        const n = el("span", "term", r.keyword || "");
        if (!r.keyword) n.hidden = true;
        terms.append(n);
        return n;
      });
      card.append(kicker, h);
      if (termNodes.some((n) => !n.hidden)) card.append(terms);
      nodes.termNodes = termNodes;
    }

    const lower = el("div", "lower");
    const bar = el("span", "bar"); const fill = el("i"); bar.append(fill);
    const link = el("a", null, "看原文");
    link.href = item.url || "#"; link.target = "_blank"; link.rel = "noopener";
    const clock = el("span", "clock");
    lower.append(el("span", "ch", channel), bar, clock, link);
    picture.append(card, lower);
    Object.assign(nodes, { fill, clock });
    current = { id: item.id, nodes };
  }

  // 纯函数式：同一个 (item, t, now) 永远画出同一帧
  function render(item, t, nowMs = Date.now()) {
    if (!item) return;
    if (!current || current.id !== item.id) build(item);
    const n = current.nodes;
    const motion = !reduceMotion();
    const dur = item.duration || 1;

    // 换条：前 0.22 秒雪花，按 t 计算，两台设备一致
    const sp = t / 0.22;
    if (!booting) {
      if (motion && sp < 1) { drawSnow(); snow.style.opacity = String(1 - sp * sp); }
      else snow.style.opacity = "0";
    }

    // 入场：0.45 秒，透明度 + 位移，ease-out
    const e = motion ? easeOut(clamp01((t - 0.12) / 0.45)) : clamp01((t - 0.12) / 0.2);
    n.card.style.opacity = String(e);
    n.card.style.transform = motion ? `translateY(${(1 - e) * 14}px)` : "";

    // 数字卡：0.9 秒数到源数据的值，停在精确值上
    if (n.val) {
      if (n.target == null) n.val.textContent = "";
      else {
        const p = motion ? easeOut(clamp01((t - 0.3) / 0.9)) : 1;
        const shown = p >= 1 ? n.target : Math.round(n.target * p);
        n.val.textContent = fmt.format(shown);
      }
    }

    // 标题卡：正在念的那句，对应关键词亮起
    if (n.termNodes) {
      const live = roundAt(item.rounds, t);
      n.termNodes.forEach((node, i) => node.toggleAttribute("data-live", i === live));
    }

    n.fill.style.transform = `scaleX(${clamp01(t / dur)})`;
    const d = new Date(nowMs);
    n.clock.textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  return { render, powerOn, get on() { return tv.hasAttribute("data-on"); } };
}
