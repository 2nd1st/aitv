// 数字规则（唯一出处）：enrich.js 和 validate.js 都用这一份。
// 先把常用词白名单去掉，再查阿拉伯数字 / 中文数字 / 倍数词。
export const WORD_WHITELIST = ["一句话", "一个", "一款", "一种", "一下", "一起", "一些", "一直", "一样", "唯一", "统一", "万一", "十分"];
export const ARABIC = /[0-9０-９]/;
export const CN_NUM = /[零〇一二三四五六七八九十百千万亿两半倍壹贰叁肆伍陆柒捌玖拾佰仟]/;

export function stripWhitelist(text) {
  let s = String(text);
  // 长词在前（「一句话」先于「一个」），避免残留
  for (const w of [...WORD_WHITELIST].sort((a, b) => b.length - a.length)) s = s.split(w).join("");
  return s;
}

// 返回违规类型数组：[] 表示干净
export function numberViolations(text) {
  const s = stripWhitelist(text);
  const out = [];
  if (ARABIC.test(s)) out.push("arabic");
  if (CN_NUM.test(s)) out.push("chinese");
  return out;
}

export function hasNumber(text) {
  return numberViolations(text).length > 0;
}
