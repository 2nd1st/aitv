import { buildSchedule } from "./schedule.js";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/time") {
      return Response.json({ now: Date.now() }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/schedule") {
      // 上线后从 KV 读；本地先读静态 seed
      let raw = env.SCHEDULE ? await env.SCHEDULE.get("current") : null;
      if (!raw) raw = await (await env.ASSETS.fetch(new URL("/seed.json", url))).text();
      const seed = JSON.parse(raw);
      const sched = seed.anchor ? seed : buildSchedule(seed.items, seed.anchorMs ?? 0);
      return Response.json(sched, { headers: { "cache-control": "no-store" } });
    }
    return env.ASSETS.fetch(req);
  },
  // 每 15 分钟：抓榜 → 写稿 → 校验 → 语音 → 出节目单。失败时保留上一份。
  async scheduled(event, env, ctx) {
    // TODO: 接包打听的抓取模块和豆包语音
  },
};
