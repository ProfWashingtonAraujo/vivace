import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDirectory = join(root, 'db', 'migrations');
const advisoryLockKey = 4_712_005;

const connectionString = process.env.MIGRATION_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://vivace:vivace@127.0.0.1:55432/vivace';

const checksum = sql => createHash('sha256').update(sql).digest('hex').slice(0, 16);

const migrationFiles = async () => {
  const names = await readdir(migrationsDirectory);
  return names.filter(name => name.endsWith('.sql')).sort();
};

const ensureRegistry = async client => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
};

const main = async () => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await ensureRegistry(client);
    await client.query('SELECT pg_advisory_lock($1)', [advisoryLockKey]);
    const applied = new Map(
      (await client.query('SELECT version, checksum FROM schema_migrations'))
        .rows.map(row => [row.version, row.checksum])
    );
    const files = await migrationFiles();
    if (!files.length) {
      console.log('nenhuma migracao em db/migrations');
      return;
    }
    let pending = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const sql = await readFile(join(migrationsDirectory, file), 'utf8');
      const sum = checksum(sql);
      if (applied.has(version)) {
        if (applied.get(version) !== sum) {
          throw new Error(
            `a migracao ${version} ja foi aplicada com checksum ${applied.get(version)}, ` +
            `mas o arquivo agora soma ${sum}. Escreva uma migracao nova em vez de editar esta.`
          );
        }
        console.log(`pulada    ${version}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, sum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`falha em ${version}: ${error.message}`);
      }
      console.log(`aplicada  ${version}`);
      pending += 1;
    }
    console.log(pending ? `${pending} migracao(oes) aplicada(s)` : 'banco ja estava atualizado');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [advisoryLockKey]).catch(() => undefined);
    await client.end();
  }
};

await main();
