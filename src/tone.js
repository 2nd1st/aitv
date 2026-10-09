// 语气规则（这是乔木频道上播的内容）：中性、专业；不鼓励抄袭、盗版、破解、绕过限制，
// 不用「抄别人功能」这类说法。brief 三项和口播稿都过这一关。
export const TONE_BANNED = [
  "抄", "照搬", "山寨", "盗版", "破解", "白嫖", "薅羊毛", "绕过", "绕开限制", "翻墙", "偷师", "偷学", "扒别人", "扒下来",
  "搬运", "拿不到源码", "没源码", "钻空子", "擦边", "灰色",
];
export function toneViolations(text) {
  const s = String(text);
  return TONE_BANNED.filter((w) => s.includes(w));
}

// 不夸大（验收 #5 咖啡机「偷偷跑流量」、#2/#17/#18 夸大、#20 SynthID 漏限制）：
// 这些词几乎总是在替素材加戏，brief 和口播稿里都不许出现。
export const OVERCLAIM_BANNED = [
  "偷偷", "悄悄", "颠覆", "秒杀", "碾压", "吊打", "完美", "革命性", "革命般", "史上", "最强", "遥遥领先", "无敌", "神器",
  "炸裂", "封神", "王炸", "杀手级", "天花板", "彻底解决", "彻底改变", "完全取代", "完全替代", "取代所有", "零成本", "一劳永逸",
  "百分百", "绝对安全", "永远不会",
];
export function overclaimViolations(text) {
  const s = String(text);
  return OVERCLAIM_BANNED.filter((w) => s.includes(w));
}
