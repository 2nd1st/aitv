// Network failures must not prevent the player from mounting or refreshing.
export async function fetchJSON(url, { fetch: request = globalThis.fetch, timeout = 5000 } = {}) {
  const response = await request(url, { cache: 'no-store', signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function measureClock({ fetch: request = globalThis.fetch, perf = performance, samples = 7 } = {}) {
  const results = await Promise.allSettled(Array.from({ length: samples }, async () => {
    const t0 = perf.now();
    const { now } = await fetchJSON('/api/time', { fetch: request });
    const t1 = perf.now();
    if (!Number.isFinite(now)) throw new Error('Invalid server time');
    return { rtt: t1 - t0, offset: now - (perf.timeOrigin + (t0 + t1) / 2) };
  }));
  const valid = results.filter(r => r.status === 'fulfilled').map(r => r.value).sort((a, b) => a.rtt - b.rtt);
  if (!valid.length) throw new Error('Clock unavailable');
  return valid[0];
}

export function validSchedule(body) {
  const valid = s => s && Array.isArray(s.items) && Number.isFinite(s.anchor) && Number.isFinite(s.total) &&
    (s.items.length ? s.total > 0 && s.items.every(it => it && typeof it.audio === 'string' && it.audio.startsWith('/audio/') && Number.isFinite(it.start) && it.duration > 0) : s.total === 0);
  return !!(body && valid(body.current || body) && (!body.next || (valid(body.next) && Number.isFinite(body.switchAt))));
}
