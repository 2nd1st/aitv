import { serveAudio } from "./audio.js";
import { serveImage } from "./images.js";
import { buildSchedule, publicItem } from "./schedule.js";

// 部署的是哪个提交：scripts/deploy.mjs 用 `wrangler deploy --define BUILD_COMMIT:"<sha>"` 在构建时注入；本地 / 测试里是 "dev"。
/* global BUILD_COMMIT */
export const COMMIT = typeof BUILD_COMMIT !== "undefined" ? BUILD_COMMIT : "dev";

// 节目单来源：KV（namespace SCHEDULE）
//   "pointer"         → { version, previous, commit, switchedAt }   线上指针，切换 / 回滚只改这一个 key
//   "seed:<version>"  → 该版本的 seed.json（音频在 R2：<hash>.mp3，对外 /audio/<hash>.mp3；配图在 R2 img/<key>，对外 /img/<key>）
export async function loadSeed(env) {
  const ptr = await env.SCHEDULE.get("pointer", "json");
  if (!ptr?.version) throw new Error("KV 里没有线上指针");
  const seed = await env.SCHEDULE.get(`seed:${ptr.version}`, "json");
  if (!seed) throw new Error(`KV 里没有 seed:${ptr.version}`);
  return { ...seed, version: ptr.version, releaseCommit: ptr.commit || null };
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
      const { releaseCommit, ...rest } = seed;
      const items = rest.anchor ? rest.items.map(publicItem) : null;
      const sched = items ? { ...rest, items } : buildSchedule(rest.items, rest.anchorMs ?? 0);
      // commit：线上 Worker 的提交；releaseCommit：切到这个节目单版本时仓库的提交
      return Response.json({ version: seed.version, commit: COMMIT, releaseCommit, ...sched }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname.startsWith("/audio/")) return serveAudio(req, env);
    if (url.pathname.startsWith("/img/")) return serveImage(req, env);
    return env.ASSETS.fetch(req);
  },
  // 每 15 分钟：抓榜 → 写稿 → 校验 → 语音 → 出节目单。失败时保留上一份。
  async scheduled(event, env, ctx) {
    // TODO: 接包打听的抓取模块和豆包语音
  },
};
