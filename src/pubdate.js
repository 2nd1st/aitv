// 发布时间的兜底顺序（原文页面读不到日期、或站点挡抓取时）：
//   ① 原文页面（enrich.js extractPublishedAt）→ pubDateSource: "page"
//   ② 官方 RSS：按域名查表，按链接匹配（去掉 query / hash / 结尾斜杠、忽略 www）取 pubDate → "rss"
//   ③ 包打听给的、厂商官方 X 帖子（链到同一个 URL）的发布时间：输入里带 pubDate + pubDateSource: "x" 才认 → "x"
//      （Worker 里不调 X。）
//   ④ 都没有 → 不播。永远不拿抓取时间顶替。
// 2026-10-09 实测：openai.com 从 box 抓页面 403，从 Worker 抓 200 且页面 <time> 能读到日期；RSS 从两边都是 200。
export const RSS_FEEDS = {
  "openai.com": "https://openai.com/news/rss.xml",
  "deepmind.google": "https://deepmind.google/blog/rss.xml",
  // 其他厂商加在这里：域名（不带 www）→ 官方 RSS 地址
};
const UA = "Mozilla/5.0 (aitv.qiaomu.ai; +https://aitv.qiaomu.ai)";

export function normUrl(u) {
  try {
    const x = new URL(String(u).trim());
    return `${x.hostname.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`;
  } catch { return null; }
}
export const okDate = (t, now = Date.now()) => Number.isFinite(t) && t > Date.UTC(2000, 0, 1) && t <= now + 86400e3;

const cdata = (s) => String(s || "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
// RSS 2.0（<item><link>/<guid>/<pubDate>）和 Atom（<entry><link href>/<published>|<updated>）都认
export function parseFeedDates(xml) {
  const map = new Map();
  const add = (link, t) => { const k = normUrl(cdata(link)); if (k && Number.isFinite(t) && !map.has(k)) map.set(k, t); };
  for (const m of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const b = m[1];
    const t = Date.parse(cdata((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || (b.match(/<dc:date>([\s\S]*?)<\/dc:date>/i) || [])[1]));
    add((b.match(/<link>([\s\S]*?)<\/link>/i) || [])[1], t);
    add((b.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i) || [])[1], t);
  }
  for (const m of String(xml).matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const b = m[1];
    const t = Date.parse(cdata((b.match(/<published>([\s\S]*?)<\/published>/i) || b.match(/<updated>([\s\S]*?)<\/updated>/i) || [])[1]));
    for (const l of b.matchAll(/<link\b[^>]*href=["']([^"']+)["']/gi)) add(l[1], t);
  }
  return map;
}

const feedCache = new Map(); // feedUrl → { at, map }（同一轮 / 十分钟内不重复抓）
export const _clearFeedCache = () => feedCache.clear();
export async function rssPubDate(url, { fetchImpl = fetch, now = Date.now(), feeds = RSS_FEEDS, timeoutMs = 12000 } = {}) {
  const k = normUrl(url);
  if (!k) return null;
  const host = k.split("/")[0];
  const feed = feeds[host];
  if (!feed) return null;
  let c = feedCache.get(feed);
  if (!c || now - c.at > 10 * 60_000) {
    try {
      const res = await fetchImpl(feed, { headers: { "user-agent": UA, accept: "application/rss+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      c = { at: now, map: parseFeedDates(await res.text()) };
      feedCache.set(feed, c);
    } catch { return null; }
  }
  const t = c.map.get(k);
  return okDate(t, now) ? { publishedAt: t, pubDateSource: "rss", pubDateFeed: feed } : null;
}

// ③ 输入里带的 X 发布时间（包打听从厂商官方 X 帖子拿的）
export function xPubDate(item, now = Date.now()) {
  if (item?.pubDateSource !== "x" || item.pubDate == null) return null;
  const t = typeof item.pubDate === "number" ? item.pubDate : Date.parse(item.pubDate);
  return okDate(t, now) ? { publishedAt: t, pubDateSource: "x" } : null;
}

// 原文页面没给日期时按 ②③ 找；都没有返回 null（→ 不播）
export async function fallbackPubDate(item, opts = {}) {
  return (await rssPubDate(item.url, opts)) || xPubDate(item, opts.now) || null;
}
