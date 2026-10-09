// 发布 / 回滚节目单版本（详见 README「发布与回滚」）。
//   node scripts/release.mjs list              列出版本，标出线上和上一版
//   node scripts/release.mjs check <version>   只校验，不切换
//   node scripts/release.mjs use <version>     校验通过（可播 >= 15 条）才把线上指针切过去，原线上版本记为 previous
//   node scripts/release.mjs rollback          指针切回 previous（previous 和当前对调）
//   node scripts/release.mjs prune             删掉线上和上一版以外的旧版本目录
// 切换 / 回滚之后要部署才生效：npm run build && npx wrangler deploy
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, rmSync } from "node:fs";
import { checkSeed } from "../src/release.js";

const PUB = new URL("../public/", import.meta.url);
const ptrPath = new URL("current.json", PUB);
const readPtr = () => (existsSync(ptrPath) ? JSON.parse(readFileSync(ptrPath, "utf8")) : { version: null, previous: null });
const versions = () => (existsSync(new URL("seeds/", PUB)) ? readdirSync(new URL("seeds/", PUB)).filter((d) => existsSync(new URL(`seeds/${d}/seed.json`, PUB))).sort() : []);
const audioBytes = (p) => { const f = new URL("." + p, PUB); return existsSync(f) ? statSync(f).size : 0; };
function check(v) {
  const f = new URL(`seeds/${v}/seed.json`, PUB);
  if (!existsSync(f)) return { ok: false, playable: 0, errors: [`没有 seeds/${v}/seed.json`] };
  return checkSeed(JSON.parse(readFileSync(f, "utf8")), v, { audioBytes });
}
function report(v, r) {
  console.log(`${v}：${r.ok ? "✓ 通过" : "✗ 不通过"}，内容合格可播 ${r.playable} 条（音频齐全 ${r.audioOk} 条）`);
  for (const e of r.errors) console.log("  - " + e);
}
const [cmd, arg] = process.argv.slice(2);
const ptr = readPtr();
if (cmd === "list") {
  for (const v of versions()) console.log(`${v}${v === ptr.version ? "  ← 线上" : v === ptr.previous ? "  ← 上一版（可回滚）" : ""}`);
} else if (cmd === "check") {
  const r = check(arg); report(arg, r); process.exit(r.ok ? 0 : 1);
} else if (cmd === "use") {
  const r = check(arg); report(arg, r);
  if (!r.ok) { console.log(`不切换，线上保持 ${ptr.version}`); process.exit(1); }
  if (arg === ptr.version) { console.log("已经是线上版本"); process.exit(0); }
  writeFileSync(ptrPath, JSON.stringify({ version: arg, previous: ptr.version }, null, 1) + "\n");
  console.log(`线上指针：${ptr.version} → ${arg}（上一版 ${ptr.version} 保留，可回滚）。部署后生效。`);
} else if (cmd === "rollback") {
  if (!ptr.previous) { console.log("没有上一版可回滚"); process.exit(1); }
  const r = check(ptr.previous); report(ptr.previous, r);
  // 回滚是应急：旧版本按当时的规则生成，只要求音频齐全能播
  if (r.audioOk < 1) { console.log("上一版没有能播的条目，不回滚"); process.exit(1); }
  writeFileSync(ptrPath, JSON.stringify({ version: ptr.previous, previous: ptr.version }, null, 1) + "\n");
  console.log(`已回滚指针：${ptr.version} → ${ptr.previous}。部署后生效。`);
} else if (cmd === "prune") {
  for (const v of versions()) if (v !== ptr.version && v !== ptr.previous) { rmSync(new URL(`seeds/${v}/`, PUB), { recursive: true }); console.log("删掉旧版本", v); }
} else {
  console.log("用法：node scripts/release.mjs list | check <v> | use <v> | rollback | prune"); process.exit(2);
}
