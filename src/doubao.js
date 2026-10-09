// 豆包播客 TTS（WebSocket v3，二进制帧）在 Worker 里跑：fetch + Upgrade: websocket 拿到 resp.webSocket。
// 跟 scripts/doubao_podcast.py 同一套协议；2026-10-09 在 Cloudflare 边缘（wrangler dev --remote）实测能用：
// X-Api-Key 头能带上，二进制消息在 Worker 里是 Blob，要先 arrayBuffer()。
const URL_ = "https://openspeech.bytedance.com/api/v3/sami/podcasttts";
const EV = { StartConnection: 1, FinishConnection: 2, StartSession: 100, FinishSession: 102 };
const enc = new TextEncoder(), dec = new TextDecoder();
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
export function frame(event, payload, sid) {
  const body = enc.encode(JSON.stringify(payload));
  const parts = [new Uint8Array([0x11, 0x14, 0x10, 0x00]), u32(event)];
  if (sid != null) { const s = enc.encode(sid); parts.push(u32(s.length), s); }
  parts.push(u32(body.length), body);
  return cat(...parts);
}
async function gunzip(b) { return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()); }
export async function parse(buf) {
  const m = new Uint8Array(buf), dv = new DataView(m.buffer, m.byteOffset);
  const mtype = m[1] >> 4, flags = m[1] & 15, comp = m[2] & 15;
  let p = 4;
  if (mtype === 15) { const code = dv.getUint32(p); p += 4; const n = dv.getUint32(p); p += 4; let d = m.slice(p, p + n); if (comp === 1) d = await gunzip(d); return { error: code, payload: dec.decode(d) }; }
  let event = null; if (flags & 4) { event = dv.getUint32(p); p += 4; }
  let sid = null; if (event !== null) { const n = dv.getUint32(p); p += 4; sid = dec.decode(m.slice(p, p + n)); p += n; }
  const n = dv.getUint32(p); p += 4; let data = m.slice(p, p + n); if (comp === 1) data = await gunzip(data);
  return { mtype, event, sid, data };
}
// 返回 { audio: Uint8Array, rounds: [{text,start_time,end_time,...}] }，出错抛异常
export async function synthesize(apiKey, payload, { timeoutMs = 240000 } = {}) {
  const resp = await fetch(URL_, { headers: { Upgrade: "websocket", "X-Api-Key": apiKey, "X-Api-Resource-Id": "volc.service_type.10050", "X-Api-Request-Id": crypto.randomUUID() } });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`WebSocket 握手失败：HTTP ${resp.status} ${await resp.text().catch(() => "")}`.slice(0, 300));
  ws.accept();
  const queue = [], waiters = [];
  let closed = null;
  ws.addEventListener("message", (e) => { const w = waiters.shift(); if (w) w(e.data); else queue.push(e.data); });
  ws.addEventListener("close", (e) => { closed = `closed ${e.code} ${e.reason}`; while (waiters.length) waiters.shift()(null); });
  const recv = () => queue.length ? Promise.resolve(queue.shift()) : closed ? Promise.resolve(null) : new Promise((r) => waiters.push(r));
  const deadline = Date.now() + timeoutMs;
  const next = async () => {
    let d = await Promise.race([recv(), new Promise((_, rej) => setTimeout(() => rej(new Error("TTS 超时")), Math.max(1, deadline - Date.now())))]);
    if (d == null) throw new Error(`连接断开：${closed}`);
    if (typeof Blob !== "undefined" && d instanceof Blob) d = await d.arrayBuffer(); // Worker 里二进制消息可能是 Blob
    return parse(typeof d === "string" ? enc.encode(d) : d);
  };
  ws.send(frame(EV.StartConnection, {}));
  let r = await next(); if (r.error) throw new Error(`StartConnection ${r.error} ${r.payload}`);
  const sid = crypto.randomUUID();
  ws.send(frame(EV.StartSession, payload, sid)); ws.send(frame(EV.FinishSession, {}, sid));
  const chunks = []; const rounds = []; let cur = null;
  for (;;) {
    r = await next();
    if (r.error) throw new Error(`TTS 错误 ${r.error} ${r.payload}`.slice(0, 300));
    if (r.event === 361) { chunks.push(r.data); continue; }
    const txt = dec.decode(r.data);
    if (r.event === 360) cur = JSON.parse(txt);
    else if (r.event === 362) { const m = JSON.parse(txt); if (cur) { Object.assign(cur, m); rounds.push(cur); cur = null; } if (m.is_error) throw new Error(`round error ${txt}`.slice(0, 300)); }
    else if (r.event === 152) break;
  }
  try { ws.send(frame(EV.FinishConnection, {})); ws.close(1000, "done"); } catch {}
  return { audio: cat(...chunks), rounds };
}
