import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registrableDomain, screenImageUrl, imageSize, screenImageBytes, storeScreenedImage } from "../src/imagepick.js";
import { fetchMaterial, enrich, _clearHomepageCache } from "../src/enrich.js";
import { sha16 } from "../src/images.js";
import { scriptFields, scriptPrompt, toSeedItem } from "../src/writer.js";

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

// 合成图片字节：只有文件头是真的（宽高），长度补到指定字节数（用来模拟「每像素字节数」）
function png(w, h, len = 2000) { const b = new Uint8Array(Math.max(len, 33)); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]); new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h); return b; }
function jpg(w, h, len = 2000) { const b = new Uint8Array(Math.max(len, 40)); b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255]); return b; }
function webpX(w, h, len = 2000) { const b = new Uint8Array(Math.max(len, 30)); b.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0]); const W = w - 1, H = h - 1; b.set([W & 255, (W >> 8) & 255, (W >> 16) & 255, H & 255, (H >> 8) & 255, (H >> 16) & 255], 24); return b; }
const resp = (bytes) => ({ ok: true, headers: new Headers(), arrayBuffer: async () => bytes.buffer });
function memStore() { const objs = new Map(); return { objs, head: async (k) => (objs.has(k) ? { key: k } : null), put: async (k, v) => { objs.set(k, v); } }; }

test("可注册域名：多级后缀和托管平台子域名", () => {
  assert.equal(registrableDomain("www-cdn.anthropic.com"), "anthropic.com");
  assert.equal(registrableDomain("news.bbc.co.uk"), "bbc.co.uk");
  assert.equal(registrableDomain("boykopovar.github.io"), "boykopovar.github.io");
  assert.equal(registrableDomain("ph-files.imgix.net"), "imgix.net");
});

test("按地址筛：logo / 图标字样、聚合站、别家域名不要；同站和常见 CDN 可以", () => {
  const page = "https://www.example.com/blog/post-1";
  const no = (img, opts, re) => { const r = screenImageUrl(img, page, opts); assert.equal(r.ok, false, img); if (re) assert.match(r.reason, re); };
  no("https://www.example.com/static/logo.png", {}, /logo/);
  no("https://www.example.com/favicon-512.png", {}, /favicon/);
  no("https://www.example.com/assets/icons/app.png", {}, /icon/);
  no("https://www.example.com/u/avatar_big.jpg", {}, /avatar/);
  no("https://www.example.com/press/brand-card.jpg", {}, /brand/);
  no("https://aihot.news/og/items/x8r8.png", {}, /聚合站/);
  no("https://aihot.virxact.com/og.png", {}, /聚合站/);
  no("https://other-site.net/cover.jpg", {}, /别的域名/);
  no("http://www.example.com/cover.jpg", {}, /https/);
  no("https://www.example.com/cover.jpg", { width: 200, height: 200 }, /太小/);
  no("https://www.example.com/cover.jpg", { width: 400, height: 400 }, /正方形/);
  no("https://www.example.com/og-default.jpg?v=2", { homepageImage: "https://www.example.com/og-default.jpg" }, /首页/);
  assert.equal(screenImageUrl("https://aihot.news/x.png", "https://aihot.news/items/abc").ok, false, "聚合站页面自己的分享卡");
  const yes = (img, p = page) => assert.equal(screenImageUrl(img, p).ok, true, img);
  yes("https://www.example.com/images/silicon-chip.jpg"); // silicon 里有 icon 但不是单词
  yes("https://cdn.example.com/cover.jpg");
  yes("https://d1234.cloudfront.net/cover.jpg");
  yes("https://images.ctfassets.net/abc/cover.png");
  yes("https://ph-files.imgix.net/11044e05-2084-4f65-a840-99bd5c31d04d.png?auto=format&fit=crop&frame=1&h=512&w=1024", "https://www.producthunt.com/products/irisgo-public-beta");
  yes("https://opengraph.githubassets.com/1/owner/repo", "https://github.com/owner/repo");
  yes("https://raw.githubusercontent.com/owner/repo/HEAD/cover.png", "https://github.com/owner/repo");
  yes("https://www.example.com/cover.jpg", page);
  // X 帖子：帖子里的图在 pbs.twimg.com/media，算 X 自己的 CDN；头像不要
  yes("https://pbs.twimg.com/media/HUCIBOPXMAArKc8?format=webp&name=large", "https://x.com/Google/status/2107836410254291345");
  assert.match(screenImageUrl("https://pbs.twimg.com/profile_images/1/abc_400x400.jpg", "https://x.com/Google/status/2107836410254291345").reason, /头像/);
  no("https://pbs.twimg.com/media/HUCIBOPXMAArKc8", {}, /别的域名/); // 不是 X 的页面就不算
});

test("文件头读宽高：png / jpg / webp", () => {
  assert.deepEqual(imageSize(png(1200, 630)), { width: 1200, height: 630 });
  assert.deepEqual(imageSize(jpg(2400, 1260)), { width: 2400, height: 1260 });
  assert.deepEqual(imageSize(webpX(1024, 512)), { width: 1024, height: 512 });
  assert.equal(imageSize(new TextEncoder().encode("<svg/>")), null);
});

test("按真实字节筛：太小、正方形小图、画面太素（纯字标卡）不要", () => {
  assert.match(screenImageBytes(png(256, 256)).reason, /太小/);       // PH 产品图标就是 256×256
  assert.match(screenImageBytes(png(480, 480)).reason, /正方形/);
  // 数字照真实图：Anthropic 字标卡 2400×1260 只有 30702 字节；Sonnet 5.5 发布图 1200×630 有 77390 字节
  assert.match(screenImageBytes(jpg(2400, 1260, 30702)).reason, /太素/);
  assert.equal(screenImageBytes(jpg(1200, 630, 77390), { logoAlt: true }).ok, true, "alt 写着 logo 但画面不素：留");
  assert.equal(screenImageBytes(jpg(2400, 1260, 50639)).ok, true, "插画（claude.com 那张 0.0167）留");
  assert.equal(screenImageBytes(jpg(2400, 1260, 50639), { logoAlt: true }).ok, false, "alt 写着 logo 时门槛放宽");
  assert.equal(screenImageBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2])).ok, true, "读不出尺寸不据此拒");
});

test("storeScreenedImage：合格的经 storeImage 存进桶，返回 /img/<key>；不合格不下载或不写桶，返回 null 和原因", async () => {
  const store = memStore(), page = "https://techcrunch.com/2026/10/08/x/";
  let fetched = 0;
  const f = (bytes) => async () => { fetched++; return resp(bytes); };
  const ok = await storeScreenedImage(store, "https://techcrunch.com/wp-content/uploads/a.jpg", page, { fetch: f(jpg(1200, 591, 22269)) });
  assert.equal(ok.image, `/img/${await sha16(page)}.jpg`);
  assert.equal(store.objs.size, 1);
  const logo = await storeScreenedImage(memStore(), "https://www-cdn.anthropic.com/images/x-2400x1260.jpg", "https://www.anthropic.com/news/x", { fetch: f(jpg(2400, 1260, 30702)), hint: { logoAlt: true } });
  assert.equal(logo.image, null); assert.match(logo.reason, /太素/);
  const n = fetched;
  const third = await storeScreenedImage(store, "https://evil.example/x.jpg", page, { fetch: f(jpg(1200, 630, 80000)) });
  assert.equal(third.image, null); assert.equal(fetched, n, "第三方地址根本不下载");
  const svg = await storeScreenedImage(store, "https://techcrunch.com/a.png", page, { fetch: f(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")) });
  assert.equal(svg.image, null);
  assert.equal((await storeScreenedImage(store, null, page)).image, null);
  assert.equal(store.objs.size, 1);
});

// 假网络：按地址返回裁剪过的真实页面
function net(map) {
  return async (url) => {
    url = String(url);
    for (const [k, v] of Object.entries(map)) if (url === k) return typeof v === "function" ? v() : new Response(v, { headers: { "content-type": "text/html" } });
    return new Response("nope", { status: 404 });
  };
}

test("补料：原文 og:image 筛过才留；聚合站分享卡、跟首页一样的默认图不要", async () => {
  _clearHomepageCache();
  const tc = "https://techcrunch.com/2026/10/08/google-brings-agentic-ai-to-gemini-starting-with-businesses/";
  const hn = { id: "hn-1", source: "Hacker News", url: tc, fields: { title: "x" } };
  const m = await fetchMaterial(hn, { fetchImpl: net({ [tc]: fx("orig-techcrunch-gemini-agent.html") }) });
  assert.match(m.image, /^https:\/\/techcrunch\.com\/wp-content\/uploads\//);
  assert.equal(m.imageReject, null);
  // 首页的 og:image 跟文章的一样 → 站点默认图
  _clearHomepageCache();
  const same = `<html><head><meta property="og:image" content="https://techcrunch.com/wp-content/uploads/2026/10/image_3.max-2100x2100_0CYZWqn.jpg?resize=1200,591"></head></html>`;
  const m2 = await fetchMaterial(hn, { fetchImpl: net({ [tc]: fx("orig-techcrunch-gemini-agent.html"), "https://techcrunch.com/": same }) });
  assert.equal(m2.image, null); assert.match(m2.imageReject, /首页/);
  _clearHomepageCache();
  const page = "https://aihot.news/items/x8r8kta42au39pp06f02shk9f";
  const m3 = await fetchMaterial({ id: "a", source: "Hacker News", url: page, fields: { title: "x" } }, { fetchImpl: net({ [page]: fx("aihot-item-page.html") }) });
  assert.equal(m3.image, null); assert.match(m3.imageReject, /聚合站/);
  // PH 发布页：og:image 是 PH 图库（ph-files.imgix.net），算产品自己的图
  const ph = "https://www.producthunt.com/products/kloudmate";
  const m4 = await fetchMaterial({ id: "ph-1", source: "Product Hunt", url: ph, fields: { title: "KloudMate" } }, { fetchImpl: net({ [ph]: fx("ph-page.html") }), homepageCheck: false });
  assert.match(m4.image, /^https:\/\/ph-files\.imgix\.net\//);
});

test("enrich 传了 imageStore：item.image 是 /img/<key> 或 null；图片地址不进写稿 / 补料模型的提示词", async () => {
  _clearHomepageCache();
  const tc = "https://techcrunch.com/2026/10/08/google-brings-agentic-ai-to-gemini-starting-with-businesses/";
  const item = { id: "hn-1", source: "Hacker News", url: tc, fields: { title: "Google brings agentic AI to Gemini" } };
  const prompts = [];
  const llm = async (p) => { prompts.push(p); return JSON.stringify({ kind: "news", what: "谷歌把智能体带进了企业版", who: "用谷歌办公套件的公司", highlight: "能替员工跑整段流程" }); };
  const fetchImpl = net({ [tc]: fx("orig-techcrunch-gemini-agent.html"), "https://techcrunch.com/wp-content/uploads/2026/10/image_3.max-2100x2100_0CYZWqn.jpg?resize=1200,591": () => resp(jpg(1200, 591, 22269)) });
  const store = memStore();
  const r = await enrich(item, { llm, fetchImpl, imageStore: store });
  assert.equal(r.image, `/img/${await sha16(tc)}.jpg`);
  assert.ok(prompts.length && prompts.every((p) => !p.includes("wp-content") && !p.includes("/img/")));
  assert.ok(!JSON.stringify(scriptFields(r)).includes("/img/"));
  assert.ok(!scriptPrompt(r).includes("/img/") && !scriptPrompt(r).includes("wp-content"));
  assert.equal(toSeedItem(r).image, r.image);
  // 图是纯字标卡：没图，原因记在 imageNote（不进 seed）
  _clearHomepageCache();
  const an = "https://www.anthropic.com/news/2026-usage-policy-update";
  const r2 = await enrich({ id: "hn-2", source: "Hacker News", url: an, fields: { title: "2026 Usage Policy update" } }, {
    llm, imageStore: memStore(),
    fetchImpl: net({ [an]: fx("orig-anthropic-usage-policy.html"), "https://www-cdn.anthropic.com/images/4zrzovbb/website/6d4a0d28992ade92d6fa63646fd9c9d318245c6c-2400x1260.jpg": () => resp(jpg(2400, 1260, 30702)) }),
  });
  assert.equal(r2.image, null);
  assert.match(r2.imageNote, /太素/);
  assert.ok(!("imageNote" in toSeedItem(r2)) && !("imageHint" in toSeedItem(r2)));
});
