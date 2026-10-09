// 本地跑一轮真抓取：node scripts/fetch-sources.mjs > /tmp/items.json
import { fetchAll, dedupe, interleave } from "../src/sources.js";
const r = await fetchAll();
const items = interleave(dedupe(r.items));
console.error(`抓到 ${items.length} 条`, Object.fromEntries(Object.entries(Object.groupBy(items, (x) => x.source)).map(([k, v]) => [k, v.length])), "失败：", r.errors);
console.log(JSON.stringify({ fetchedAt: r.fetchedAt, errors: r.errors, items }, null, 2));
