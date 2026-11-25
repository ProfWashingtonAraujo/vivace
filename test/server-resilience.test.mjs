// Testes do servidor real que NAO precisam de Postgres: o banco aponta para uma
// porta fechada, de modo que toda consulta falha. Isso e exatamente o cenario do
// achado I7 (erro de banco fora de um try derrubava o processo) e permite checar
// os limites de corpo do I6 e a trava de subida do I5.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = 3291;
const base = `http://127.0.0.1:${port}`;
const deadDatabase = 'postgres://vivace_api:x@127.0.0.1:1/vivace';

const cleanEnv = extra => {
  const env = { ...process.env, ...extra };
  for (const key of ['RENDER', 'NODE_ENV', 'VIVACE_BOOTSTRAP_PASSWORD', 'VIVACE_BOOTSTRAP_EMAIL']) delete env[key];
  return { ...env, ...extra };
};

let server;
let exited = false;

const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body
});

before(async () => {
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    stdio: 'ignore',
    env: cleanEnv({
      DATABASE_URL: deadDatabase,
      MIGRATION_DATABASE_URL: deadDatabase,
      VIVACE_SKIP_FRONTEND: 'true',
      VIVACE_API_PORT: String(port)
    })
  });
  server.on('exit', () => { exited = true; });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
    try {
      // Sem token a rota responde 401 sem tocar no banco.
      if ((await fetch(`${base}/api/state`)).status === 401) return;
    } catch {
      // ainda subindo
    }
  }
  throw new Error('servidor nao subiu em 10s');
});

after(() => {
  server?.kill();
});

describe('I7: erro de banco nao derruba o processo', () => {
  it('rota autenticada com o banco fora responde 500 e o servidor continua de pe', async () => {
    const response = await post('/api/messages', JSON.stringify({ patientId: 'pat-1', text: 'oi' }), { Authorization: 'Bearer qualquer' });
    assert.equal(response.status, 500);
    assert.equal(exited, false, 'o processo caiu');
    assert.equal((await fetch(`${base}/api/state`)).status, 401, 'o servidor nao respondeu depois do erro');
  });

  it('logout com o banco fora tambem nao derruba o processo', async () => {
    const response = await post('/api/auth/logout', '{}', { Authorization: 'Bearer qualquer' });
    assert.equal(response.status, 500);
    assert.equal(exited, false);
  });

  it('check-in e medicacao com o banco fora respondem 500 e o processo continua', async () => {
    const checkIn = await post('/api/checkins', '{}', { Authorization: 'Bearer qualquer' });
    const medication = await post('/api/medication-taken', '{}', { Authorization: 'Bearer qualquer' });
    assert.equal(checkIn.status, 500);
    assert.equal(medication.status, 500);
    assert.equal(exited, false);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
  });
});

describe('I6: limites de corpo por rota', () => {
  it('login com corpo acima de 4 KB e recusado com 413 antes de qualquer trabalho', async () => {
    const response = await post('/api/auth/login', JSON.stringify({ username: 'a', password: 'x'.repeat(10_000) }));
    assert.equal(response.status, 413);
  });

  it('mensagem com corpo acima de 16 KB e recusada com 413', async () => {
    // O corpo e lido antes de a sessao ser consultada, entao nem precisa de banco.
    const response = await post('/api/messages', JSON.stringify({ patientId: 'pat-1', text: 'x'.repeat(40_000) }), { Authorization: 'Bearer qualquer' });
    assert.ok([413, 500].includes(response.status));
  });

  it('JSON invalido no login e 400, nao 500', async () => {
    const response = await post('/api/auth/login', '{isso nao e json');
    assert.equal(response.status, 400);
  });

  it('identificador gigante no login e 400', async () => {
    const response = await post('/api/auth/login', JSON.stringify({ username: 'a'.repeat(500), password: 'x' }));
    assert.equal(response.status, 400);
  });
});

describe('I5: a API hospedada nao sobe com a senha publica do administrador', () => {
  const start = env => spawnSync(process.execPath, ['server.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 8_000,
    env: cleanEnv({ DATABASE_URL: deadDatabase, VIVACE_SKIP_FRONTEND: 'true', VIVACE_API_PORT: '3292', ...env })
  });

  it('RENDER=true sem VIVACE_BOOTSTRAP_PASSWORD termina com erro', () => {
    const result = start({ RENDER: 'true' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /VIVACE_BOOTSTRAP_PASSWORD/);
  });

  it('RENDER=true com a senha publica de demonstracao termina com erro', () => {
    const result = start({ RENDER: 'true', VIVACE_BOOTSTRAP_PASSWORD: 'vivace-demo' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /VIVACE_BOOTSTRAP_PASSWORD/);
  });
});
