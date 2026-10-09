// 本地看补料命中率：node scripts/try-enrich.mjs 12
import { fetchAll, dedupe, interleave } from "../src/sources.js";
import { fetchMaterial } from "../src/enrich.js";
const N = Number(process.argv[2] || 12);
const items = interleave(dedupe((await fetchAll()).items)).slice(0, N);
let ok = 0;
for (const it of items) {
  const m = await fetchMaterial(it);
  if (m) ok++;
  console.log(`${m ? "✓" : "✗"} [${it.source}] ${it.fields.title.slice(0, 50)}  ${m ? `${m.text.length} 字 ← ${m.url}` : ""}`);
}
console.log(`原文读到 ${ok}/${items.length}`);
