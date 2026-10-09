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
