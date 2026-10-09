// 写稿（v2）：每条三段口播——这是什么 / 跟你有什么关系 / 一句可执行的点评。
// 模型只看到 brief（what / who / highlight）+ 标题、来源、带单位的数字字段，看不到原文。
// 模型输出的是模板：数字只能以 {{字段}} 出现并带绑定单位，由 validate.js 硬校验；
// 不合格带着错误重写一次，还不合格整条丢掉。
import { checkTemplate, renderScript, UNITS } from "./validate.js";
import { parseBrief } from "./enrich.js";

export const PARTS = ["这是什么", "跟你有什么关系", "一句点评"];
export const BANNED = ["值得关注", "值得一看", "值得期待", "值得一试", "拭目以待", "不容小觑", "令人期待", "引发热议", "备受关注"];
const ACTION = /试|装|用|打开|点开|读|看看|跑|收藏|订阅|换|查|对比|动手|上手|克隆|下载|部署|接入|翻|加进|记下|别急着|先别|去/;

const has = (v) => v !== undefined && v !== null && v !== "";

// 写稿模型能看到的全部字段：brief 三项 + 标题 + 带单位的数字。原文、tagline、permalink 等一律不给。
// HN、AIHOT 的标题是整句新闻标题，插进口播很别扭：只给模型看，不许当 {{title}} 用。
export const TITLE_SLOT_SOURCES = new Set(["GitHub Trending", "Product Hunt"]);
export function scriptFields(item) {
  const f = item.fields || {};
  const out = {};
  for (const k of ["title", "what", "who", "highlight"]) if (has(f[k])) out[k] = f[k];
  if (!TITLE_SLOT_SOURCES.has(item.source)) delete out.title;
  for (const k of Object.keys(UNITS)) if (typeof f[k] === "number" && Number.isFinite(f[k])) out[k] = f[k];
  return out;
}

function unitHint(k) {
  const u = UNITS[k];
  return `${u.before || ""}{{${k}}}${u.after || ""}`;
}

export function scriptPrompt(item, feedback = "") {
  const f = scriptFields(item);
  const nums = Object.keys(f).filter((k) => UNITS[k]);
  return `你是中文 AI 资讯电视台「AI 今天」的主播，给一条热点写口播稿。听众边听边决定要不要去看原文。

来源：${item.source}
${f.title ? `标题 {{title}}：${f.title}` : `原标题（只供你理解，不能用 {{title}} 插入，要点名就用你自己的话，别带数字）：${item.fields?.title ?? ""}`}
它是什么 {{what}}：${f.what}
给谁用 {{who}}：${f.who}
亮点 {{highlight}}：${f.highlight}
${nums.length ? `可用的数字字段（只能原样照抄这个写法，包括空格和单位）：${nums.map(unitHint).join("、")}` : "这条没有可用的数字字段。"}

写三段，每段一到两句短句，口语化，像跟朋友说话，三段合起来念大约二十到四十秒（总共大约一百到一百六十个汉字）：
part1「这是什么」：一句话讲清这个产品或项目做了什么，点出它的名字。${f.title ? "可以直接用 {{title}} 点名（名字里带数字的必须用 {{title}}，不要自己打出来）。" : "原标题是整句新闻标题，不要照念；用你自己的话点出主角（名字里带数字的就说「它」「新模型」或去掉数字的叫法）。"}
part2「跟你有什么关系」：谁会用得上、为什么跟听众有关。
part3「一句点评」：必须是可执行的建议，告诉听众今天具体可以做什么，例如「如果你在做某某，今天就去试一下」「如果你还在用某某，可以拿它对比一下」。

硬性规定：
- 严禁空洞夸奖：不许出现「值得关注」「值得一看」「值得期待」「拭目以待」「不容小觑」「引发热议」这类话。
- 稿子正文里一律不许出现数字：阿拉伯数字、中文数字（一二三……十百千万两半倍）、版本号都不行，${f.title ? "产品名里带数字的就用 {{title}} 代替" : "名字里带数字的就换个说法"}。
  例外：「一个、一款、一种、一句话、一下、一起、一些、一直、一样、唯一、统一、万一、十分」这些常用词可以用；其他像「第一」「一键」「一天」「一套」「一位」「一眼」「一次」「一点」「一堆」「三维」「两者」「百度」「千万」「半导体」都不行，换个说法（「整套」「有位」「马上」「立体」「不少」）。
- 数字是可有可无的佐证，要用只能用上面列出的 {{字段}} 写法，原样照抄。不许自己编数字。
- 可以用 ${Object.keys(f).filter((k) => !UNITS[k]).map((k) => `{{${k}}}`).join(" ")} 原样插入，也可以自己换说法；不许用其他 {{字段}}。
- 只依据上面给的信息，不补充没给的事实。
- 不要念「这是什么」「一句点评」这些小标题。
${feedback ? `\n上一次写的稿子没通过检查，问题是：${feedback}\n请改掉这些问题重写。\n` : ""}
只输出 JSON，不要别的文字：{"part1":"…","part2":"…","part3":"…"}`;
}

export function checkScript(parts, fields) {
  const errors = [];
  if (!Array.isArray(parts) || parts.length !== 3 || parts.some((p) => typeof p !== "string" || !p.trim())) {
    return { ok: false, errors: ["必须是三段非空文本"] };
  }
  parts.forEach((p, i) => {
    const r = checkTemplate(p, fields);
    if (!r.ok) errors.push(`part${i + 1}：${r.errors.join("，")}`);
    for (const b of BANNED) if (p.includes(b)) errors.push(`part${i + 1} 有空话「${b}」`);
    if (/这是什么|跟你有什么关系|一句点评/.test(p)) errors.push(`part${i + 1} 念了小标题`);
  });
  if (!ACTION.test(parts[2])) errors.push("part3 不是可执行的建议（要告诉听众今天去做什么）");
  const rendered = parts.map((p) => renderScript(p, fields)).join("");
  if (rendered.length > 260) errors.push("太长了，三段合起来压到一百六十字左右");
  return { ok: errors.length === 0, errors };
}

// 返回 { parts: [模板×3], lines: [渲染后×3] } 或 { error }
export async function writeScript(item, { llm, retries = 1 } = {}) {
  if (!item.brief) return { error: "没有 brief" };
  const fields = scriptFields(item);
  let feedback = "";
  let last = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    let obj;
    try { obj = parseBrief(await llm(scriptPrompt(item, feedback))); } catch (e) { last = `模型出错：${e.message || e}`; feedback = "没有按要求输出 JSON"; continue; }
    const parts = obj ? [obj.part1, obj.part2, obj.part3].map((p) => (typeof p === "string" ? p.trim() : p)) : null;
    const chk = parts ? checkScript(parts, fields) : { ok: false, errors: ["不是 JSON"] };
    if (chk.ok) return { parts, lines: parts.map((p) => renderScript(p, fields)), attempts: attempt + 1 };
    last = chk.errors.join("；");
    feedback = last;
    if (/阿拉伯数字|中文数字/.test(last)) feedback += `。提示：${fields.title ? `名字里带数字的（比如「${fields.title}」）一律写成 {{title}}，不要自己打出来；` : "名字里带数字的就换成「它」「新模型」这类说法；"}「新一代」「第一」「一键」「一套」「一位」「两个」这类也算数字`;
  }
  return { error: `校验不过：${last}` };
}

// 进 seed / 节目单的字段白名单：原文（materialText 等）一律不带。
export const SEED_KEYS = ["id", "source", "url", "fetchedAt", "publishedAt", "template", "focus", "fields", "brief", "script", "take", "lines"];
export function toSeedItem(item) {
  const out = {};
  for (const k of SEED_KEYS) if (k in item) out[k] = item[k];
  return out;
}

// 讲解三段对应画面上的 part：what / who / take（take = 可执行的点评，画面标「AI 点评」）
export const PART_KEYS = ["what", "who", "take"];

// HN 英文标题 → 中文标题（只上屏，不念）。title_zh 是文本字段，不走禁数字规则；
// 但译文里的数字必须和原标题里的数字一模一样（不许多、不许少、不许改），否则不用。
const numTokens = (s) => (String(s).match(/\d+(?:[.,]\d+)*/g) || []).sort();
export function titleZhOk(title, zh) {
  if (typeof zh !== "string" || !zh.trim() || zh.length > 80) return false;
  if (!/[\u3400-\u9fff]/.test(zh)) return false;
  return JSON.stringify(numTokens(title)) === JSON.stringify(numTokens(zh));
}
export function needsTitleZh(item) {
  const t = item.fields?.title || "";
  return item.source === "Hacker News" && !/[\u3400-\u9fff]/.test(t);
}
export async function translateTitle(item, { llm }) {
  const title = item.fields.title;
  const prompt = `把这条 Hacker News 标题翻成简洁自然的中文标题（不超过三十个字），产品名、人名、专有名词保留英文；原标题里的数字原样保留，不许增删或改写数字。
原标题：${title}
${item.brief?.what ? `参考（它讲的是什么）：${item.brief.what}` : ""}
只输出 JSON：{"title_zh":"…"}`;
  try {
    const obj = parseBrief(await llm(prompt));
    const zh = obj?.title_zh?.trim();
    return titleZhOk(title, zh) ? zh : null;
  } catch { return null; }
}
