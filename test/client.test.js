import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJSON, measureClock, validSchedule } from '../public/client.js';

test('clock survives failed samples and chooses the fastest successful response', async () => {
  let call = 0, tick = 0;
  const clock = await measureClock({ samples: 3, perf: { timeOrigin: 1000, now: () => ++tick }, fetch: async () => {
    if (++call === 1) throw new Error('offline');
    return { ok: true, json: async () => ({ now: 2000 }) };
  } });
  assert.ok(Number.isFinite(clock.offset));
  assert.ok(clock.rtt > 0);
});
test('all failed or malformed clock samples reject instead of inventing a server clock', async () => {
  await assert.rejects(measureClock({ samples: 2, fetch: async () => ({ ok: true, json: async () => ({ now: 'bad' }) }) }));
});
test('HTTP failures reject and every request carries a timeout signal', async () => {
  await assert.rejects(fetchJSON('/api/time', { fetch: async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal); assert.equal(options.cache, 'no-store');
    return { ok: false, status: 503 };
  } }), /503/);
});
test('accept empty schedules but reject malformed refreshes and invalid future boundaries', () => {
  const empty = { anchor: 100, total: 0, items: [] };
  const full = { anchor: 100, total: 1000, items: [{ audio: '/audio/a.mp3', start: 100, duration: 1 }] };
  assert.equal(validSchedule(empty), true);
  assert.equal(validSchedule(full), true);
  assert.equal(validSchedule({ current: full, next: empty, switchAt: 1100 }), true);
  for (const bad of [null, {}, { ...full, total: 0 }, { ...full, items: [null] }, { current: full, next: full }, { ...full, items: [{ audio: 'https://other.test/a.mp3', start: 100, duration: 1 }] }]) assert.equal(validSchedule(bad), false);
});
