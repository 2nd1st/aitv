// Preview fixture only: writes local KV, never calls models/TTS or touches production.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const path = resolve(root, process.argv[2] || 'releases/20261009-1227/seed.json');
const seed = JSON.parse(readFileSync(path, 'utf8'));
if (!Array.isArray(seed.items) || !seed.items.length) throw new Error('Seed must contain items');
const run = args => execFileSync('npx', ['wrangler', 'kv', 'key', 'put', ...args, '--binding', 'SCHEDULE', '--local'], { cwd: root, stdio: 'inherit' });
run(['seed:local-preview', '--path', path]);
run(['pointer', JSON.stringify({ version: 'local-preview' })]);
console.log('Local visual preview is ready. Audio and images require your own R2 assets; no paid generation was started.');
