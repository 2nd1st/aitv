import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
test('compact schedule keeps playback fields and omits duplicated payload and generation metadata', async () => {
  const item = { id: 'a', audio: '/audio/a.mp3', duration: 5, fields: { title: '新闻', what: '内容' }, rounds: [{ text: '内容', start_time: 0 }], brief: { what: 'private' }, script: { part1: 'private' }, spoken: 'duplicated' };
  const values = { pointer: { version: 'test' }, 'seed:test': { items: [item], anchorMs: 0 } };
  const env = { SCHEDULE: { get: async key => values[key] ?? null } };
  const full = await (await worker.fetch(new Request('https://test/api/schedule'), env)).json();
  const compact = await (await worker.fetch(new Request('https://test/api/schedule?compact=1'), env)).json();
  assert.equal(compact.current.items[0].audio, item.audio);
  assert.deepEqual(compact.current.items[0].rounds, item.rounds);
  assert.equal(compact.current.items[0].fields.title, '新闻');
  assert.equal('items' in compact, false);
  for (const key of ['brief', 'script', 'spoken']) assert.equal(key in compact.current.items[0], false);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length * .65);
  assert.deepEqual(full.items[0].brief, item.brief);
});
