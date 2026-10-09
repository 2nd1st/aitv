// 每日 TTS 上限（设计 + 实现，存储可替换）：
// - KV key 按东八区日期一天一个：ttscap:<YYYYMMDD> = { count, attempts: { <条目 id>: 次数 } }，TTL 两天自动过期。
// - 默认每天最多 40 次合成调用（DAILY_CAP）；同一条（同一个条目 id）一天最多试 2 次（=首次 + 一次重试）。
// - 命中内容寻址缓存（R2 / 本地已有 <hash>.mp3）不算次数——只有真正调豆包才计数。
// - 先占额度再调用（reserve），失败也算一次：防止故障时无限重试烧钱。
// - KV 不是强一致：同一时刻只该有一个流水线在跑（cron 单实例），这里不做分布式锁。
// store：{ get(key) → 对象或 null, put(key, 对象, { expirationTtl }) }。Worker 里包一层 env.SCHEDULE；box 上包 wrangler kv。
export const DAILY_CAP = 40;
export const MAX_TRIES_PER_ITEM = 2;
export const capKey = (ms = Date.now()) => {
  const d = new Date(ms + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, "0");
  return `ttscap:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
};

// 返回 { ok, reason?, count, tries }。ok=true 时已经把额度记上了，调用方随后去合成。
export async function reserveTTS(store, itemId, { now = Date.now(), cap = DAILY_CAP, maxTries = MAX_TRIES_PER_ITEM } = {}) {
  const key = capKey(now);
  const st = (await store.get(key)) || { count: 0, attempts: {} };
  const tries = st.attempts?.[itemId] || 0;
  if (st.count >= cap) return { ok: false, reason: `今天的合成额度已用完（${st.count}/${cap}）`, count: st.count, tries };
  if (tries >= maxTries) return { ok: false, reason: `这条今天已经试过 ${tries} 次`, count: st.count, tries };
  const next = { count: st.count + 1, attempts: { ...(st.attempts || {}), [itemId]: tries + 1 } };
  await store.put(key, next, { expirationTtl: 2 * 86400 });
  return { ok: true, count: next.count, tries: tries + 1 };
}

export async function usage(store, now = Date.now()) {
  return (await store.get(capKey(now))) || { count: 0, attempts: {} };
}
