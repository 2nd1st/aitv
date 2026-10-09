import { serveAudio } from "./audio.js";
import { buildSchedule, publicItem } from "./schedule.js";

// 节目单来源：KV（namespace SCHEDULE）
//   "pointer"         → { version, previous }   线上指针，切换 / 回滚只改这一个 key
//   "seed:<version>"  → 该版本的 seed.json（音频在 R2：<version>/<file>.mp3，对外 /audio/<version>/<file>.mp3）
export async function loadSeed(env) {
  const ptr = await env.SCHEDULE.get("pointer", "json");
  if (!ptr?.version) throw new Error("KV 里没有线上指针");
  const seed = await env.SCHEDULE.get(`seed:${ptr.version}`, "json");
  if (!seed) throw new Error(`KV 里没有 seed:${ptr.version}`);
  return { ...seed, version: ptr.version };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/time") {
      return Response.json({ now: Date.now() }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/schedule") {
      let seed;
      try { seed = await loadSeed(env); } catch (e) {
        return Response.json({ error: String(e.message || e) }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      const items = seed.anchor ? seed.items.map(publicItem) : null;
      const sched = items ? { ...seed, items } : buildSchedule(seed.items, seed.anchorMs ?? 0);
      return Response.json({ version: seed.version, ...sched }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname.startsWith("/audio/")) return serveAudio(req, env);
    return env.ASSETS.fetch(req);
  },
  // 每 15 分钟：抓榜 → 写稿 → 校验 → 语音 → 出节目单。失败时保留上一份。
  async scheduled(event, env, ctx) {
    // TODO: 接包打听的抓取模块和豆包语音
  },
};
