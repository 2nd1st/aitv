// 数字规则（唯一出处）：enrich.js 和 validate.js 都用这一份。
// 先把常用词白名单去掉，再查阿拉伯数字 / 中文数字 / 倍数词。
// 白名单收词标准（架构师定）：一个词只有在它里面的数字既不表示数量、也不表示名次或先后（谁第一个做到）时才能加进来。
//   「一致」「同一」「统一」「一样」里的「一」不是在数东西，可以；「第一次」「第一」「首个」在宣称先后 / 名次，不行——
//   这类说法要么源头原话写明并经核实，要么换个说法（见 enrich / writer 的提示词）。
export const WORD_WHITELIST = ["一句话", "一个", "一款", "一种", "一下", "一起", "一些", "一直", "一样", "唯一", "统一", "万一", "十分", "同一", "一致"];
export const ARABIC = /[0-9０-９]/;
// 大写数字（壹贰叁肆伍陆柒捌玖拾佰仟）不查：口播稿里不会用，「陆续」「大陆」反而老被误伤。
export const CN_NUM = /[零〇一二三四五六七八九十百千万亿两半倍]/;

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
