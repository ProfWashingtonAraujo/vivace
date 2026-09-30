import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const dataDirectory = join(root, '.pgdata');
export const port = Number(process.env.VIVACE_PG_PORT ?? 55432);
export const logFile = join(dataDirectory, 'server.log');
const socketDirectory = join(dataDirectory, 'socket');
const superuser = 'vivace';
const apiRole = 'vivace_api';
const password = 'vivace';

export const superuserUrl = `postgres://${superuser}:${password}@127.0.0.1:${port}/${superuser}`;
export const apiUrl = `postgres://${apiRole}:${password}@127.0.0.1:${port}/vivace`;

const run = (command, args, { allowFailure = false } = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw new Error(`${command} nao pode ser executado: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} falhou (${result.status})\n${result.stderr || result.stdout}`);
  }
  return result;
};

const initialized = () => existsSync(join(dataDirectory, 'PG_VERSION'));

const isRunning = () => run('pg_ctl', ['-D', dataDirectory, 'status'], { allowFailure: true }).status === 0;

const initialize = () => {
  if (initialized()) return;
  mkdirSync(dataDirectory, { recursive: true });
  const passwordFile = join(tmpdir(), `vivace-pwfile-${process.pid}`);
  writeFileSync(passwordFile, password, { mode: 0o600 });
  console.log('initdb: criando cluster em .pgdata');
  const result = run('initdb', [
    '-D', dataDirectory,
    '-U', superuser,
    '--encoding=UTF8',
    '--locale=C',
    '--auth-local=trust',
    '--auth-host=scram-sha-256',
    `--pwfile=${passwordFile}`
  ], { allowFailure: true });
  rmSync(passwordFile, { force: true });
  if (result.status !== 0) {
    throw new Error(`initdb falhou (${result.status})\n${result.stderr || result.stdout}`);
  }
};

const start = () => {
  initialize();
  if (isRunning()) {
    console.log(`postgres ja esta rodando em 127.0.0.1:${port}`);
  } else {
    mkdirSync(socketDirectory, { recursive: true });
    console.log(`pg_ctl: iniciando em 127.0.0.1:${port}`);
    run('pg_ctl', [
      '-D', dataDirectory,
      '-l', logFile,
      '-o', `-p ${port} -k ${socketDirectory} -c listen_addresses=127.0.0.1`,
      '-w',
      'start'
    ]);
  }
  createApiRole();
};

const psql = (sql, database = 'postgres') => run('psql', [
  '-h', socketDirectory,
  '-p', String(port),
  '-U', superuser,
  '-d', database,
  '-v', 'ON_ERROR_STOP=1',
  '-tAc', sql
]);

const createApiRole = () => {
  psql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${apiRole}') THEN
        CREATE ROLE ${apiRole} LOGIN PASSWORD '${password}';
      END IF;
    END $$;
  `);
  if (psql(`SELECT 1 FROM pg_database WHERE datname = 'vivace'`).stdout.trim() !== '1') {
    psql(`CREATE DATABASE vivace OWNER ${superuser}`);
  }
  console.log(`base vivace e papel ${apiRole} prontos`);
};

const stop = () => {
  if (!initialized()) {
    console.log('nenhum cluster em .pgdata');
    return;
  }
  if (!isRunning()) {
    console.log('postgres ja esta parado');
    return;
  }
  console.log('pg_ctl: parando');
  run('pg_ctl', ['-D', dataDirectory, '-m', 'fast', '-w', 'stop']);
};

const status = () => {
  const info = {
    initialized: initialized(),
    running: initialized() && isRunning(),
    port,
    superuserUrl,
    apiUrl
  };
  console.log(JSON.stringify(info, null, 2));
  if (!info.initialized || !info.running) {
    console.log('\nrode: node db/dev-cluster.mjs start');
  } else {
    console.log(`\ncole no .env:\n  MIGRATION_DATABASE_URL=${superuserUrl}\n  DATABASE_URL=${apiUrl}`);
  }
};

const destroy = () => {
  if (initialized() && isRunning()) stop();
  if (initialized()) {
    console.log('removendo .pgdata');
    rmSync(dataDirectory, { recursive: true, force: true });
  }
};

const command = process.argv[2] ?? 'status';
const commands = { start, stop, status, destroy, urls: () => console.log(`${superuserUrl}\n${apiUrl}`) };
if (!commands[command]) {
  console.error(`comando desconhecido: ${command}`);
  console.error(`uso: node db/dev-cluster.mjs <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}
commands[command]();

export { password, apiRole, superuser, socketDirectory };
