import { numberViolations } from "./digits.js";
// 数字硬校验（查模板，不查渲染后的稿子）。
// 1. 模板正文里不许出现任何数字：阿拉伯数字，或中文数字/倍数词。数字只能经 {{字段}} 进来。
// 2. 数字字段绑死自己的单位：{{points}} 后面必须紧跟「分」，模型只能挑句式，不能换单位或对调字段。
// 3. 文本字段（标题等）原样插入，里面带的数字来自源数据本身。
// 常用词白名单（一个、一句话、唯一、十分……）和数字规则在 digits.js，与 enrich.js 共用。

export const UNITS = {
  points: { after: " 分" },
  comments: { after: " 条评论" },
  stars: { after: " 颗星" },
  starsToday: { after: " 颗星" },
  forks: { after: " 次" },
  votes: { after: " 票" },
  rank: { before: "第 ", after: " 名" },
  sourceCount: { after: " 个来源" },
  discussions: { after: " 条讨论" },
};
export const TEXT_FIELDS = new Set(["title", "description", "language", "tagline", "origin", "what", "who", "highlight", "title_zh"]);

const SLOT = /\{\{(\w+)\}\}/g;

export function checkTemplate(template, fields) {
  const errors = [];
  // 先去掉 {{字段}}，再由 digits.js 去掉白名单常用词（一个、一句话、唯一……），剩下的一律不许有数字
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
  return template.replace(SLOT, (_, k) => String(fields[k]));
}

// 返回 null 表示这条必须丢掉
export function buildSpoken(template, fields) {
  if (!checkTemplate(template, fields).ok) return null;
  return renderScript(template, fields);
}
