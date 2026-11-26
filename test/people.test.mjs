import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateAdmin, validateProfessional, validateStatus } from '../lib/people.mjs';

const pro = { name: 'Dra. Ana', email: 'ana@vivace.med.br', password: 'senha-ok-123', role: 'Cirurgia', crmCoren: 'CRM-SP 1', specialty: 'Plastica' };

describe('validateProfessional', () => {
  it('aceita um cadastro completo e devolve a senha a parte', () => {
    const result = validateProfessional({ ...pro, name: '  Dra. Ana  ' });
    assert.equal(result.ok, true);
    assert.equal(result.values.name, 'Dra. Ana');
    assert.equal(result.password, 'senha-ok-123');
    assert.ok(!('password' in result.values));
  });

  it('exige nome, e-mail valido e senha de 8 a 128 caracteres', () => {
    for (const over of [{ name: '' }, { email: undefined }, { email: 'invalido' }, { password: undefined }, { password: 'curta' }, { password: 'x'.repeat(129) }]) {
      assert.equal(validateProfessional({ ...pro, ...over }).ok, false, JSON.stringify(over));
    }
  });

  it('recusa tipos errados, tamanhos acima do limite e avatar perigoso', () => {
    for (const over of [{ role: 7 }, { role: 'x'.repeat(61) }, { crmCoren: 'x'.repeat(41) }, { specialty: 'x'.repeat(61) }, { avatar: 'javascript:alert(1)' }, { avatar: 'http://x.com/a.png' }]) {
      assert.equal(validateProfessional({ ...pro, ...over }).ok, false, JSON.stringify(over));
    }
  });

  it('so devolve campos do cadastro: id, versao e outros nunca passam', () => {
    const result = validateProfessional({ ...pro, id: 'x', version: 9, position: 3 });
    assert.deepEqual(Object.keys(result.values).sort(), ['avatar', 'crmCoren', 'email', 'name', 'role', 'specialty']);
  });

  it('parcial: so o que veio, senha ignorada, campo invalido recusa tudo', () => {
    assert.deepEqual(validateProfessional({ specialty: 'x', password: 'tentativa-123' }, { partial: true }), { ok: true, values: { specialty: 'x' }, password: undefined, clientId: undefined });
    assert.equal(validateProfessional({ email: 'invalido' }, { partial: true }).ok, false);
    assert.equal(validateProfessional({ name: '' }, { partial: true }).ok, false);
  });

  it('corpo ausente nao quebra; clientId curto vale como chave de idempotencia', () => {
    for (const input of [undefined, null, 'x', []]) assert.equal(validateProfessional(input).ok, false);
    assert.equal(validateProfessional({ ...pro, clientId: 'prof-abc' }).clientId, 'prof-abc');
    assert.equal(validateProfessional({ ...pro, clientId: 'a'.repeat(101) }).clientId, undefined);
  });
});

describe('validateAdmin', () => {
  const admin = { name: 'Admin', email: 'adm@vivace.med.br', password: 'senha-ok-123' };

  it('aceita nome, e-mail, senha e isSuper; so devolve esses campos, e isSuper comeca falso', () => {
    const result = validateAdmin({ ...admin, id: 'x', version: 9, role: 'x' });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.values).sort(), ['avatar', 'email', 'isSuper', 'name']);
    assert.equal(result.values.avatar, '');
    assert.equal(validateAdmin({ ...admin, avatar: 'http://inseguro/x.png' }).ok, false);
    assert.equal(validateAdmin({ ...admin, avatar: 'https://exemplo.com/x.png' }).values.avatar, 'https://exemplo.com/x.png');
    assert.equal(result.values.isSuper, false);
    assert.equal(validateAdmin({ ...admin, isSuper: true }).values.isSuper, true);
    assert.equal(validateAdmin({ ...admin, isSuper: 'sim' }).ok, false);
    assert.equal(result.password, 'senha-ok-123');
  });

  it('exige os tres na criacao', () => {
    for (const over of [{ name: '' }, { email: 'x' }, { password: 'curta' }]) assert.equal(validateAdmin({ ...admin, ...over }).ok, false, JSON.stringify(over));
  });

  it('parcial: so o que veio', () => {
    assert.deepEqual(validateAdmin({ name: 'Novo' }, { partial: true }).values, { name: 'Novo' });
    assert.equal(validateAdmin({ email: 'invalido' }, { partial: true }).ok, false);
    assert.deepEqual(validateAdmin({ isSuper: true }, { partial: true }).values, { isSuper: true });
  });
});

describe('validateStatus', () => {
  it('aceita os tres valores do front e recusa o resto', () => {
    for (const status of ['estavel', 'atencao', 'critico']) assert.deepEqual(validateStatus({ status }), { ok: true, status });
    for (const status of ['grave', '', undefined, null, 3, 'CRITICO']) assert.equal(validateStatus({ status }).ok, false, String(status));
    assert.equal(validateStatus(undefined).ok, false);
  });
});
