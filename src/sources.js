// 抓榜模块（包打听）：HN、GitHub Trending、Product Hunt、AIHOT → 统一 item。
// 只用 fetch 和字符串解析，Worker 和 Node 都能跑。数字原样保留在 fields 里，
// 口播稿只能用 {{字段}} 引用这些数，validate.js 负责硬校验。
//
// 统一 item（进节目单前的样子，start/duration/audio/spoken/rounds 由后面的流水线补）：
// {
//   id: "hn-41234567",            // 来源前缀 + 来源自己的 id，用来跨轮去重
//   source: "Hacker News",
//   url: "https://原文链接",
//   fetchedAt: 1760000000000,     // 这一轮抓到的时间（毫秒）
//   publishedAt: 1759990000000,   // 来源给的发布时间，没有就是 null
//   template: "number" | "title",
//   focus: "points",              // 数字卡读哪个字段；没有数字就不给
//   fields: { title: "...", points: 812, comments: 233 }
// }

const UA = "Mozilla/5.0 (aitv.qiaomu.ai; +https://aitv.qiaomu.ai)";

const toInt = (s) => (s == null ? null : Number(String(s).replace(/[^\d]/g, "")) || 0);
const decode = (s) =>
  String(s)
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

function item({ id, source, url, fetchedAt, publishedAt = null, focus = null, fields, storyId }) {
  // 去掉空字段，免得校验时混进 "null"
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== undefined && v !== ""));
  const hasFocus = focus && typeof clean[focus] === "number";
  return {
    id, source, url, fetchedAt, publishedAt,
    template: hasFocus ? "number" : "title",
    ...(hasFocus ? { focus } : {}),
    ...(storyId ? { storyId } : {}),
    fields: clean,
  };
}

// ---------- 解析：纯函数，测试用 fixtures 跑 ----------

export function parseHN(json, fetchedAt) {
  return (json.hits || []).map((h) =>
    item({
      id: `hn-${h.objectID}`,
      source: "Hacker News",
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      fetchedAt,
      publishedAt: h.created_at_i ? h.created_at_i * 1000 : null,
      focus: "points",
      // 不给 rank：Algolia search 的返回顺序是相关度排序，不是 HN 首页上的名次（未核实的数字不进稿）
      fields: { title: h.title, points: h.points, comments: h.num_comments },
    })
  );
}

export function parseGitHubTrending(html, fetchedAt) {
  const rows = html.split('<article class="Box-row">').slice(1).map((r) => r.split("</article>")[0]);
  return rows.map((r, i) => {
    const path = (r.match(/<h2[^>]*>\s*<a[^>]*href="\/([^"]+)"/) || [])[1];
    const desc = (r.match(/<p class="[^"]*color-fg-muted[^"]*">([\s\S]*?)<\/p>/) || [])[1];
    const lang = (r.match(/itemprop="programmingLanguage">([^<]+)</) || [])[1];
    const stars = (r.match(/href="\/[^"]+\/stargazers"[^>]*>[\s\S]*?([\d,]+)\s*<\/a>/) || [])[1];
    const forks = (r.match(/href="\/[^"]+\/forks"[^>]*>[\s\S]*?([\d,]+)\s*<\/a>/) || [])[1];
    const today = (r.match(/([\d,]+)\s+stars? today/) || [])[1];
    return item({
      id: `gh-${path}`,
      source: "GitHub Trending",
      url: `https://github.com/${path}`,
      fetchedAt,
      focus: "starsToday",
      fields: {
        title: path.replace("/", " / "),
        description: desc ? decode(desc) : null,
        language: lang ? decode(lang) : null,
        rank: i + 1,
        stars: toInt(stars),
        forks: toInt(forks),
        starsToday: toInt(today),
      },
    });
  }).filter((x) => x.url !== "https://github.com/undefined");
}

// Product Hunt 公开 Atom feed 不带票数；有 PH_TOKEN 时可以改走 GraphQL 补 votesCount。
export function parseProductHunt(xml, fetchedAt) {
  const entries = xml.split("<entry>").slice(1).map((e) => e.split("</entry>")[0]);
  return entries.slice(0, 15).map((e) => {
    const pick = (re) => (e.match(re) || [])[1];
    const postId = pick(/<id>[^<]*Post\/(\d+)<\/id>/);
    const content = pick(/<content[^>]*>([\s\S]*?)<\/content>/);
    const tagline = content ? decode(decode(content)).replace(/\s*Discussion\s*\|\s*Link\s*$/, "") : null;
    const pub = pick(/<published>([^<]+)<\/published>/);
    return item({
      id: `ph-${postId}`,
      source: "Product Hunt",
      url: pick(/<link rel="alternate" type="text\/html" href="([^"]+)"/),
      fetchedAt,
      publishedAt: pub ? Date.parse(pub) : null,
      // 公开 feed 的顺序不是当日排名，不给 rank，免得念成「拿了第几名」
      fields: { title: decode(pick(/<title>([\s\S]*?)<\/title>/) || ""), tagline },
    });
  });
}

// 兼容两种返回：新版 aihot.news/api/v1（source 是对象、链接在 links 里）和旧版 /api/public（10 月 31 日停用）。
// 只取白名单字段；notice / hint 这类写给 AI 助手的东西一律不进 item。
export function parseAIHOT(json, fetchedAt) {
  return (json.items || []).map((x) => {
    const links = x.links || {};
    const permalink = links.aihot || x.permalink;
    // links.story 是给人看的页面；按文档只取最后一段当 publicId，再调 /api/v1/stories/{publicId}
    const storyId = links.story ? links.story.split("/").filter(Boolean).pop() : null;
    return item({
      id: `aihot-${x.id}`,
      source: "AIHOT",
      url: links.original || x.url || permalink,
      fetchedAt,
      publishedAt: x.latestAt ? Date.parse(x.latestAt) : null,
      // sourceCount / signalCount 在 openapi-v1.json 里没有字段说明，含义没法核实，不进 item。
      // rank 有说明：「One-based position in the current AIHOT Top 10 response.」
      fields: {
        title: x.title,
        origin: typeof x.source === "object" && x.source ? x.source.name : x.source,
        rank: x.rank,
        permalink,
      },
      ...(storyId ? { storyId } : {}),
    });
  });
}

// ---------- 抓取 ----------

export const SOURCES = {
  hn: { url: "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30", kind: "json", parse: parseHN },
  github: { url: "https://github.com/trending?since=daily", kind: "text", parse: parseGitHubTrending },
  producthunt: { url: "https://www.producthunt.com/feed", kind: "text", parse: parseProductHunt },
  aihot: { url: "https://aihot.news/api/v1/hot-topics", kind: "json", parse: parseAIHOT },
};

// AIHOT 的 links.original 是这条事件最早那篇报道（比如 9/28 的 Sonnet 5.5 发布页），
// 事件后来有了新进展（10/7 Haiku 5.5 发布 + Sonnet 5.5 缓存降价）时会链错。
// 修法：读事件时间线，在跟 links.original 同一个站点的一手报道（firstParty）里取最新的一篇。
export function pickStoryUrl(original, story) {
  let host;
  try { host = new URL(original).hostname; } catch { return original; }
  const firsts = (story?.reports || [])
    .filter((r) => r.source?.firstParty && r.links?.original)
    .filter((r) => { try { return new URL(r.links.original).hostname === host; } catch { return false; } })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return firsts[0]?.links.original || original;
}
export async function refineAIHOTUrls(items, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  return Promise.all(items.map(async (it) => {
    if (it.source !== "AIHOT" || !it.storyId) return it;
    const { storyId, ...rest } = it;
    try {
      const res = await fetchImpl(`https://aihot.news/api/v1/stories/${encodeURIComponent(storyId)}`, {
        headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return rest;
      const url = pickStoryUrl(it.url, (await res.json()).story);
      return url === it.url ? rest : { ...rest, url, originalUrl: it.url };
    } catch { return rest; }
  }));
}

// 一个源挂了不影响别的源；errors 里记下来，节目单照常出。
export async function fetchAll({ fetchImpl = fetch, now = Date.now(), timeoutMs = 15000, only } = {}) {
  const names = only || Object.keys(SOURCES);
  const errors = {};
  const lists = await Promise.all(
    names.map(async (name) => {
      const s = SOURCES[name];
      try {
        const res = await fetchImpl(s.url, {
          headers: { "user-agent": UA, accept: s.kind === "json" ? "application/json" : "*/*" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = s.kind === "json" ? await res.json() : await res.text();
        let items = s.parse(body, now);
        if (!items.length) throw new Error("解析出 0 条，页面结构可能变了");
        if (name === "aihot") items = await refineAIHOTUrls(items, { fetchImpl, timeoutMs });
        return items;
      } catch (e) {
        errors[name] = String(e.message || e);
        return [];
      }
    })
  );
  return { fetchedAt: now, items: lists.flat(), errors };
}

// 跨轮去重：seen 是上一轮存下来的 id 集合（Worker 里放 KV）。
export function dedupe(items, seen = new Set()) {
  const out = [];
  const ids = new Set(seen);
  for (const it of items) {
    if (!it.url || ids.has(it.id)) continue;
    ids.add(it.id);
    out.push(it);
  }
  return out;
}

// 四个源轮流排，避免一个台连着播十条 GitHub。
export function interleave(items) {
  const by = new Map();
  for (const it of items) (by.get(it.source) || by.set(it.source, []).get(it.source)).push(it);
  const queues = [...by.values()];
  const out = [];
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) out.push(q.shift());
  return out;
}
