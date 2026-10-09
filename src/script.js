// 口播句式（固定模板）。每条两句：A 念标题，B 念数字。数字只经 {{字段}} 进来。
import { buildSpoken } from "./validate.js";

const has = (f, k) => f[k] !== undefined && f[k] !== null && f[k] !== "";

export function templatesFor(item) {
  const f = item.fields;
  switch (item.source) {
    case "Hacker News":
      return [
        "Hacker News 热榜第 {{rank}} 名：{{title}}。",
        has(f, "points") && has(f, "comments") ? "目前 {{points}} 分，{{comments}} 条评论。" : null,
      ];
    case "GitHub Trending":
      return [
        "GitHub 今日趋势第 {{rank}} 名：{{title}}。",
        has(f, "starsToday") && has(f, "stars") ? "今天新增 {{starsToday}} 颗星，累计 {{stars}} 颗星。" : null,
      ];
    case "Product Hunt":
      return ["Product Hunt 今日上新：{{title}}。", has(f, "tagline") ? "{{tagline}}" : null];
    case "AIHOT": {
      const parts = [];
      if (has(f, "sourceCount")) parts.push("被 {{sourceCount}} 个来源报道");
      if (has(f, "discussions")) parts.push("{{discussions}} 条讨论");
      return [has(f, "rank") ? "AI 热点第 {{rank}} 名：{{title}}。" : "AI 热点：{{title}}。", parts.length ? parts.join("，") + "。" : null];
    }
    default:
      return ["{{title}}。"];
  }
}

// 返回口播句子数组；任何一句校验不过，整条丢掉（返回 null）
export function spokenLines(item) {
  const lines = [];
  for (const tpl of templatesFor(item).filter(Boolean)) {
    const s = buildSpoken(tpl, item.fields);
    if (s == null) return null;
    lines.push(s.length > 290 ? s.slice(0, 288) + "。" : s);
  }
  return lines;
}
