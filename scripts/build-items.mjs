// 本地最小版：真抓一轮，取 N 条，生成口播句子，写到 stdout（JSON）。
import { fetchAll, dedupe, interleave } from "../src/sources.js";
import { spokenLines } from "../src/script.js";

const N = Number(process.argv[2] || 10);
const { items, errors } = await fetchAll();
const picked = [];
for (const it of interleave(dedupe(items))) {
  const lines = spokenLines(it);
  if (!lines) continue;
  picked.push({ ...it, lines });
  if (picked.length >= N) break;
}
process.stderr.write(`抓到 ${items.length} 条，取 ${picked.length} 条；失败源：${JSON.stringify(errors)}\n`);
process.stdout.write(JSON.stringify(picked, null, 1));
