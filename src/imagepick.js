// 配图筛选：宁可没图，也不要不相干的图。只决定「要不要」，下载 / 格式 / 大小仍然只走 images.js 的 storeImage。
// 图只上屏，不进写稿模型（writer.js scriptFields 只给文本和数字字段；enrich.js 的提示词只有原文正文）。
//
// 不要的图（给出原因，方便日志里看）：
// - 纯 logo：地址 / 文件名里有 logo、favicon、icon、avatar、brand；尺寸太小（长边 < 300）或接近正方形的小图（长边 ≤ 512）；
//   画面太素（每像素字节数很低，基本是纯色底 + 字标，比如 Anthropic 的字标卡），og:image:alt 写着 logo 时门槛放宽。
// - 聚合站的通用分享卡：AIHOT（aihot.news / aihot.virxact.com）的图一律不要；跟这个站首页的 og:image 一模一样的也不要（站点默认图）。
// - 跟文章不是同一个可注册域名、又不是常见 CDN 的图（第三方的图很可能是别人的东西）。
import { storeImage, sniffImage } from "./images.js";

export const AGGREGATOR_HOSTS = ["aihot.news", "aihot.virxact.com"];
// 常见图片 CDN：图放在这些域名下算正常（站点自己的素材托管在 CDN 上）
export const CDN_DOMAINS = [
  "githubusercontent.com", "githubassets.com", "imgix.net", "cloudfront.net", "ctfassets.net", "cloudinary.com",
  "sanity.io", "website-files.com", "wp.com", "googleusercontent.com", "akamaized.net", "fastly.net", "imagedelivery.net",
  "framerusercontent.com", "substackcdn.com", "storage.googleapis.com", "hubspotusercontent-na1.net", "squarespace-cdn.com",
  "wixstatic.com", "b-cdn.net", "public.blob.vercel-storage.com",
];
// 这些后缀下面每个子域名是不同的站（a.github.io 和 b.github.io 不是一家）
const MULTI_SUFFIX = ["github.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "herokuapp.com", "substack.com", "medium.com", "blogspot.com"];
const SLD = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go"]);

export function registrableDomain(host) {
  host = String(host || "").toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(host) || !host.includes(".")) return host;
  for (const s of MULTI_SUFFIX) if (host === s || host.endsWith("." + s)) {
    const rest = host.slice(0, -(s.length + 1)).split(".").filter(Boolean);
    return rest.length ? `${rest.pop()}.${s}` : s;
  }
  const p = host.split(".");
  const n = p.length >= 3 && p[p.length - 1].length === 2 && SLD.has(p[p.length - 2]) ? 3 : 2;
  return p.slice(-n).join(".");
}
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
const underAny = (host, list) => list.some((d) => host === d || host.endsWith("." + d));
export const isAggregatorHost = (host) => underAny(String(host).toLowerCase(), AGGREGATOR_HOSTS);

const LOGO_WORD = /(^|[^a-z])(logos?|favicons?|icons?|avatars?|brand|branding|brandmark|wordmark)([^a-z]|$)/i;
const norm = (u) => { try { const x = new URL(u); return `${x.hostname}${x.pathname}`.toLowerCase(); } catch { return String(u); } };

// 下载前按地址 / meta 判断。返回 { ok, reason }
export function screenImageUrl(imageUrl, pageUrl, { width, height, homepageImage } = {}) {
  let img, page;
  try { img = new URL(imageUrl, pageUrl); page = new URL(pageUrl); } catch { return { ok: false, reason: "地址不合法" }; }
  if (img.protocol !== "https:") return { ok: false, reason: "不是 https" };
  if (isAggregatorHost(page.hostname)) return { ok: false, reason: `聚合站页面（${page.hostname}）的分享卡` };
  if (isAggregatorHost(img.hostname)) return { ok: false, reason: `聚合站（${img.hostname}）的图` };
  const pathq = decodeURIComponent(img.pathname + img.search).toLowerCase();
  const m = pathq.match(LOGO_WORD);
  if (m) return { ok: false, reason: `地址里有「${m[2]}」，像 logo / 图标` };
  if (/\.svg(\?|$)/.test(img.pathname)) return { ok: false, reason: "SVG（多半是 logo）" };
  const w = Number(width), h = Number(height);
  if (w > 0 && h > 0) {
    const r = sizeReason(w, h);
    if (r) return { ok: false, reason: `meta 里写的尺寸 ${w}×${h}：${r}` };
  }
  if (homepageImage && norm(homepageImage) === norm(img.href)) return { ok: false, reason: "跟站点首页的 og:image 一样（站点默认分享图）" };
  const a = registrableDomain(img.hostname), b = registrableDomain(page.hostname);
  // X / Twitter 帖子：帖子里的图在 X 自己的 CDN（pbs.twimg.com/media 等）；头像、个人页横幅不要
  if (["x.com", "twitter.com"].includes(b) && img.hostname === "pbs.twimg.com") {
    if (/^\/(profile_images|profile_banners)\//.test(img.pathname)) return { ok: false, reason: "X 用户头像 / 横幅" };
    if (/^\/(media|amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\//.test(img.pathname)) return { ok: true, reason: "" };
    return { ok: false, reason: `X 上不认识的图片路径（${img.pathname.split("/")[1]}）` };
  }
  if (a !== b && !underAny(img.hostname, CDN_DOMAINS)) {
    const brand = b.split(".")[0];
    if (!(brand.length >= 4 && a.split(".")[0].includes(brand))) return { ok: false, reason: `图在别的域名（${img.hostname}），跟文章（${page.hostname}）没有明确的 CDN 关系` };
  }
  return { ok: true, reason: "" };
}

function sizeReason(w, h) {
  const long = Math.max(w, h), short = Math.min(w, h);
  if (long < 300) return "太小（长边不到 300），像图标";
  if (short / long > 0.85 && long <= 512) return "接近正方形的小图，像 logo";
  return null;
}

// 从文件头读宽高（png / jpg / webp），读不出来返回 null
export function imageSize(bytes) {
  const b = bytes, ext = sniffImage(b);
  const u16 = (i) => (b[i] << 8) | b[i + 1], le16 = (i) => b[i] | (b[i + 1] << 8), le24 = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  try {
    if (ext === "png" && b.length >= 24) return { width: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, height: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0 };
    if (ext === "jpg") {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const mk = b[i + 1];
        if (mk === 0xff) { i++; continue; }
        if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
        const len = u16(i + 2);
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { width: u16(i + 7), height: u16(i + 5) };
        i += 2 + len;
      }
      return null;
    }
    if (ext === "webp" && b.length >= 30) {
      const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (kind === "VP8X") return { width: le24(24) + 1, height: le24(27) + 1 };
      if (kind === "VP8L") { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }; }
      if (kind === "VP8 ") return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    }
  } catch { /* 读不出来 */ }
  return null;
}

// 下载后按真实字节判断：尺寸、画面素不素。logoAlt：og:image:alt 写着 logo（门槛放宽）
export function screenImageBytes(bytes, { logoAlt = false } = {}) {
  const s = imageSize(bytes);
  if (!s || !(s.width > 0) || !(s.height > 0)) return { ok: true, reason: "", size: null }; // 尺寸读不出来不据此拒
  const r = sizeReason(s.width, s.height);
  if (r) return { ok: false, reason: `${s.width}×${s.height}：${r}`, size: s };
  const bpp = bytes.length / (s.width * s.height);
  const floor = logoAlt ? 0.04 : 0.012;
  if (bpp < floor) return { ok: false, reason: `画面太素（${bpp.toFixed(4)} 字节/像素${logoAlt ? "，alt 写着 logo" : ""}），像纯 logo / 字标卡`, size: s };
  return { ok: true, reason: "", size: s };
}

// 筛过再存：先按地址判断，再经 storeImage 下载（https、jpg/png/webp 文件头、不收 SVG、≤ 2MB 都在那里），
// 写进桶之前按真实字节再判断一次。返回 { image: "/img/<key>" | null, reason }，从不抛错。
export async function storeScreenedImage(store, imageUrl, pageUrl, { fetch = globalThis.fetch, hint = {}, timeoutMs } = {}) {
  try {
    if (!imageUrl) return { image: null, reason: "原文没有 og:image / twitter:image" };
    if (!store) return { image: null, reason: "没有存储" };
    const pre = screenImageUrl(imageUrl, pageUrl, hint);
    if (!pre.ok) return { image: null, reason: pre.reason };
    let verdict = null;
    // 包一层桶：storeImage 调 put 时先看字节，不合格就不写（head 总说没有，保证每次都能看到字节）
    const gate = {
      head: async () => null,
      put: async (key, bytes, opts) => {
        verdict = screenImageBytes(bytes, { logoAlt: !!hint.logoAlt });
        if (!verdict.ok) return;
        if (!(await store.head(key))) await store.put(key, bytes, opts);
      },
    };
    const image = await storeImage(gate, imageUrl, pageUrl, { fetch, ...(timeoutMs ? { timeoutMs } : {}) });
    if (verdict && !verdict.ok) return { image: null, reason: verdict.reason };
    if (!image) return { image: null, reason: "下载失败或格式 / 大小不合格（storeImage 返回 null）" };
    return { image, reason: verdict?.size ? `${verdict.size.width}×${verdict.size.height}` : "" };
  } catch (e) {
    return { image: null, reason: `出错：${e.message || e}` };
  }
}
