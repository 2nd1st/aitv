import { numberViolations } from "./digits.js";
// 数字硬校验（查模板，不查渲染后的稿子）。
// 1. 模板正文里不许出现任何数字：阿拉伯数字，或中文数字/倍数词。数字只能经 {{字段}} 进来。
// 2. 数字字段绑死自己的单位：{{points}} 后面必须紧跟「分」，模型只能挑句式，不能换单位或对调字段。
// 3. 文本字段（标题等）原样插入，里面带的数字来自源数据本身。
// 常用词白名单（一个、一句话、统一、十分……）和数字规则在 digits.js，与 enrich.js 共用。

// 规则 A：每个字段写明它在源接口里到底是什么数；含义没核实的字段不许进稿（已删 votes / sourceCount / discussions，
// HN 和 Product Hunt 的 rank 也已在 sources.js 去掉）。
export const UNITS = {
  // Hacker News（hn.algolia.com/api/v1 的 hit.points）：这条帖子在 HN 上的得分，即投票分（upvote score）。
  points: { after: " 分" },
  // 评论总数（抓取时）：Hacker News 是 hit.num_comments（帖子下的评论数）；
  //   Product Hunt 日榜是 Post.commentsCount（这个产品发布帖下的评论数）。
  comments: { after: " 条评论" },
  // GitHub Trending（github.com/trending?since=daily 每行指向 /stargazers 的数字）：仓库累计 star 总数（抓取时）。
  stars: { after: " 颗星" },
  // GitHub Trending（每行「N stars today」）：按 Trending 页面，该仓库今天新增的 star 数。
  starsToday: { after: " 颗星" },
  // GitHub Trending（每行指向 /forks 的数字）：仓库累计 fork 总数（抓取时）。
  forks: { after: " 次" },
  // 名次，只有两处来源：
  //   GitHub Trending：在 github.com/trending?since=daily 当日列表里的位置（从 1 开始，按 GitHub 页面显示顺序）。
  //   AIHOT：openapi-v1.json 定义为「One-based position in the current AIHOT Top 10 response」。
  //   Hacker News、Product Hunt 不给 rank（返回顺序不是名次）；Product Hunt 的日榜名次单独叫 phDailyRank（见下）。
  rank: { before: "第 ", after: " 名" },
  // Product Hunt（producthunt.com/leaderboard/daily/Y/M/D，Y/M/D = 抓取时太平洋时间的昨天，那一天的榜已经结束）：
  //   这个产品在昨天日榜上的最终名次，从 1 开始；按页面上真实 Post 的顺序数，广告位不占名次，有官方 TopPostBadge 时以它为准。
  //   只能念成「昨天 Product Hunt 日榜第 N 名」，不许说「今天」（sources.js 那一批名次没通过合理性检查时这个字段整批不给）。
  phDailyRank: { before: "昨天 Product Hunt 日榜第 ", after: " 名" },
  // Product Hunt（同一页 Post.launchDayScore）：PH 自己算的上榜当天综合分（投票、讨论、活跃度加权），不是票数，不许说成「票」。
  //   只能念成「综合分 N 分」（before 强制），不许说「票」（writer.js checkScript 对 PH 稿子全文拦「票」）。
  phScore: { before: "综合分 ", after: " 分" },
  // TechCrunch AI 频道融资稿（sources.js parseTechCrunchAI）：这篇报道的标题 / 简介里明文写的这一轮融资金额，单位美元（只认「$」金额）。
  //   代码按正则从原文字面取，不是模型估的；只在是确数时给（「over $500M」这类不给）；估值、营收不算。只能念成「融资 N 美元」。
  //   念的时候换成「亿 / 万」：200000000 念成「融资 2 亿美元」，50000000 念成「融资 5000 万美元」（format 只换写法，不改数值）。
  fundingUsd: {
    before: "融资 ",
    after: " 美元",
    format: (n) => (n >= 1e8 ? `${Number((n / 1e8).toFixed(2))} 亿` : n >= 1e4 ? `${Number((n / 1e4).toFixed(0))} 万` : String(n)),
  },
};
export const TEXT_FIELDS = new Set(["title", "description", "language", "tagline", "origin", "what", "who", "highlight", "title_zh", "name", "limit"]);

const SLOT = /\{\{(\w+)\}\}/g;

export function checkTemplate(template, fields) {
  const errors = [];
  // 先去掉 {{字段}}，再由 digits.js 去掉白名单常用词（一个、一句话、统一……），剩下的一律不许有数字
  const v = numberViolations(template.replace(SLOT, " "));
  if (v.includes("arabic")) errors.push("模板正文里有阿拉伯数字");
  if (v.includes("chinese")) errors.push("模板正文里有中文数字或倍数词");
  for (const m of template.matchAll(SLOT)) {
    const k = m[1];
    if (!(k in fields)) { errors.push(`未知字段 ${k}`); continue; }
    if (TEXT_FIELDS.has(k)) continue;
    const u = UNITS[k];
    if (!u) { errors.push(`字段 ${k} 没有绑定单位，不许进稿`); continue; }
    const before = template.slice(0, m.index);
    const after = template.slice(m.index + m[0].length);
    if (u.after && !after.startsWith(u.after)) errors.push(`{{${k}}} 后面必须是「${u.after.trim()}」`);
    if (u.before && !before.endsWith(u.before)) errors.push(`{{${k}}} 前面必须是「${u.before.trim()}」`);
  }
  return { ok: errors.length === 0, errors };
}

export function renderScript(template, fields) {
  return template.replace(SLOT, (_, k) => {
    const f = UNITS[k]?.format;
    return f && typeof fields[k] === "number" ? f(fields[k]) : String(fields[k]);
  });
}

// 返回 null 表示这条必须丢掉
export function buildSpoken(template, fields) {
  if (!checkTemplate(template, fields).ok) return null;
  return renderScript(template, fields);
}
