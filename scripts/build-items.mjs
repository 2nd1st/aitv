// v2：真抓一轮 → 读原文提炼 brief → DeepSeek 写三段稿（模板 + 校验，不过重写一次）→ stdout（JSON）。
// 用法：node scripts/build-items.mjs 20 > /tmp/items.json   （需要 DEEPSEEK_API_KEY）
// 统计（每源条数、丢弃原因）写到 stderr 和 /tmp/aitv-build-stats.json。
import { writeFileSync } from "node:fs";
import { fetchAll, dedupe, interleave } from "../src/sources.js";
import { enrich } from "../src/enrich.js";
import { writeScript, toSeedItem, needsTitleZh, translateTitle } from "../src/writer.js";
import { makeDeepSeek } from "../src/llm.js";

const N = Number(process.argv[2] || 20);
const apiKey = process.env.DEEPSEEK_API_KEY;
const briefLLM = makeDeepSeek({ apiKey, model: process.env.AITV_BRIEF_MODEL || "deepseek-chat" });
const scriptLLM = makeDeepSeek({ apiKey, model: process.env.AITV_SCRIPT_MODEL || "deepseek-v4-pro" });

const { items, errors } = await fetchAll();
const cands = interleave(dedupe(items));
const sources = [...new Set(cands.map((x) => x.source))];
const quota = Math.ceil(N / Math.max(1, sources.length));
const log = (s) => process.stderr.write(s + "\n");
log(`抓到 ${items.length} 条，候选 ${cands.length}，源 ${sources.join(" / ")}，每源上限 ${quota}；失败源：${JSON.stringify(errors)}`);

const picked = [], dropped = [];
// 每个源一条队列；挑「已选 + 在跑」最少、还没满额的源取下一条，某源丢一条会自动从同源补
const queues = {};
for (const c of cands) (queues[c.source] ||= []).push(c);
const busy = {}, done = {};
const load = (s) => (busy[s] || 0) + (done[s] || 0);
function next() {
  const ok = sources.filter((s) => queues[s]?.length && load(s) < quota).sort((a, b) => load(a) - load(b));
  if (!ok.length) return null;
  return queues[ok[0]].shift();
}
const inflight = () => Object.values(busy).reduce((a, b) => a + b, 0);
async function worker() {
  for (;;) {
    if (picked.length >= N) return;
    const it = picked.length + inflight() < N ? next() : null;
    if (!it) {
      if (inflight() === 0) return;          // 没东西可取，也没有在跑的了
      await new Promise((r) => setTimeout(r, 300)); // 等在跑的结果：失败了要补位
      continue;
    }
    busy[it.source] = (busy[it.source] || 0) + 1;
    try {
      const e = await enrich(it, { llm: (p) => briefLLM(p, { temperature: 0.3 }), retries: 1 });
      if (!e.brief) { dropped.push({ id: it.id, source: it.source, title: it.fields.title, stage: "brief", why: e.briefError }); log(`✗ brief  [${it.source}] ${it.fields.title.slice(0, 40)} — ${e.briefError}`); continue; }
      const s = await writeScript(e, { llm: scriptLLM });
      if (s.error) { dropped.push({ id: it.id, source: it.source, title: it.fields.title, stage: "script", why: s.error }); log(`✗ script [${it.source}] ${it.fields.title.slice(0, 40)} — ${s.error}`); continue; }
      const fields = { ...e.fields };
      if (needsTitleZh(e)) { const zh = await translateTitle(e, { llm: (p) => briefLLM(p, { temperature: 0.2 }) }); if (zh) fields.title_zh = zh; }
      // 三段：what / who / take，take 单独放 item.take 给画面（标「AI 点评」）
      picked.push(toSeedItem({ ...e, fields, take: s.lines[2], script: s.parts.map((tpl, i) => ({ part: ["what", "who", "take"][i], tpl, text: s.lines[i] })), lines: s.lines }));
      done[it.source] = (done[it.source] || 0) + 1;
      log(`✓ [${it.source}] ${it.fields.title.slice(0, 40)}（第 ${s.attempts} 次通过）`);
    } finally { busy[it.source]--; }
  }
}
await Promise.all(Array.from({ length: 5 }, worker));

// 按源轮流排
const by = {};
for (const p of picked) (by[p.source] ||= []).push(p);
const out = [];
for (let r = 0; out.length < picked.length; r++) for (const s of sources) if (by[s]?.[r]) out.push(by[s][r]);

const perSource = {};
for (const p of out) perSource[p.source] = (perSource[p.source] || 0) + 1;
const stats = { picked: out.length, perSource, dropped, sourceErrors: errors };
writeFileSync("/tmp/aitv-build-stats.json", JSON.stringify(stats, null, 1));
log(`取 ${out.length} 条 ${JSON.stringify(perSource)}；丢 ${dropped.length} 条`);
process.stdout.write(JSON.stringify(out, null, 1));
