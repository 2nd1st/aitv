// 数字硬校验：稿子里出现源数据里没有的数字，整条丢掉。
const NUM = /\d+(?:[.,]\d+)*/g;
const norm = (s) => String(s).replace(/,/g, "");

export function numbersIn(text) {
  return (String(text).match(NUM) || []).map(norm);
}

// script 里用 {{field}} 引用源数据字段，渲染后再校验。
export function renderScript(template, fields) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in fields)) throw new Error(`未知字段 ${k}`);
    return String(fields[k]);
  });
}

export function checkNumbers(text, fields) {
  const allowed = new Set(Object.values(fields).flatMap(numbersIn));
  const bad = numbersIn(text).filter((n) => !allowed.has(n));
  return { ok: bad.length === 0, bad };
}

// 返回 null 表示这条必须丢掉
export function buildSpoken(template, fields) {
  let text;
  try { text = renderScript(template, fields); } catch { return null; }
  return checkNumbers(text, fields).ok ? text : null;
}
