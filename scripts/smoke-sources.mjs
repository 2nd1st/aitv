// 冒烟（真网络，不进测试）：抓 PH 昨天日榜 + AIHOT 前几条，读原文，打印名次 / 分数 / 发布时间 / 配图要不要。
// 配图用内存假桶（不碰 R2）：node scripts/smoke-sources.mjs [AIHOT 条数=5] [PH 读原文条数=5]
import { fetchAll, phLeaderboardUrl, parsePHLeaderboard } from "../src/sources.js";
import { fetchMaterial } from "../src/enrich.js";
import { storeScreenedImage } from "../src/imagepick.js";

const NA = Number(process.argv[2] || 5), NP = Number(process.argv[3] || 5);
const now = Date.now();
const mem = { objs: new Map(), head: async (k) => (mem.objs.has(k) ? { key: k } : null), put: async (k, v) => { mem.objs.set(k, v); } };
const iso = (t) => (t == null ? "null" : new Date(t + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 16) + " (UTC+8)");

const UA = "Mozilla/5.0 (aitv.qiaomu.ai; +https://aitv.qiaomu.ai)";
const lbUrl = phLeaderboardUrl(now);
const html = await (await fetch(lbUrl, { headers: { "user-agent": UA } })).text();
const ph = parsePHLeaderboard(html, now);
console.log(`== Product Hunt ${lbUrl}\n   合理性检查：${ph.check.ok ? "通过" : "不通过 → " + ph.check.errors.join("；")}（${ph.check.day}）`);
const { items: aihotAll, errors } = await fetchAll({ now, only: ["aihot"] });
if (Object.keys(errors).length) console.log("AIHOT 出错：", errors);

async function show(it) {
  const m = await fetchMaterial(it, { now });
  const merged = { ...it, ...(m?.patch || {}) };
  let img = { image: null, reason: m ? m.imageReject : "原文读不到" };
  if (m?.image) img = await storeScreenedImage(mem, m.image, merged.url, { hint: m.imageHint || {} });
  const f = it.fields;
  console.log(`- ${f.title}`);
  if (it.source === "Product Hunt") console.log(`   phDailyRank=${f.phDailyRank ?? "—"}  phScore=${f.phScore ?? "—"}  comments=${f.comments ?? "—"}`);
  else console.log(`   AIHOT rank=${f.rank}  latestAt=${iso(it.aihotLatestAt)}`);
  console.log(`   url=${merged.url}${merged.staleOriginal ? `  （旧链接 ${merged.staleOriginal}，原文日期 ${iso(merged.staleOriginalPublishedAt)}，已退回 links.aihot）` : ""}`);
  console.log(`   publishedAt=${iso(merged.publishedAt)}${merged.dateUnknown ? "  dateUnknown" : ""}${m?.dateSource ? `  ← ${m.dateSource}` : ""}`);
  console.log(`   image: ${img.image ? `收 ${img.image}（${m.image.slice(0, 90)}${img.reason ? "，" + img.reason : ""}）` : `不要：${img.reason}${m?.image ? `（${m.image.slice(0, 90)}）` : ""}`}`);
}
for (const it of ph.slice(0, 10)) {
  if (ph.indexOf(it) < NP) await show(it);
  else console.log(`- ${it.fields.title}  phDailyRank=${it.fields.phDailyRank ?? "—"} phScore=${it.fields.phScore ?? "—"} comments=${it.fields.comments ?? "—"}`);
}
console.log(`\n== AIHOT（前 ${NA} 条）`);
for (const it of aihotAll.slice(0, NA)) await show(it);
console.log(`\n内存假桶里存了 ${mem.objs.size} 张图`);
