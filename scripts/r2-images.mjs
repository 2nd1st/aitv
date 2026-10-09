// 构建时把条目的封面图转存到 R2（img/<key>），item.image 改成 /img/<key>；不行就 null。
// 用法（单独跑）：node scripts/r2-images.mjs items.json   —— 原地改写 items.json
// 需要 CLOUDFLARE_API_TOKEN（设置自己的 Cloudflare 凭据）。build-items.mjs 最后也会调它。
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeScreenedImage } from "../src/imagepick.js";

const BASE = process.env.AITV_BASE || "https://aitv.qiaomu.ai";
const BUCKET = process.env.AITV_BUCKET || "aitv-audio";

// box 上的 R2 适配器（跟 R2 绑定同样的 head / put 形状）：head 走线上 /img/ 的 HEAD，put 走 wrangler r2 object put
export function r2ImageStore() {
  const dir = mkdtempSync(join(tmpdir(), "aitv-img-"));
  return {
    head: async (key) => {
      try { const r = await fetch(`${BASE}/${key}`, { method: "HEAD" }); return r.status === 200 ? { key, size: Number(r.headers.get("content-length")) } : null; } catch { return null; }
    },
    put: async (key, bytes, { httpMetadata: { contentType } }) => {
      const f = join(dir, key.replace(/\//g, "_"));
      writeFileSync(f, bytes);
      execFileSync("npx", ["wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--file", f, "--content-type", contentType,
        "--cache-control", "public, max-age=31536000, immutable", "--remote"], { stdio: ["ignore", "pipe", "pipe"] });
      rmSync(f, { force: true });
    },
  };
}

// it.image 进来时是原文页上的封面图地址（og:image / twitter:image，补料时已按地址筛过），出去时是 /img/<key> 或 null。
// 下载只经 storeImage；写进桶之前按真实字节再筛一次（src/imagepick.js：尺寸、像不像纯 logo）。
// hints：{ [id]: { logoAlt } }（补料时从 og:image:alt 看出来的，toSeedItem 不带它，所以单独传）
export async function cacheItemImages(items, { store = r2ImageStore(), log = () => {}, hints = {} } = {}) {
  let ok = 0;
  for (const it of items) {
    const src = it.image;
    if (typeof src === "string" && src.startsWith("/img/")) { ok++; continue; }
    const r = src ? await storeScreenedImage(store, src, it.url, { hint: hints[it.id] || {} }) : { image: null, reason: "没有图" };
    it.image = r.image;
    if (it.image) ok++;
    log(`${it.image ? "🖼" : "·"} ${it.id} ${it.image || `(无图：${r.reason})`}`);
  }
  return ok;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  const items = JSON.parse(readFileSync(path, "utf8"));
  const n = await cacheItemImages(items, { log: (s) => console.error(s) });
  writeFileSync(path, JSON.stringify(items, null, 1));
  console.error(`配图：${n}/${items.length} 条有图`);
}
