// 条目的「新鲜度时间」（2026-10-09 产品定）：
// - 文章类（HN / AIHOT）：publishedAt = 来源的真实发布时间（HN 帖子时间、原文 / 官方 RSS / 官方 X 帖的时间）。
// - 榜单类（PH 日榜、GitHub Trending）：dateKind "ranked"，按上榜时间算，跟文章发布时间分开：
//     PH = 那一天日榜结束的时间（洛杉矶午夜）；GitHub = 我们第一次在 trending 上看到它的时间。
//   开关：环境变量 RANKED_SOURCES（逗号分隔，默认 "producthunt,github"；设成 "none" 全关 → 这两类按 publishedAt，
//   PH 是 featuredAt，GitHub 没有 → 未知 → 下线）。
// - 没有真实时间 = unknown：不拿抓取时间顶替。
import { phLeaderboardDate } from "./sources.js";

export const DEFAULT_RANKED = ["producthunt", "github"];
export const SOURCE_KEY = { "Product Hunt": "producthunt", "GitHub Trending": "github" };
export function parseRanked(v) {
  if (v == null || String(v).trim() === "") return new Set(DEFAULT_RANKED);
  return new Set(String(v).toLowerCase().split(/[,\s]+/).filter((x) => x && x !== "none"));
}
const DEFAULT_SET = parseRanked();

// 洛杉矶 y-m-d 的下一天 00:00（夏令时 / 冬令时都对）
export function laMidnightAfter({ y, m, d }) {
  for (const h of [7, 8]) {
    const t = Date.UTC(y, m - 1, d + 1, h);
    const hh = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(new Date(t)));
    if (hh === 0) return t;
  }
  return null;
}
// 按抓取时间算出抓的是哪一天的 PH 日榜，返回那份榜结束的时间
export const phListEnd = (fetchedAt) => (fetchedAt == null ? null : laMidnightAfter(phLeaderboardDate(fetchedAt)));

export function rankedAtOf(it) {
  if (it.rankedAt != null) return it.rankedAt;
  const s = SOURCE_KEY[it.source];
  if (s === "producthunt") return phListEnd(it.fetchedAt);
  if (s === "github") return it.fetchedAt ?? null; // 老条目没记「第一次看到」：抓到它那一刻就是第一次在 trending 上看到
  return null;
}
// { t, kind }：kind = "ranked" | "published" | "unknown"
export function timeOf(it, ranked = DEFAULT_SET) {
  const s = SOURCE_KEY[it?.source];
  if (s && ranked.has(s)) { const t = rankedAtOf(it); if (t != null) return { t, kind: "ranked" }; }
  return it?.publishedAt == null ? { t: null, kind: "unknown" } : { t: it.publishedAt, kind: "published" };
}
export const ageOf = (it, now, ranked) => { const { t } = timeOf(it, ranked); return t == null ? Infinity : now - t; };
// 候选排序（每轮挑新条目时用）：按时间从新到旧——文章按 publishedAt，榜单类按 rankedAt（同 timeOf）。
// AIHOT 读原文前没有发布时间：只拿它的 aihotLatestAt（AIHOT 上最后活跃时间）排先后，不拿它判新鲜。都没有的排最后。同一时间保持原顺序。
export const sortTimeOf = (it, ranked = DEFAULT_SET) => timeOf(it, ranked).t ?? it?.aihotLatestAt ?? -Infinity;
export function newestFirst(items, ranked = DEFAULT_SET) {
  return items.map((it, i) => ({ it, i, t: sortTimeOf(it, ranked) })).sort((a, b) => b.t - a.t || a.i - b.i).map((x) => x.it);
}
// 节目单对外：每条带 publishedAt、dateKind，榜单类再带 rankedAt
export function annotate(it, ranked = DEFAULT_SET) {
  const { t, kind } = timeOf(it, ranked);
  const out = { ...it, publishedAt: it.publishedAt ?? null, dateKind: kind };
  if (kind === "ranked") out.rankedAt = t; else delete out.rankedAt;
  return out;
}

// 有效期（产品 2026-10-09）：文章 6 小时新鲜、6–12 小时可当补位、12 小时以上下线；
// 榜单（dateKind ranked）从 rankedAt 起 24 小时有效（PH：今天 15:00 结束的榜到明天 15:00），不当补位，24 小时一到就下。
export const ARTICLE_FRESH_MS = 6 * 3600_000, ARTICLE_FILLER_MS = 12 * 3600_000, RANKED_VALID_MS = 24 * 3600_000;
export function windowOf(it, ranked = DEFAULT_SET) {
  return timeOf(it, ranked).kind === "ranked" ? { fresh: RANKED_VALID_MS, filler: null } : { fresh: ARTICLE_FRESH_MS, filler: ARTICLE_FILLER_MS };
}
// 是否在新鲜期内（未知时间 = 不新鲜）
export const isFresh = (it, now, ranked) => ageOf(it, now, ranked) <= windowOf(it, ranked).fresh;
// 是否可当补位（只有文章，6–12 小时）
export const isFiller = (it, now, ranked) => { const w = windowOf(it, ranked), a = ageOf(it, now, ranked); return w.filler != null && a > w.fresh && a <= w.filler; };
