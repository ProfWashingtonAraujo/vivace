import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { removesLastAdmin } from '../lib/state-guards.mjs';

const admin = { role: 'admin' };

describe('removesLastAdmin', () => {
  it('admin enviando lista vazia apagaria o ultimo admin', () => {
    assert.equal(removesLastAdmin(admin, { admins: [] }), true);
  });

  it('admin sem o campo admins tambem (o store trata ausente como lista vazia)', () => {
    assert.equal(removesLastAdmin(admin, {}), true);
  });

  it('admin enviando itens sem id valido tambem', () => {
    assert.equal(removesLastAdmin(admin, { admins: [null, { name: 'x' }] }), true);
  });

  it('admin mantendo pelo menos um admin com id passa', () => {
    assert.equal(removesLastAdmin(admin, { admins: [{ id: 'adm-1' }] }), false);
  });

  it('profissional nunca escreve admins, entao a regra nao se aplica', () => {
    assert.equal(removesLastAdmin({ role: 'professional' }, { admins: [] }), false);
    assert.equal(removesLastAdmin({ role: 'professional' }, {}), false);
  });
});
