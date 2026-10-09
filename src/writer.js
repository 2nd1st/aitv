// 写稿（v3）：每条三段口播——这是什么 / 跟你有什么关系 / AI 点评。
// 模型只看到 brief（kind / name / what / who / highlight）+ 标题、来源、带单位的数字字段，看不到原文。
// kind 由补料那一步定（product / project / commentary / news），写稿只读不改：
//   product / project：点评可以是「今天就可以试」这类可执行建议；
//   commentary / news：讲清文章主张或报道内容和立场，点评是判断或接下来该看什么，不许推荐去用被评论的东西。
// 模型输出的是模板：数字只能以 {{字段}} 出现并带绑定单位，由 validate.js 硬校验；
// 带数字的名字（Sonnet 5.5）只能经 {{name}} / {{title}} 进来，name 已核实是标题里原样的一段。
// 不合格带着错误重写一次，还不合格整条丢掉。
import { checkTemplate, renderScript, UNITS } from "./validate.js";
import { parseBrief, KINDS } from "./enrich.js";
import { toneViolations, overclaimViolations } from "./tone.js";

export const PARTS = ["这是什么", "跟你有什么关系", "AI 点评"];
export const BANNED = ["值得关注", "值得一看", "值得期待", "值得一试", "拭目以待", "不容小觑", "令人期待", "引发热议", "备受关注"];
const ACTION = /试|装|用|打开|点开|读|看看|跑|收藏|订阅|换|查|对比|动手|上手|克隆|下载|部署|接入|翻|加进|记下|别急着|先别|去/;
// commentary / news 的点评里不许出现「去用它」这类推荐
export const TRY_IT = /试一下|试试|试用|去试|装上|安装|下载|上手|用起来|用上|接入|部署|跑起来|跑一下|换成|换上|订阅|注册|申请/;
export const MIN_CHARS = 130, MAX_CHARS = 250; // 约 7 字/秒：二十到三十五秒
export const OPENING_CHARS = 3; // 相邻两条点评，开头这么多字不能一样

const has = (v) => v !== undefined && v !== null && v !== "";

// 写稿模型能看到的全部字段：brief + 标题 + 带单位的数字。原文、tagline、permalink 等一律不给。
// HN、AIHOT 的标题是整句新闻标题，插进口播很别扭：只给模型看，不许当 {{title}} 用（点名用 {{name}}）。
export const TITLE_SLOT_SOURCES = new Set(["GitHub Trending", "Product Hunt"]);
export function scriptFields(item) {
  const f = item.fields || {};
  const out = {};
  for (const k of ["title", "name", "what", "who", "highlight", "limit"]) if (has(f[k])) out[k] = f[k];
  if (!TITLE_SLOT_SOURCES.has(item.source)) delete out.title;
  for (const k of Object.keys(UNITS)) if (typeof f[k] === "number" && Number.isFinite(f[k])) out[k] = f[k];
  return out;
}

function unitHint(k) {
  const u = UNITS[k];
  return `${u.before || ""}{{${k}}}${u.after || ""}`;
}

// HN 拉的是 Algolia front_page 标签：确实在首页上，但返回顺序不是名次，所以只说「首页热帖」，不说第几名
const SOURCE_LABEL = { "Hacker News": "Hacker News 首页热帖（不要说第几名）",
  "Product Hunt": "Product Hunt 昨天（太平洋时间）的日榜（这是昨天的榜，全文不许说「今天」；要说名次只能用给出的 {{phDailyRank}} 写法，没给就不说第几名；{{phScore}} 是 PH 的综合分，不是票数）" };
// Product Hunt 用的是昨天已经结束的日榜：整条稿子都不许出现「今天」
const isYesterdayPH = (source, fields) => source === "Product Hunt" || "phDailyRank" in (fields || {}) || "phScore" in (fields || {});
const KIND_LABEL = { product: "产品", project: "开源项目", commentary: "评论 / 观点文章", news: "新闻报道" };
export const opening = (s) => String(s || "").replace(/^[\s，。、“”「」]+/, "").slice(0, OPENING_CHARS);

function kindRules(kind, f) {
  const nameHint = f.name ? "{{name}}" : f.title ? "{{title}}" : "它的名字";
  if (kind === "commentary") return `part1「这是什么」：两句。先点明这是篇评论 / 观点文章（不要说「一篇」），再讲清它在主张什么；明确说出它讨论的对象（用 ${nameHint}）。
part2「跟你有什么关系」：两句。作者的立场和核心理由是什么，谁会在意这个讨论、为什么。
part3「AI 点评」：一句判断，或者接下来该看什么（比如「接下来要看……」「这个判断站不站得住，关键在……」）。
  严禁推荐听众去试用、下载、接入、换成文章讨论的那个东西——这是一篇评论，不是产品推荐。`;
  if (kind === "news") return `part1「这是什么」：两句。讲清报道了什么事，谁做了什么，明确点出主角和具体对象（用 ${nameHint}）。
part2「跟你有什么关系」：两句。影响到谁、意味着什么；如果是发布或调整，说清具体变了什么。
part3「AI 点评」：一句判断，或者接下来该看什么（比如「接下来要看……」「真正的考验是……」）。
  不要写「今天就去试」「去下载」这类推荐。`;
  return `part1「这是什么」：两句。第一句必须明确说出${kind === "project" ? "项目" : "产品"}名字（用 ${nameHint}），讲清它做了什么；第二句补一个具体的做法或特点。
part2「跟你有什么关系」：两句。谁会用得上、在什么场景下省事或解决什么问题。
part3「AI 点评」：可执行的建议，告诉听众具体可以做什么（试一下、拿它对比、先看某个功能、先确认某个限制），但要具体到场景。`;
}

export function scriptPrompt(item, feedback = "", { prevTake = "" } = {}) {
  const f = scriptFields(item);
  const kind = item.brief?.kind;
  const nums = Object.keys(f).filter((k) => UNITS[k]);
  const textSlots = Object.keys(f).filter((k) => !UNITS[k]).map((k) => `{{${k}}}`).join(" ");
  return `你是中文 AI 资讯电视台「AI 今天」的主播，给一条热点写口播稿。听众边听边决定要不要去看原文。

这条的类型（补料时已定，不能改）：${kind}（${KIND_LABEL[kind] || kind}）
来源：${SOURCE_LABEL[item.source] || item.source}
${f.title ? `标题 {{title}}：${f.title}` : `原标题（只供你理解，不能用 {{title}} 插入）：${item.fields?.title ?? ""}`}
${f.name ? `名字 {{name}}：${f.name}（从标题里原样摘出，已核实）` : "这条没有单独的名字字段。"}
它是什么 {{what}}：${f.what}
跟谁有关 {{who}}：${f.who}
亮点 {{highlight}}：${f.highlight}
${f.limit ? `限制 {{limit}}：${f.limit}（part2 或 part3 必须交代这条限制，可以换说法）` : "素材里没写明限制：不要替它下「没有限制」「都能用」这类结论。"}
${nums.length ? `可用的数字字段（只能原样照抄这个写法，包括空格和单位）：${nums.map(unitHint).join("、")}` : "这条没有可用的数字字段。"}

写三段，口语化，像在跟懂行的朋友说话，三段合起来一百五十到二百一十个字（念出来二十到三十五秒；算上插入的名字，超过二百五十字会被退回）。part1、part2 要写得充实具体，但不要注水、不要重复：
${kindRules(kind, f)}

硬性规定：
- 具体：part1 必须明确说出产品 / 模型 / 项目 / 主角的名字，不许只说「一款新模型」「一个工具」。${f.name ? "名字用 {{name}} 插入（带数字的名字只能这样写）。" : ""}
- 语气：中性、专业。不许鼓励或美化抄袭、照搬别人的功能、盗版、破解、绕过限制，不用「抄」「没源码」「白嫖」「绕过」这类说法。
- 不夸大：只说上面给的信息里有依据的事，程度、范围、确定性都不能往上加。实验性 / 早期项目别说成能替代成熟产品；作者或公司的说法要说成「据作者说」「官方称」；检测 / 识别类工具要说明没检出不代表没有。不用「偷偷」「悄悄」「颠覆」「碾压」「完美」「最强」「史上」「神器」「天花板」这类词。
- 不说先后 / 独家：不写「第一次」「首次」「首个」「率先」「最早」「唯一一家」这类谁先做到的说法，除非上面给的信息里明确写了；否则换成不带先后的说法。
- 别套句式：点评里不要用「今天」；点评不要以「如果你」开头。
- 严禁空洞夸奖：不许出现「值得关注」「值得一看」「值得期待」「拭目以待」「不容小觑」「引发热议」这类话。
- 稿子正文里一律不许出现数字：阿拉伯数字、中文数字（一二三……十百千万两半倍）、版本号都不行；带数字的名字只能用 {{name}}${f.title ? " 或 {{title}}" : ""} 插入。
  例外：「一个、一款、一种、一句话、一下、一起、一些、一直、一样、统一、万一、十分、同一、一致」这些常用词可以用；其他像「第一」「一键」「一天」「一篇」「一张」「一条」「一套」「一位」「一眼」「一次」「一点」「一堆」「三维」「两者」「百度」「千万」「半导体」都不行，换个说法（「整套」「有位」「马上」「立体」「不少」）。
- 数字是可有可无的佐证：整条最多引用一个数字字段，而且只能放在 part2 或 part3（先讲清是什么、跟谁有关，再拿数字佐证），part1 绝不能出现数字字段，更不能拿数字开场。要用只能用上面列出的 {{字段}} 写法，原样照抄。不许自己编数字。
- 可以用 ${textSlots} 原样插入，也可以自己换说法；不许用其他 {{字段}}。
- 只依据上面给的信息，不补充没给的事实。
- 不要念「这是什么」「AI 点评」这些小标题。
${prevTake ? `- 上一条的点评是：「${prevTake}」。这条点评换个开头和句式，开头前三个字不能跟它一样，也不要再用「如果你……今天就……」这个套路。\n` : ""}${feedback ? `\n上一次写的稿子没通过检查，问题是：${feedback}\n请改掉这些问题重写。\n` : ""}
只输出 JSON，不要别的文字：{"part1":"…","part2":"…","part3":"…"}`;
}

export function checkScript(parts, fields, { kind = "product", prevTake = "", source = "" } = {}) {
  const errors = [];
  if (!Array.isArray(parts) || parts.length !== 3 || parts.some((p) => typeof p !== "string" || !p.trim())) {
    return { ok: false, errors: ["必须是三段非空文本"] };
  }
  parts.forEach((p, i) => {
    const r = checkTemplate(p, fields);
    if (!r.ok) errors.push(`part${i + 1}：${r.errors.join("，")}`);
    for (const b of BANNED) if (p.includes(b)) errors.push(`part${i + 1} 有空话「${b}」`);
    const tone = toneViolations(p);
    if (tone.length) errors.push(`part${i + 1} 语气不合适（${tone.join("、")}），要中性专业`);
    if (/这是什么|跟你有什么关系|AI 点评|一句点评/.test(p)) errors.push(`part${i + 1} 念了小标题`);
    const over = overclaimViolations(p);
    if (over.length) errors.push(`part${i + 1} 说过头了（${over.join("、")}），照给的信息的程度说`);
  });
  // 句式别套（验收：二十条点评十九条带「今天」、十六条以「如果你」开头）
  if (isYesterdayPH(source, fields)) { if (parts.some((p) => p.includes("今天"))) errors.push("这是 Product Hunt 昨天的日榜，全文不许说「今天」"); }
  else if (parts[2].includes("今天")) errors.push("点评里不要用「今天」，换个说法");
  // PH 的 phScore 是综合分不是票数：PH 稿子里一个「票」字都不许有
  if (isYesterdayPH(source, fields) && parts.some((p) => p.includes("票"))) errors.push("Product Hunt 的分数是综合分，不是票数，全文不许出现「票」");
  if (/^[\s，。「“]*如果你/.test(parts[2])) errors.push("点评不要以「如果你」开头，换个句式");
  // 数字只是佐证：整条最多一个数字字段，且不能出现在 part1（不拿数字开场）
  const numSlots = parts.map((p) => (p.match(/\{\{(\w+)\}\}/g) || []).filter((m) => UNITS[m.slice(2, -2)]).length);
  if (numSlots[0] > 0) errors.push("part1 不许出现数字字段，先讲清是什么；数字只能放在 part2 或 part3");
  if (numSlots.reduce((a, b) => a + b, 0) > 1) errors.push("整条最多引用一个数字字段，删掉多余的");
  // 具体：part1 必须点名
  if (fields.name) {
    const named = parts[0].includes("{{name}}") || parts[0].includes(fields.name) || (fields.title && parts[0].includes("{{title}}"));
    if (!named) errors.push(`part1 没有点名，要用 {{name}} 明确说出「${fields.name}」`);
  }
  if (kind === "product" || kind === "project") {
    if (!ACTION.test(parts[2])) errors.push("part3 不是可执行的建议（要告诉听众今天具体去做什么）");
  } else if (TRY_IT.test(parts[2])) {
    errors.push(`这是 ${kind}，part3 不许推荐去试用 / 下载 / 接入，要写判断或接下来该看什么`);
  }
  const rendered = parts.map((p) => renderScript(p, fields));
  const len = rendered.join("").length;
  if (len > MAX_CHARS) errors.push(`太长了（${len} 字，上限 ${MAX_CHARS}），三段合起来压到二百字左右，删掉重复和次要的话`);
  if (len < MIN_CHARS) errors.push(`太短了（${len} 字），part1、part2 各写两句，合起来一百五十字以上`);
  if (prevTake && opening(rendered[2]) === opening(prevTake)) errors.push(`点评开头「${opening(rendered[2])}」跟上一条一样，换个开头和句式`);
  return { ok: errors.length === 0, errors };
}

// 返回 { kind, parts: [模板×3], lines: [渲染后×3] } 或 { error }。kind 原样取自 brief，模型改不了。
export async function writeScript(item, { llm, retries = 1, prevTake = "" } = {}) {
  if (!item.brief) return { error: "没有 brief" };
  const kind = item.brief.kind;
  if (!KINDS.includes(kind)) return { error: `brief.kind 不合法：${kind}` };
  const fields = scriptFields(item);
  let feedback = "";
  let last = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    let obj;
    try { obj = parseBrief(await llm(scriptPrompt(item, feedback, { prevTake }))); } catch (e) { last = `模型出错：${e.message || e}`; feedback = "没有按要求输出 JSON"; continue; }
    const parts = obj ? [obj.part1, obj.part2, obj.part3].map((p) => (typeof p === "string" ? p.trim() : p)) : null;
    const chk = parts ? checkScript(parts, fields, { kind, prevTake, source: item.source }) : { ok: false, errors: ["不是 JSON"] };
    if (chk.ok) return { kind, parts, lines: parts.map((p) => renderScript(p, fields)), attempts: attempt + 1 };
    last = chk.errors.join("；");
    feedback = last;
    if (/阿拉伯数字|中文数字/.test(last)) feedback += `。提示：名字里带数字的一律写成 ${fields.name ? "{{name}}" : fields.title ? "{{title}}" : "「它」"}，不要自己打出来；「新一代」「第一」「一键」「一套」「一位」「两个」这类也算数字`;
  }
  return { error: `校验不过：${last}` };
}

// 进 seed / 节目单的字段白名单：原文（materialText 等）一律不带。
// dateUnknown：AIHOT 原文读不出发布时间（publishedAt 为 null）时为 true
export const SEED_KEYS = ["id", "source", "url", "fetchedAt", "publishedAt", "dateUnknown", "pubDateSource", "rankedAt", "template", "focus", "kind", "image", "fields", "brief", "script", "take", "lines"];
export function toSeedItem(item) {
  const out = {};
  for (const k of SEED_KEYS) if (k in item) out[k] = item[k];
  return out;
}

// 讲解三段对应画面上的 part：what / who / take（take = 点评，画面标「AI 点评」）
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
