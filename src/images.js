// 配图：不在节目单里放第三方图片地址。构建时把原文的封面图下载下来、核对格式和大小，
// 存进 R2（和音频同一个桶，key 前缀 img/），节目单里只放自家地址 /img/<key>。
// Worker 的 /img/* 只认白名单扩展名，Content-Type 由我们按扩展名定（不信源站），从不出 SVG，带 nosniff。
export const IMG_TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const KEY_RE = /^([0-9a-f]{16})\.(jpg|png|webp)$/;

// 按文件头判断真实格式（不看扩展名、不看源站的 Content-Type）
export function sniffImage(bytes) {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "png";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

export async function sha16(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// 构建时 / Worker 里都能用：下载 → 只要 https → ≤ 2MB → 按文件头认 jpg/png/webp（从不收 SVG）
// → 存到 img/<sha256(pageUrl) 前 16 位>.<ext>（已存在就跳过）→ 返回 "/img/<16 位>.<ext>"。任何一步不行返回 null，从不抛错。
// store 是 R2 桶的样子：head(key) → 对象或 null；put(key, bytes, { httpMetadata: { contentType } })。
// Worker 里传 env.AUDIO；box 上构建时传 scripts/r2-images.mjs 的 wrangler 适配器。
export async function storeImage(store, imageUrl, pageUrl, { fetch = globalThis.fetch, timeoutMs = 15000 } = {}) {
  try {
    if (!store || !imageUrl || !pageUrl) return null;
    const u = new URL(imageUrl, pageUrl);
    if (u.protocol !== "https:") return null;
    const res = await fetch(u.href, {
      headers: { "user-agent": "Mozilla/5.0 (aitv.qiaomu.ai; +https://aitv.qiaomu.ai)", accept: "image/webp,image/png,image/jpeg;q=0.9" },
      redirect: "follow", signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res || !res.ok) return null;
    if (res.url && !String(res.url).startsWith("https:")) return null; // 跳转到 http 也不要
    const declared = Number(res.headers?.get?.("content-length") || 0);
    if (declared > MAX_IMAGE_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
    const ext = sniffImage(bytes);
    if (!ext) return null;
    const name = `${await sha16(pageUrl)}.${ext}`;
    const key = `img/${name}`;
    if (!(await store.head(key))) await store.put(key, bytes, { httpMetadata: { contentType: IMG_TYPES[ext] } });
    return `/img/${name}`;
  } catch {
    return null;
  }
}

// Worker：/img/<16 位 hex>.<jpg|png|webp> → R2 img/<同名>
export async function serveImage(req, env) {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const name = new URL(req.url).pathname.replace(/^\/img\//, "");
  const m = KEY_RE.exec(name);
  if (!m) return new Response("Not Found", { status: 404, headers: { "x-content-type-options": "nosniff" } });
  const obj = await env.AUDIO.get(`img/${name}`, { onlyIf: req.headers });
  if (obj === null) return new Response("Not Found", { status: 404, headers: { "x-content-type-options": "nosniff" } });
  const h = new Headers({
    "content-type": IMG_TYPES[m[2]],          // 我们定，不用 R2 里存的元数据
    "x-content-type-options": "nosniff",
    "cache-control": "public, max-age=31536000, immutable",
    "content-security-policy": "default-src 'none'; sandbox",
    etag: obj.httpEtag,
  });
  if (!("body" in obj) || obj.body == null) return new Response(null, { status: 304, headers: h });
  h.set("content-length", String(obj.size));
  return new Response(req.method === "HEAD" ? null : obj.body, { status: 200, headers: h });
}
