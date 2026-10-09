import { test } from "node:test";
import assert from "node:assert/strict";
import { serveAudio } from "../src/audio.js";
import { pickStoryUrl, refineAIHOTUrls } from "../src/sources.js";

const SIZE = 5000;
const bytes = new Uint8Array(SIZE).map((_, i) => i % 256);
// 模拟 R2：range 字段放在原型 getter 上（和线上 R2Range 一样，"suffix" in r 为 true）
class Range { constructor(o) { this._o = o; } get offset() { return this._o.offset; } get length() { return this._o.length; } get suffix() { return this._o.suffix; } }
function parseRange(h) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(h || ""); if (!m) return null;
  if (m[1] === "") return { suffix: +m[2] };
  const offset = +m[1]; if (offset >= SIZE) throw new Error("range not satisfiable");
  return m[2] === "" ? { offset } : { offset, length: +m[2] - offset + 1 };
}
const ETAG = '"abc"';
const bucket = {
  async head(key) { return key === "20261009-1133/a.mp3" ? { size: SIZE } : null; },
  async get(key, { range, onlyIf }) {
    if (key !== "20261009-1133/a.mp3") return null;
    const base = { size: SIZE, httpEtag: ETAG, writeHttpMetadata() {} };
    if (onlyIf.get("if-none-match") === ETAG) return base;
    const r = parseRange(range.get("range"));
    let start = 0, end = SIZE;
    if (r?.suffix != null) start = SIZE - r.suffix; else if (r) { start = r.offset; end = r.length ? Math.min(SIZE, start + r.length) : SIZE; }
    return { ...base, range: r ? new Range(r) : undefined, body: new Blob([bytes.slice(start, end)]).stream() };
  },
};
const env = { AUDIO: bucket };
const req = (path, headers = {}, method = "GET") => new Request("https://aitv.test" + path, { headers, method });

test("audio: Range → 206，Content-Range/Content-Length 正确", async () => {
  const res = await serveAudio(req("/audio/20261009-1133/a.mp3", { range: "bytes=1000-1999" }), env);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), `bytes 1000-1999/${SIZE}`);
  assert.equal(res.headers.get("content-length"), "1000");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(res.headers.get("content-type"), "audio/mpeg");
  const body = new Uint8Array(await res.arrayBuffer());
  assert.equal(body.length, 1000); assert.equal(body[0], 1000 % 256);
});
test("audio: 开放区间 / 后缀区间", async () => {
  let res = await serveAudio(req("/audio/20261009-1133/a.mp3", { range: "bytes=4000-" }), env);
  assert.equal(res.headers.get("content-range"), `bytes 4000-4999/${SIZE}`);
  assert.equal(res.headers.get("content-length"), "1000");
  res = await serveAudio(req("/audio/20261009-1133/a.mp3", { range: "bytes=-500" }), env);
  assert.equal(res.headers.get("content-range"), `bytes 4500-4999/${SIZE}`);
  assert.equal(res.headers.get("content-length"), "500");
});
test("audio: 无 Range → 200 + Accept-Ranges + ETag", async () => {
  const res = await serveAudio(req("/audio/20261009-1133/a.mp3"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), String(SIZE));
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(res.headers.get("etag"), ETAG);
  assert.match(res.headers.get("cache-control"), /immutable/);
});
test("audio: If-None-Match → 304；越界 → 416；不存在/非法 key → 404；POST → 405", async () => {
  assert.equal((await serveAudio(req("/audio/20261009-1133/a.mp3", { "if-none-match": ETAG }), env)).status, 304);
  const r416 = await serveAudio(req("/audio/20261009-1133/a.mp3", { range: "bytes=9000-9999" }), env);
  assert.equal(r416.status, 416); assert.equal(r416.headers.get("content-range"), `bytes */${SIZE}`);
  assert.equal((await serveAudio(req("/audio/20261009-1133/b.mp3"), env)).status, 404);
  assert.equal((await serveAudio(req("/audio/../secret.mp3"), env)).status, 404);
  assert.equal((await serveAudio(req("/audio/20261009-1133/a.mp3", {}, "POST"), env)).status, 405);
});
test("audio: HEAD 无 body 但有长度", async () => {
  const res = await serveAudio(req("/audio/20261009-1133/a.mp3", {}, "HEAD"), env);
  assert.equal(res.status, 200); assert.equal(res.headers.get("content-length"), String(SIZE));
});

const story = { reports: [
  { publishedAt: "2026-09-28T10:00:00Z", source: { firstParty: true }, links: { original: "https://www.anthropic.com/news/claude-sonnet-5" } },
  { publishedAt: "2026-10-08T10:00:00Z", source: { firstParty: true }, links: { original: "https://www.anthropic.com/claude-haiku-5-5" } },
  { publishedAt: "2026-10-09T10:00:00Z", source: { firstParty: false }, links: { original: "https://www.anthropic.com/media-copy" } },
  { publishedAt: "2026-10-09T11:00:00Z", source: { firstParty: true }, links: { original: "https://other.example/x" } },
] };
test("pickStoryUrl：同站一手报道里最新的一条", () => {
  assert.equal(pickStoryUrl("https://www.anthropic.com/news/claude-sonnet-5", story), "https://www.anthropic.com/claude-haiku-5-5");
  assert.equal(pickStoryUrl("https://x.test/a", { reports: [] }), "https://x.test/a");
  assert.equal(pickStoryUrl("not a url", story), "not a url");
});
test("refineAIHOTUrls：换链接、去掉 storyId；接口失败保留原链接", async () => {
  const items = [{ source: "AIHOT", storyId: "s1", url: "https://www.anthropic.com/news/claude-sonnet-5" }, { source: "AIHOT", storyId: "s2", url: "https://a.test/" }, { source: "Hacker News", url: "https://h.test/" }];
  const fetchImpl = async (u) => u.endsWith("/s1") ? { ok: true, json: async () => ({ story }) } : { ok: false };
  const out = await refineAIHOTUrls(items, { fetchImpl });
  assert.equal(out[0].url, "https://www.anthropic.com/claude-haiku-5-5");
  assert.equal(out[0].originalUrl, "https://www.anthropic.com/news/claude-sonnet-5");
  assert.ok(!("storyId" in out[0]) && !("storyId" in out[1]));
  assert.equal(out[1].url, "https://a.test/"); assert.equal(out[2].url, "https://h.test/");
});

test("audio: 内容寻址 key（/audio/<16 位 hash>.mp3）也能读；json 时间轴和别的扩展名不对外", async () => {
  const hashEnv = { AUDIO: { ...bucket, async get(key, o) { return bucket.get(key === "0123456789abcdef.mp3" ? "20261009-1133/a.mp3" : key, o); } } };
  const res = await serveAudio(req("/audio/0123456789abcdef.mp3", { range: "bytes=1000-1999" }), hashEnv);
  assert.equal(res.status, 206); assert.equal(res.headers.get("content-length"), "1000");
  assert.equal((await serveAudio(req("/audio/0123456789abcdef.json"), hashEnv)).status, 404);
  assert.equal((await serveAudio(req("/audio/0123456789ABCDEF.mp3"), hashEnv)).status, 404);
});
