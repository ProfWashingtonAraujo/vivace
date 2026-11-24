// Provisioning for hosted environments (for example Render + Neon), run before the API starts:
//
//   node db/provision.mjs && node server.mjs
//
// 1. applies db/migrations (idempotent, checksummed);
// 2. gives the vivace_api role the password that is already inside DATABASE_URL, because the
//    migrations create the role on purpose without one (004_rls.sql);
// 3. on a brand-new database, loads the demo data from db/seed/demo-state.json.
//
// It needs MIGRATION_DATABASE_URL (table owner) and DATABASE_URL (vivace_api). It never truncates
// existing data: the seed step is skipped as soon as patients already has rows.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const apiUrl = process.env.DATABASE_URL;

if (!ownerUrl || !apiUrl) {
  console.error('provision: MIGRATION_DATABASE_URL and DATABASE_URL are both required.');
  process.exit(1);
}

const runScript = (script, extraEnv = {}) => spawnSync(process.execPath, [join(root, 'db', script)], {
  encoding: 'utf8',
  env: { ...process.env, ...extraEnv }
});

console.log('provision: applying migrations');
const migrate = runScript('migrate.mjs');
process.stdout.write(migrate.stdout ?? '');
process.stderr.write(migrate.stderr ?? '');
if (migrate.status !== 0) {
  console.error('provision: migrations failed');
  process.exit(migrate.status ?? 1);
}

const api = new URL(apiUrl);
if (decodeURIComponent(api.username) !== 'vivace_api') {
  console.error('provision: DATABASE_URL must connect as the vivace_api role (the table owner would bypass RLS).');
  process.exit(1);
}
const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();
try {
  await owner.query(`ALTER ROLE vivace_api WITH LOGIN PASSWORD ${owner.escapeLiteral(decodeURIComponent(api.password))}`);
  console.log('provision: vivace_api password set');
} finally {
  await owner.end();
}

if (process.env.VIVACE_SEED_DEMO === 'false') {
  console.log('provision: demo seed disabled');
} else {
  const seed = runScript('import-from-json.mjs', { VIVACE_IMPORT_FILE: process.env.VIVACE_IMPORT_FILE ?? join(root, 'db', 'seed', 'demo-state.json') });
  if (seed.status === 0) {
    console.log('provision: demo data loaded');
    process.stdout.write(seed.stdout ?? '');
  } else if (/ja tem/.test(`${seed.stderr}${seed.stdout}`)) {
    console.log('provision: database already has data, seed skipped');
  } else {
    process.stdout.write(seed.stdout ?? '');
    process.stderr.write(seed.stderr ?? '');
    console.error('provision: seed failed');
    process.exit(seed.status ?? 1);
  }
}
console.log('provision: done');
