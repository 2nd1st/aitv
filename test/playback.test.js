import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as timeline from '../public/timeline.js';

// Run the real app with media/timers controlled. No animation frames are delivered:
// background audio must continue even when the browser stops rendering.
async function boot(duration = 5) {
  let time = 1000, callbacks, raf;
  const timers = [], audios = [], nodes = new Map();
  const node = () => ({ textContent: '', hidden: false, style: {}, removeAttribute() {}, getAttribute() {}, addEventListener(type, fn) { this[type] = fn; }, matches: () => false });
  const doc = { hidden: false, activeElement: null, getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, querySelector: () => null, createElement: node, body: { appendChild() {} }, addEventListener(type, fn) { this[type] = fn; } };
  class Audio {
    constructor(src) { Object.assign(this, { src, currentSrc: src, currentTime: 0, duration: 4.4, readyState: 4, networkState: 1, paused: true, ended: false, seeking: false, events: {}, plays: 0, loads: 0 }); audios.push(this); }
    addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
    emit(type) { for (const fn of this.events[type] || []) fn(); }
    play() { this.plays++; if (this.reject) return Promise.reject(this.reject); this.paused = false; this.emit('playing'); return Promise.resolve(); }
    removeAttribute() {}
    getAttribute() { return this.src; }
    pause() { this.paused = true; }
    load() { this.loads++; this.readyState = 0; this.error = null; }
  }
  const schedule = { anchor: 1000, total: duration * 2000, items: [0, 1].map(i => ({ id: String(i), audio: `/audio/${i}.mp3`, start: 1000 + i * duration * 1000, duration, fields: {} })) };
  const context = vm.createContext({ ...timeline, walkAt: timeline.walk, measureClock: async () => ({ offset: 0, rtt: 1 }), fetchJSON: async () => schedule, validSchedule: () => true, Audio, document: doc, window: { addEventListener() {} }, location: { search: '' }, URLSearchParams, performance: { timeOrigin: 0, now: () => time, mark() {} }, console,
    mockCreateTV: (_root, cb) => { callbacks = cb; return { setMuted() {}, setPaused() {}, render() {}, powerOn() {} }; },
    setInterval(fn, delay) { const t = { fn, delay, at: time + delay, repeat: true }; timers.push(t); return t; },
    setTimeout(fn, delay) { const t = { fn, delay, at: time + delay }; timers.push(t); return t; },
    clearTimeout(t) { if (t) t.cancelled = true; },
    requestAnimationFrame(fn) { raf = fn; },
  });
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/const screenModule = import\([^\n]+\);/, 'const screenModule = Promise.resolve({ createTV: mockCreateTV });');
  await vm.runInContext(`(async () => { ${src} })()`, context);
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  return { context, audios, nodes, callbacks,
    async advance(ms) { time += ms; for (const t of [...timers]) if (!t.cancelled && t.at <= time) { if (t.repeat) t.at = time + t.delay; else t.cancelled = true; t.fn(); } await flush(); },
    async listen() { callbacks.onListen(); await flush(); },
    frame() { raf(); },
  };
}

test('audio advances across a programme boundary without animation frames', async () => {
  const app = await boot(); await app.listen();
  await app.advance(5100);
  assert.equal(app.context.window.__aitv.player.audio.src, '/audio/1.mp3');
  assert.equal(app.context.window.__aitv.player.audio.paused, false);
});
test('autoplay rejection stays visible and a user gesture restores sound', async () => {
  const app = await boot(); app.audios[0].reject = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
  await app.listen(); app.frame();
  assert.match(app.nodes.get('player-status').textContent, /恢复|点击/);
  assert.equal(app.nodes.get('player-retry').hidden, false);
  const count = app.audios[0].plays;
  await app.advance(1000); assert.equal(app.audios[0].plays, count, 'must not spam rejected play calls');
  app.audios[0].reject = null; await app.listen();
  assert.equal(app.context.window.__aitv.player.audio.paused, false);
  assert.equal(app.nodes.get('player-retry').hidden, true);
});
test('buffering status survives rendering and stalled download is retried', async () => {
  const app = await boot(30); await app.listen(); const a = app.context.window.__aitv.player.audio;
  a.readyState = 2; a.emit('waiting'); app.frame();
  assert.match(app.nodes.get('player-status').textContent, /缓冲/);
  for (let i = 0; i < 13; i++) await app.advance(1000);
  assert.ok(a.loads > 0 || app.audios.some(x => x.loads > 0), 'stalled current audio must reload');
});
test('pause prevents background restart and stale play rejection cannot break resumed audio', async () => {
  const app = await boot(); let reject;
  app.audios[0].play = function () { this.plays++; return new Promise((_ok, no) => { reject = no; }); };
  await app.listen(); app.context.window.__aitv.player.pause();
  app.audios[0].play = function () { this.paused = false; this.emit('playing'); return Promise.resolve(); };
  app.context.window.__aitv.player.resume();
  reject(Object.assign(new Error('old request'), { name: 'NotAllowedError' })); await app.advance(300);
  assert.equal(app.context.window.__aitv.player.audio.paused, false);
  assert.equal(app.nodes.get('player-retry').hidden, true);
  app.context.window.__aitv.player.pause(); await app.advance(5100);
  assert.equal(app.context.window.__aitv.player.audio.paused, true);
});

test('manual reconnect reloads failed media immediately instead of waiting for the watchdog', async () => {
  const app = await boot(30); await app.listen(); const a = app.context.window.__aitv.player.audio;
  a.error = { code: 2 }; a.paused = true; a.emit('error');
  await app.listen();
  assert.equal(a.loads, 1);
  assert.equal(a.error, null);
});
test('advancing audio is not reloaded and waiting clears once sound progresses', async () => {
  const app = await boot(30); await app.listen(); const a = app.context.window.__aitv.player.audio;
  a.emit('waiting');
  for (let i = 0; i < 15; i++) { a.currentTime += 1; await app.advance(1000); }
  assert.equal(a.loads, 0);
  assert.equal(app.nodes.get('player-status').hidden, true);
});
