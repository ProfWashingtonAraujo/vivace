// Production build for Vercel. The API lives on another host, so its URL is baked into the bundle
// at build time (see apiUrl() in src/app/vivace.service.ts). Failing here is deliberate: without
// it the app would silently call hostname:3001, which does not exist once deployed.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiUrl = (process.env.VIVACE_API_URL ?? '').trim();

if (!/^https?:\/\/[^\s"']+$/.test(apiUrl)) {
  console.error('build-vercel: set VIVACE_API_URL to the public API origin, e.g. https://vivace-api.onrender.com');
  process.exit(1);
}

const result = spawnSync(process.execPath, [
  join(root, 'node_modules', '@angular', 'cli', 'bin', 'ng.js'),
  'build',
  '--define',
  `VIVACE_API_URL=${JSON.stringify(apiUrl)}`
], { cwd: root, stdio: 'inherit' });

process.exit(result.status ?? 1);
