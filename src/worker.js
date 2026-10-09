import { buildSchedule, publicItem } from "./schedule.js";

// 节目单来源：KV（以后）→ 线上指针 /current.json 指向的版本 /seeds/<version>/seed.json → 老的 /seed.json
async function loadSeed(env, url) {
  const kv = env.SCHEDULE ? await env.SCHEDULE.get("current") : null;
  if (kv) return JSON.parse(kv);
  const ptr = await env.ASSETS.fetch(new URL("/current.json", url));
  if (ptr.ok) {
    const { version } = await ptr.json();
    if (version) {
      const r = await env.ASSETS.fetch(new URL(`/seeds/${version}/seed.json`, url));
      if (r.ok) return { version, ...(await r.json()) };
    }
  }
  return JSON.parse(await (await env.ASSETS.fetch(new URL("/seed.json", url))).text());
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/time") {
      return Response.json({ now: Date.now() }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/schedule") {
      const seed = await loadSeed(env, url);
      const items = seed.anchor ? seed.items.map(publicItem) : null;
      const sched = items ? { ...seed, items } : buildSchedule(seed.items, seed.anchorMs ?? 0);
      return Response.json({ version: seed.version ?? null, ...sched }, { headers: { "cache-control": "no-store" } });
    }
    return env.ASSETS.fetch(req);
  },
  // 每 15 分钟：抓榜 → 写稿 → 校验 → 语音 → 出节目单。失败时保留上一份。
  async scheduled(event, env, ctx) {
    // TODO: 接包打听的抓取模块和豆包语音
  },
};
