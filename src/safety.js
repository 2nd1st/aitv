// 内容安全（补料这一步就拦，不进写稿）：主要用途是下面这些的条目整条丢掉——
//   盗版；在原平台以外运行主机 / 游戏的可执行文件或 ROM；绕过 DRM / 反作弊 / 付费墙；破解；克隆别人的产品。
// 两道关：模型在 brief 里给 safety 标记（"ok" | "unsafe"），再加关键词兜底（模型漏判也拦得住）。
// 兜底只看标题、源站自带的简介（GitHub description / PH tagline）和 brief 文本，不看原文正文（正文里顺带提一句不算主要用途）。
export const SAFETY_CATEGORIES = ["piracy", "console-executables", "drm-bypass", "cracking", "cloning"];

const CONSOLE = /\b(?:PS[1-5]|PSP|PS ?Vita|PlayStation|Xbox|Nintendo|Switch|3DS|NDS|Wii ?U?|Game ?Boy|GBA|Dreamcast|Sega)\b|主机游戏|游戏主机/i;
const RUN_ELSEWHERE = /\b(?:port(?:ing|s|ed)?|executables?|ELF|eboot|recompil\w*|emulat\w*|ROMs?|decrypt\w*|dump\w*)\b|移植|可执行|模拟器|模拟运行|反编译|重编译|解密/i;

// 单独出现就足以说明「主要用途」的说法
const PATTERNS = [
  ["piracy", /\bpira(?:cy|ted|te)\b|\bwarez\b|\btorrent(?:s|ing)? (?:movies|games|films|software)\b|盗版|免费看付费|资源破解/i],
  ["console-executables", /\bROMs?\b(?!\s*(?:chip|memory))|\bROM ?hack|\bhomebrew\b|\bjailbreak\w*|越狱|\b(?:game|console) ?ROMs?\b|游戏镜像|镜像下载/i],
  ["drm-bypass", /\b(?:DRM|anti-?cheat|paywalls?|license check|licen[cs]e verification)\b[^.。]{0,40}\b(?:bypass\w*|remov\w*|strip\w*|disabl\w*|circumvent\w*|defeat\w*|evad\w*)|\b(?:bypass\w*|remov\w*|strip\w*|disabl\w*|circumvent\w*|defeat\w*|evad\w*)\b[^.。]{0,40}\b(?:DRM|anti-?cheat|paywalls?|license check)\b|(?:绕过|去除|移除|破除|规避|关闭)[^。，]{0,12}(?:DRM|版权保护|反作弊|付费墙|订阅墙|授权校验|许可校验)|(?:DRM|反作弊|付费墙)[^。，]{0,8}(?:绕过|去除|移除|破除|规避)/i],
  ["cracking", /\bcrack(?:ed|ing|s)?\b(?!\s*(?:down|open))|\bkeygen\b|\bserial key generator\b|\bactivat\w* (?:windows|office) (?:for )?free\b|破解|注册机|激活工具|免费激活/i],
  ["cloning", /\b(?:clone|copycat|knock-?off|replica)\b[^.。]{0,30}\b(?:of|for)\b|一比一复刻|照搬|仿冒|山寨|克隆(?:别人|他人|某|一个|了)?(?:的)?(?:产品|应用|App|网站|界面)/i],
];

export function safetyText(item, brief = {}) {
  const f = item?.fields || {};
  return [f.title, f.description, f.tagline, brief.name, brief.what, brief.who, brief.highlight].filter((x) => typeof x === "string").join("\n");
}

// 关键词兜底：返回命中的类别（空数组 = 没命中）
export function safetyKeywordHits(text) {
  const s = String(text || "");
  const hits = PATTERNS.filter(([, re]) => re.test(s)).map(([k]) => k);
  if (CONSOLE.test(s) && RUN_ELSEWHERE.test(s) && !hits.includes("console-executables")) hits.push("console-executables");
  return hits;
}

// 综合判定：{ ok, reasons }
export function checkSafety(item, brief = {}) {
  const reasons = [];
  if (brief && brief.safety !== undefined && brief.safety !== "ok") reasons.push(`模型标记 unsafe${brief.safetyReason ? `：${brief.safetyReason}` : ""}`);
  const hits = safetyKeywordHits(safetyText(item, brief));
  if (hits.length) reasons.push(`关键词：${hits.join("/")}`);
  return { ok: reasons.length === 0, reasons };
}
