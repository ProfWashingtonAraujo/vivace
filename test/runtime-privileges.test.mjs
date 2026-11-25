// O processo da API roda como vivace_api, o papel sem privilégio de dono. Se algum
// código de runtime voltar a abrir uma conexão de dono, a barreira do papel
// não-dono vira só nominal: um bug de SQL ali teria o privilégio inteiro do banco.
// Migrações, provisionamento e import são os únicos que podem usar o dono, e rodam
// fora do servidor.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(root, path), 'utf8');

// Tudo que o servidor carrega em tempo de execução.
const runtimeFiles = [
  'server.mjs',
  'db/store.mjs',
  'db/session.mjs',
  'db/aggregate.mjs',
  ...readdirSync(join(root, 'lib')).filter(name => name.endsWith('.mjs')).map(name => `lib/${name}`)
];

describe('o runtime da API nao usa o papel de dono do banco', () => {
  for (const file of runtimeFiles.filter(name => name !== 'db/session.mjs')) {
    it(`${file} nao abre conexao de dono`, () => {
      const source = read(file);
      assert.ok(!source.includes('createMigrationPool'), 'usa createMigrationPool');
      assert.ok(!source.includes('MIGRATION_DATABASE_URL'), 'le MIGRATION_DATABASE_URL');
      assert.ok(!source.includes('migrationUrlOf'), 'usa migrationUrlOf');
    });
  }

  it('o servidor sobe sem MIGRATION_DATABASE_URL (start:hosted a retira do ambiente)', () => {
    const { scripts } = JSON.parse(read('package.json'));
    assert.match(scripts['start:hosted'], /env -u MIGRATION_DATABASE_URL node server\.mjs/);
    // O provisionamento, sim, precisa do dono e roda antes, em outro processo.
    assert.match(scripts['start:hosted'], /^node db\/provision\.mjs && /);
  });
});

describe('o bootstrap do administrador', () => {
  it('nao roda a cada login: o servidor memoiza o sucesso', () => {
    const source = read('server.mjs');
    assert.match(source, /let adminBootstrapped = false/);
  });

  it('existe uma funcao SQL propria para ele, sem escrita direta nas tabelas', () => {
    const migrations = readdirSync(join(root, 'db', 'migrations'));
    const bootstrap = migrations.find(name => /bootstrap/i.test(name));
    assert.ok(bootstrap, 'migracao do bootstrap ausente');
    const sql = read(`db/migrations/${bootstrap}`);
    assert.match(sql, /app_bootstrap_admin/);
    assert.match(sql, /SECURITY DEFINER/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION app_bootstrap_admin\(text, text, text, text\) TO vivace_api/);
  });
});
