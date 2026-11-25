import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exceedsDeletionLimit, idsMarkedRead, removesLastAdmin } from '../lib/state-guards.mjs';

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

describe('idsMarkedRead', () => {
  it('devolve so os ids das mensagens marcadas como lidas', () => {
    const messages = [
      { id: 'm1', isRead: true, text: 'a' },
      { id: 'm2', isRead: false, text: 'b' },
      { id: 'm3', text: 'sem o campo' },
      { id: 'm4', isRead: true, text: 'd' }
    ];
    assert.deepEqual(idsMarkedRead(messages), ['m1', 'm4']);
  });

  it('ignora itens invalidos e valores que nao sao exatamente true', () => {
    assert.deepEqual(idsMarkedRead([null, undefined, { isRead: true }, { id: 7, isRead: true }, { id: 'x', isRead: 'true' }, { id: 'y', isRead: 1 }]), []);
  });

  it('aceita ausencia de lista', () => {
    assert.deepEqual(idsMarkedRead(undefined), []);
    assert.deepEqual(idsMarkedRead(null), []);
  });

  it('nao carrega texto nem remetente: so ids, entao nao ha o que forjar', () => {
    const result = idsMarkedRead([{ id: 'm1', isRead: true, sender: 'equipe', senderName: 'Dra. Falsa', text: 'editado' }]);
    assert.deepEqual(result, ['m1']);
  });
});

describe('exceedsDeletionLimit', () => {
  it('apagar um paciente por salvamento e normal (a tela apaga um de cada vez)', () => {
    assert.equal(exceedsDeletionLimit(0), false);
    assert.equal(exceedsDeletionLimit(1), false);
  });

  it('apagar varios de uma vez indica estado velho ou lista vazia', () => {
    assert.equal(exceedsDeletionLimit(2), true);
    assert.equal(exceedsDeletionLimit(40), true);
  });

  it('valor invalido nao passa em silencio', () => {
    assert.equal(exceedsDeletionLimit(Number.NaN), true);
    assert.equal(exceedsDeletionLimit(undefined), true);
  });
});
