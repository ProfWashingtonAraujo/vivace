import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { withTestAdmin, writeTestState } from '../scripts/make-test-state.mjs';

const seed = () => ({
  patients: [{ id: 'pat-1' }, { id: 'pat-2' }],
  professionals: [{ id: 'prof-1' }]
});

describe('withTestAdmin', () => {
  it('acrescenta o administrador de teste e preserva o resto do estado', async () => {
    const state = await withTestAdmin(seed());
    assert.deepEqual(state.patients, seed().patients);
    assert.deepEqual(state.professionals, seed().professionals);
    assert.equal(state.admins.length, 1);
    assert.equal(state.admins[0].id, 'adm-1');
    assert.equal(state.admins[0].email, 'admin@vivace.med.br');
  });

  it('a senha vai como hash scrypt do mesmo formato que o servidor grava', async () => {
    const { admins: [admin] } = await withTestAdmin(seed());
    const [prefix, salt, key] = admin.password.split('$');
    assert.equal(prefix, 'scrypt');
    assert.equal(scryptSync('vivace-demo', salt, 64).toString('hex'), key);
  });

  it('nao muda o objeto recebido', async () => {
    const original = seed();
    await withTestAdmin(original);
    assert.equal(original.admins, undefined);
  });

  it('respeita administradores que o estado ja traz', async () => {
    const withAdmin = { ...seed(), admins: [{ id: 'adm-9', name: 'Ja existe', email: 'ja@existe.com', password: 'scrypt$s$h' }] };
    const state = await withTestAdmin(withAdmin);
    assert.deepEqual(state.admins, withAdmin.admins);
  });
});

describe('writeTestState', () => {
  const newDirectory = () => mkdtempSync(join(tmpdir(), 'vivace-test-state-'));

  it('grava no caminho informado, com o administrador', async () => {
    const target = join(newDirectory(), 'estado.json');
    await writeTestState(target, seed());
    const written = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(written.admins[0].email, 'admin@vivace.med.br');
    assert.equal(written.patients.length, 2);
  });

  it('recusa sobrescrever um arquivo que ja existe, e o deixa como estava', async () => {
    const target = join(newDirectory(), 'estado.json');
    writeFileSync(target, 'dados que nao podem ser perdidos');
    await assert.rejects(() => writeTestState(target, seed()), /ja existe/);
    assert.equal(readFileSync(target, 'utf8'), 'dados que nao podem ser perdidos');
  });

  it('so sobrescreve com force', async () => {
    const target = join(newDirectory(), 'estado.json');
    writeFileSync(target, 'antigo');
    await writeTestState(target, seed(), { force: true });
    assert.notEqual(readFileSync(target, 'utf8'), 'antigo');
  });

  it('exige um caminho: nunca escolhe um por conta propria', async () => {
    await assert.rejects(() => writeTestState(undefined, seed()), /caminho/);
    await assert.rejects(() => writeTestState('', seed()), /caminho/);
  });

  it('nao cria o arquivo quando recusa', async () => {
    const directory = newDirectory();
    await assert.rejects(() => writeTestState('', seed()));
    assert.equal(existsSync(join(directory, 'estado.json')), false);
  });
});
