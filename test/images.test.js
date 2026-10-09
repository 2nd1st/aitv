import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffImage, storeImage, serveImage, sha16, MAX_IMAGE_BYTES } from "../src/images.js";
import { publicItem } from "../src/schedule.js";
import { checkSeed } from "../src/release.js";

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const WEBP = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const resp = (bytes, headers = {}) => ({ ok: true, headers: new Headers(headers), arrayBuffer: async () => bytes.buffer });

test("sniffImage：只认 jpg / png / webp 的文件头", () => {
  assert.equal(sniffImage(JPG), "jpg"); assert.equal(sniffImage(PNG), "png"); assert.equal(sniffImage(WEBP), "webp");
  assert.equal(sniffImage(SVG), null); assert.equal(sniffImage(new TextEncoder().encode("GIF89a")), null);
});

// 假 R2 桶：head / put 跟 R2 绑定同形
function fakeStore() {
  const objs = new Map(), puts = [];
  return { objs, puts,
    async head(key) { return objs.has(key) ? { key, size: objs.get(key).bytes.length } : null; },
    async put(key, bytes, opts) { puts.push({ key, type: opts?.httpMetadata?.contentType }); objs.set(key, { bytes, opts }); return { key }; } };
}

test("storeImage(store, imageUrl, pageUrl, { fetch })：文件头定扩展名，key = img/<sha256(pageUrl) 前 16 位>.<ext>，已存在不重传", async () => {
  const store = fakeStore();
  const page = "https://a.test/post";
  const h = await sha16(page);
  const r = await storeImage(store, "/cover.jpg", page, { fetch: async (u) => (assert.equal(u, "https://a.test/cover.jpg"), resp(PNG)) });
  assert.equal(r, `/img/${h}.png`);
  assert.deepEqual(store.puts, [{ key: `img/${h}.png`, type: "image/png" }]);
  assert.equal(await storeImage(store, "/cover.jpg", page, { fetch: async () => resp(PNG) }), `/img/${h}.png`);
  assert.equal(store.puts.length, 1); // 已存在：跳过
  assert.equal(await storeImage(store, "https://b.test/w.webp", "https://b.test/", { fetch: async () => resp(WEBP) }), `/img/${await sha16("https://b.test/")}.webp`);
  assert.equal(await storeImage(store, "https://b.test/j", "https://c.test/", { fetch: async () => resp(JPG) }), `/img/${await sha16("https://c.test/")}.jpg`);
});

test("storeImage：SVG / GIF / 超 2MB / http / 跳转到 http / 404 / 抛错 / 缺参数都返回 null，不抛", async () => {
  const store = fakeStore(), page = "https://a.test/post";
  const no = async (img, fetch, st = store) => assert.equal(await storeImage(st, img, page, { fetch }), null);
  await no("https://a.test/x.svg", async () => resp(SVG));
  await no("https://a.test/x.gif", async () => resp(new TextEncoder().encode("GIF89a........")));
  await no("http://a.test/x.jpg", async () => resp(JPG));
  await no("https://a.test/r.jpg", async () => ({ ...resp(JPG), url: "http://a.test/r.jpg" }));
  await no("https://a.test/big.jpg", async () => resp(JPG, { "content-length": String(MAX_IMAGE_BYTES + 1) }));
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1); big.set(JPG);
  await no("https://a.test/big2.jpg", async () => resp(big));
  await no("https://a.test/404.jpg", async () => ({ ok: false }));
  await no("https://a.test/err.jpg", async () => { throw new Error("x"); });
  await no("https://a.test/x.jpg", async () => resp(JPG), { head: async () => { throw new Error("r2 down"); }, put: async () => {} });
  await no(null, async () => resp(JPG));
  assert.equal(await storeImage(null, "https://a.test/x.jpg", page, { fetch: async () => resp(JPG) }), null);
  assert.equal(store.puts.length, 0);
});

const ETAG = '"img1"';
const env = { AUDIO: { async get(key, { onlyIf }) {
  if (key !== "img/0123456789abcdef.png") return null;
  const base = { size: PNG.length, httpEtag: ETAG, httpMetadata: { contentType: "image/svg+xml" } };
  return onlyIf.get("if-none-match") === ETAG ? base : { ...base, body: new Blob([PNG]).stream() };
} } };
const req = (p, h = {}, method = "GET") => new Request("https://aitv.test" + p, { headers: h, method });

test("/img/*：Content-Type 由扩展名白名单决定（不信 R2 元数据），nosniff，长缓存，304，非白名单 404", async () => {
  const res = await serveImage(req("/img/0123456789abcdef.png"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("cache-control"), /max-age=31536000/);
  assert.equal(res.headers.get("content-length"), String(PNG.length));
  assert.equal((await serveImage(req("/img/0123456789abcdef.png", { "if-none-match": ETAG }), env)).status, 304);
  for (const p of ["/img/0123456789abcdef.svg", "/img/0123456789abcdef.gif", "/img/../x.png", "/img/abc.png", "/img/fedcba9876543210.png"])
    assert.equal((await serveImage(req(p), env)).status, 404, p);
  assert.equal((await serveImage(req("/img/0123456789abcdef.png", {}, "POST"), env)).status, 405);
});

test("节目单里不许有第三方图片地址", () => {
  assert.equal(publicItem({ id: "a", image: "https://cdn.test/x.jpg" }).image, null);
  assert.equal(publicItem({ id: "a", image: "/img/0123456789abcdef.webp" }).image, "/img/0123456789abcdef.webp");
  const seed = { version: "v", items: [{ id: "a", image: "https://cdn.test/x.jpg" }] };
  assert.ok(checkSeed(seed, "v", { audioBytes: () => 0, minPlayable: 0 }).errors.some((e) => e.includes("第三方")));
});
