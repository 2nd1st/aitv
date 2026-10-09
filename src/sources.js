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
//   publishedAt: 1759990000000,   // 来源给的发布时间，没有就是 null（AIHOT 在补料时从原文读，读不到 null + dateUnknown: true）
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

// Product Hunt 公开 Atom feed 不带票数、顺序也不是名次。保留这个解析器备用，SOURCES 里改用昨天的日榜页（见下）。
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

// ---------- Product Hunt 日榜（昨天，PH 自己的太平洋时间那一天，已经结束、名次定了）----------
// 页面：https://www.producthunt.com/leaderboard/daily/YYYY/M/D ，HTML 里内嵌 Apollo 的 SSR 数据
// （<script>(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push({...})</script>）。
// 榜单在 homefeedItems.edges 里，每条 edge.node 是 "Post"（真上榜的产品）或 "Ad"（广告位，跳过）。
// 只看 edges 这一层的 node：Ad 里面嵌着的 post（广告推的产品）不算上榜，不会被数进来。
export const PH_TOP_N = 10;

// 昨天（America/Los_Angeles）的年月日。PH 的一天按太平洋时间算，零点切榜。
export function phLeaderboardDate(now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(new Date(now)).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
export const phLeaderboardUrl = (now = Date.now()) => { const { y, m, d } = phLeaderboardDate(now); return `https://www.producthunt.com/leaderboard/daily/${y}/${m}/${d}`; };
const isoDay = ({ y, m, d }) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// 把页面里所有 Apollo SSR 数据块解析成对象（里面有 JS 的 undefined，不是严格 JSON，先换成 null）
export function apolloBlobs(html) {
  const out = [];
  for (const m of String(html).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const s = m[1];
    if (!s.includes("ApolloSSRDataTransport")) continue;
    const a = s.indexOf(".push("), b = s.lastIndexOf(")");
    if (a < 0 || b <= a) continue;
    try { out.push(JSON.parse(s.slice(a + 6, b).replace(/:undefined(?=[,}\]])/g, ":null"))); } catch { /* 这一块坏了，看下一块 */ }
  }
  return out;
}

// 在 node 自己身上找 TopPostBadge（日榜、指定日期）；不钻进嵌套的 Post / Ad（那是别的产品）
function dailyBadge(node, day) {
  let hit = null;
  const walk = (o, top) => {
    if (!o || typeof o !== "object" || hit) return;
    if (!top && (o.__typename === "Post" || o.__typename === "Ad")) return;
    if (o.__typename === "TopPostBadge" && o.period === "daily" && String(o.date || "").slice(0, 10) === day && Number.isInteger(Number(o.position))) { hit = Number(o.position); return; }
    for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v, false);
  };
  walk(node, true);
  return hit;
}

// 每批的合理性检查：不过就把 phDailyRank / phScore 从这一批所有条目里拿掉（条目照留）
export function checkPHBatch(rows, { titleDay, day } = {}) {
  const errors = [];
  if (!rows.length) errors.push("没有上榜产品");
  if (titleDay && day && titleDay !== day) errors.push(`页面标题的日期 ${titleDay} 不是要的 ${day}`);
  rows.forEach((r, i) => {
    if (r.typename !== "Post") errors.push(`第 ${i + 1} 条不是 Post（${r.typename}）`);
    if (r.rank !== i + 1) errors.push(`名次不连续：第 ${i + 1} 条是 ${r.rank}`);
    if (r.badgeRank != null && r.badgeRank !== r.orderRank) errors.push(`${r.name}：官方徽章 ${r.badgeRank} 跟榜单顺序 ${r.orderRank} 不一致`);
    if (r.dailyRank != null && r.dailyRank !== r.rank) errors.push(`${r.name}：dailyRank ${r.dailyRank} 跟名次 ${r.rank} 不一致`);
    if (!Number.isFinite(r.score)) errors.push(`${r.name}：没有 launchDayScore`);
    if (i > 0 && Number.isFinite(r.score) && Number.isFinite(rows[i - 1].score) && r.score > rows[i - 1].score) errors.push(`分数没有随名次递减：第 ${i} 名 ${rows[i - 1].score} < 第 ${i + 1} 名 ${r.score}`);
  });
  return { ok: errors.length === 0, errors };
}

// 返回条目数组；数组上挂 .check = { ok, errors, day }，方便日志 / 冒烟脚本看为什么丢了名次
export function parsePHLeaderboard(html, fetchedAt, { day = isoDay(phLeaderboardDate(fetchedAt)), top = PH_TOP_N } = {}) {
  // 选 Post 最多的那个 homefeedItems（SSR 里 rehydrate 和 events 各有一份，内容一样）
  let edges = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    const e = o.homefeedItems?.edges;
    if (Array.isArray(e) && e.filter((x) => x?.node?.__typename === "Post").length > edges.filter((x) => x?.node?.__typename === "Post").length) edges = e;
    for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v);
  };
  for (const b of apolloBlobs(html)) walk(b);
  const posts = [];
  const seen = new Set();
  for (const e of edges) {
    const n = e?.node;
    if (!n || n.__typename !== "Post") continue; // 广告位（Ad）跳过，不占名次
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    posts.push(n);
  }
  const t = (String(html).match(/<title>[^<]*?Best of Product Hunt:\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/) || []);
  const titleDay = t[1] && MONTHS.includes(t[1].toLowerCase()) ? isoDay({ y: Number(t[3]), m: MONTHS.indexOf(t[1].toLowerCase()) + 1, d: Number(t[2]) }) : null;
  const rows = posts.slice(0, top).map((n, i) => {
    const badgeRank = dailyBadge(n, day);
    const orderRank = i + 1;
    const dr = n.dailyRank == null || n.dailyRank === "" ? null : Number(n.dailyRank);
    return { node: n, typename: n.__typename, name: n.name, orderRank, badgeRank, dailyRank: Number.isInteger(dr) ? dr : null,
      rank: badgeRank ?? orderRank, score: typeof n.launchDayScore === "number" ? n.launchDayScore : NaN };
  });
  const check = { ...checkPHBatch(rows, { titleDay, day }), day };
  const items = rows.map((r) => {
    const n = r.node;
    const featured = Date.parse(n.featuredAt || n.scheduledAt || "");
    return item({
      id: `ph-${n.id}`,
      source: "Product Hunt",
      url: `https://www.producthunt.com/posts/${encodeURIComponent(n.slug)}`,
      fetchedAt,
      publishedAt: Number.isFinite(featured) ? featured : null, // featuredAt：上 PH 首页（开始参加当天日榜）的时间
      fields: {
        title: n.name,
        tagline: n.tagline,
        // phDailyRank：这个产品在 PH「昨天」（太平洋时间那一天）日榜 producthunt.com/leaderboard/daily/Y/M/D 上的最终名次，从 1 开始。
        //   按页面上真实 Post 的先后顺序数，广告位不占名次；有官方 TopPostBadge（period=daily、date=那一天）时以徽章的 position 为准。
        phDailyRank: check.ok ? r.rank : null,
        // phScore：Post.launchDayScore，PH 自己的上榜当天综合分（投票、讨论等加权，页面说明「Scores … reflect … voting, discussion, and overall activity」）。
        //   不是票数，不许念成「票」。
        phScore: check.ok && Number.isFinite(r.score) ? r.score : null,
        // comments：Post.commentsCount，这个产品发布帖下的评论总数（抓取时）。
        //   这一批没通过合理性检查（名次不是 1..N 连续、名次靠后的分数反而更高……）时，PH 的数字整批都不给，评论数也不给。
        comments: check.ok && typeof n.commentsCount === "number" ? n.commentsCount : null,
      },
    });
  });
  // 产品自己的缩略图（thumbnailImageUuid）就是产品图标 = logo，不拿来当配图；配图在补料时取发布页的 og:image（PH 自己的图库 ph-files.imgix.net）
  Object.defineProperty(items, "check", { value: check, enumerable: false });
  return items;
}

// 兼容两种返回：新版 aihot.news/api/v1（source 是对象、链接在 links 里）和旧版 /api/public（10 月 31 日停用）。
// 只取白名单字段；notice / hint 这类写给 AI 助手的东西一律不进 item。
export function parseAIHOT(json, fetchedAt) {
  return (json.items || []).map((x) => {
    const links = x.links || {};
    const permalink = links.aihot || x.permalink;
    // links.story 是给人看的页面；按文档只取最后一段当 publicId，再调 /api/v1/stories/{publicId}
    const storyId = links.story ? links.story.split("/").filter(Boolean).pop() : null;
    // latestAt 是这条事件在 AIHOT 上的「最后活跃时间」，不是原文发布时间：不当 publishedAt。
    // 发布时间在补料时从原文页面读（enrich.js extractPublishedAt）；读到之前 publishedAt = null、dateUnknown = true。
    const latest = x.latestAt ? Date.parse(x.latestAt) : NaN;
    const it = item({
      id: `aihot-${x.id}`,
      source: "AIHOT",
      url: links.original || x.url || permalink,
      fetchedAt,
      publishedAt: null,
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
    // aihotLatestAt 只给补料时判断「原文是不是旧链接」用，不进 seed（writer.js SEED_KEYS 里没有它）
    // 包打听若从厂商官方 X 帖子（链到同一个 URL）拿到了发布时间，会带 pubDate + pubDateSource: "x"：原样带上，补料时作第三顺位兜底
    const xDate = x.pubDateSource === "x" && x.pubDate != null ? { pubDate: x.pubDate, pubDateSource: "x" } : {};
    return { ...it, dateUnknown: true, ...xDate, ...(Number.isFinite(latest) ? { aihotLatestAt: latest } : {}) };
  });
}

// ---------- 抓取 ----------

export const SOURCES = {
  hn: { url: "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30", kind: "json", parse: parseHN },
  github: { url: "https://github.com/trending?since=daily", kind: "text", parse: parseGitHubTrending },
  // 昨天（太平洋时间）已经结束的 PH 日榜；url 按抓取时间算
  producthunt: { url: (now) => phLeaderboardUrl(now), kind: "text", parse: (html, now) => parsePHLeaderboard(html, now) },
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
        const res = await fetchImpl(typeof s.url === "function" ? s.url(now) : s.url, {
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
