// /audio/<hash>.mp3（内容寻址，hash = sha256(音色 + 参数 + 口播稿) 前 16 位；早期版本是 /audio/<version>/<file>.mp3）：从 R2（env.AUDIO）读，支持 Range（206 + Content-Range）和条件请求（ETag / 304）。
// key 一旦写入内容就不变，可以长缓存；回滚只改指针，旧 key 还在。
const KEY_RE = /^(?:[0-9a-f]{16}|\d{8}-\d{4,6}\/[A-Za-z0-9_.-]+)\.mp3$/;

export async function serveAudio(req, env) {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const key = decodeURIComponent(new URL(req.url).pathname.replace(/^\/audio\//, ""));
  if (!KEY_RE.test(key)) return new Response("Not Found", { status: 404 });
  const hasRange = req.headers.has("range");
  let obj;
  try {
    obj = await env.AUDIO.get(key, { range: req.headers, onlyIf: req.headers });
  } catch (e) {
    // 范围超出文件大小等
    const head = await env.AUDIO.head(key);
    if (!head) return new Response("Not Found", { status: 404 });
    return new Response("Range Not Satisfiable", { status: 416, headers: { "content-range": `bytes */${head.size}`, "accept-ranges": "bytes" } });
  }
  if (obj === null) return new Response("Not Found", { status: 404 });

  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("content-type", "audio/mpeg");
  h.set("etag", obj.httpEtag);
  h.set("accept-ranges", "bytes");
  h.set("cache-control", "public, max-age=31536000, immutable");

  // onlyIf 没满足（If-None-Match 命中等）：R2 返回不带 body 的对象
  if (!("body" in obj) || obj.body == null) return new Response(null, { status: 304, headers: h });

  const size = obj.size;
  if (hasRange && obj.range) {
    let start, len;
    // R2Range 的字段可能是原型上的 getter（"suffix" in range 恒为 true），按值判断
    const r = obj.range;
    if (typeof r.suffix === "number") { len = Math.min(r.suffix, size); start = size - len; }
    else { start = typeof r.offset === "number" ? r.offset : 0; len = typeof r.length === "number" ? Math.min(r.length, size - start) : size - start; }
    h.set("content-range", `bytes ${start}-${start + len - 1}/${size}`);
    h.set("content-length", String(len));
    return new Response(req.method === "HEAD" ? null : obj.body, { status: 206, headers: h });
  }
  h.set("content-length", String(size));
  return new Response(req.method === "HEAD" ? null : obj.body, { status: 200, headers: h });
}
