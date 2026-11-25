import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveBootstrap } from '../lib/bootstrap-config.mjs';

describe('resolveBootstrap', () => {
  it('em desenvolvimento, sem variaveis, usa o administrador de demonstracao', () => {
    assert.deepEqual(resolveBootstrap({}), { email: 'admin@vivace.med.br', password: 'vivace-demo' });
  });

  it('em desenvolvimento, respeita as variaveis quando existem', () => {
    const result = resolveBootstrap({ VIVACE_BOOTSTRAP_EMAIL: 'a@b.c', VIVACE_BOOTSTRAP_PASSWORD: 'x' });
    assert.deepEqual(result, { email: 'a@b.c', password: 'x' });
  });

  it('hospedado (RENDER) sem senha configurada recusa subir', () => {
    assert.throws(() => resolveBootstrap({ RENDER: 'true' }), /VIVACE_BOOTSTRAP_PASSWORD/);
  });

  it('NODE_ENV=production sem senha configurada recusa subir', () => {
    assert.throws(() => resolveBootstrap({ NODE_ENV: 'production' }), /VIVACE_BOOTSTRAP_PASSWORD/);
  });

  it('hospedado nao aceita a senha publica de demonstracao', () => {
    assert.throws(() => resolveBootstrap({ RENDER: 'true', VIVACE_BOOTSTRAP_PASSWORD: 'vivace-demo' }), /VIVACE_BOOTSTRAP_PASSWORD/);
  });

  it('hospedado nao aceita senha curta', () => {
    assert.throws(() => resolveBootstrap({ RENDER: 'true', VIVACE_BOOTSTRAP_PASSWORD: 'curta' }), /VIVACE_BOOTSTRAP_PASSWORD/);
  });

  it('hospedado com senha propria e longa sobe', () => {
    const result = resolveBootstrap({ RENDER: 'true', VIVACE_BOOTSTRAP_PASSWORD: 'uma-senha-bem-longa-9' });
    assert.equal(result.password, 'uma-senha-bem-longa-9');
    assert.equal(result.email, 'admin@vivace.med.br');
  });

  it('a mensagem de erro nao repete a senha', () => {
    try {
      resolveBootstrap({ RENDER: 'true', VIVACE_BOOTSTRAP_PASSWORD: 'curta' });
      assert.fail('devia lancar');
    } catch (error) {
      assert.ok(!error.message.includes('curta'));
    }
  });
});
