import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loginKeys } from '../lib/login-keys.mjs';

const mariana = { role: 'patient', userId: 'pat-1' };

describe('loginKeys', () => {
  it('variantes do mesmo identificador caem na mesma chave de conta', () => {
    const keysFor = identifier => loginKeys({ ip: '1.1.1.1', account: mariana, identifier });
    const accountKey = identifier => keysFor(identifier).find(key => key.startsWith('conta:'));
    assert.equal(accountKey('mari'), accountKey('mariana'));
    assert.equal(accountKey('maria%'), accountKey('mariana.souza@email.com'));
  });

  it('contas diferentes tem chaves diferentes, mesmo com o mesmo papel', () => {
    const other = loginKeys({ ip: '1.1.1.1', account: { role: 'patient', userId: 'pat-2' }, identifier: 'x' });
    const mine = loginKeys({ ip: '1.1.1.1', account: mariana, identifier: 'x' });
    assert.notDeepEqual(other, mine);
  });

  it('a chave de IP continua presente', () => {
    assert.ok(loginKeys({ ip: '9.9.9.9', account: mariana, identifier: 'x' }).includes('ip:9.9.9.9'));
  });

  it('identificador sem conta usa o proprio texto, limitado em tamanho', () => {
    const keys = loginKeys({ ip: '1.1.1.1', account: null, identifier: 'a'.repeat(1000) });
    const accountKey = keys.find(key => key.startsWith('conta:'));
    assert.ok(accountKey.length <= 'conta:?:'.length + 100);
  });

  it('identificador desconhecido nao colide com uma conta real', () => {
    const unknown = loginKeys({ ip: '1.1.1.1', account: null, identifier: 'patient:pat-1' });
    const real = loginKeys({ ip: '1.1.1.1', account: mariana, identifier: 'x' });
    assert.notEqual(unknown[1], real[1]);
  });
});
