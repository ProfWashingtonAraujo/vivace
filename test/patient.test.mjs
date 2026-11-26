import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultAvatar, postOpDay, validateCareTeam, validatePassword, validatePatient } from '../lib/patient.mjs';

const base = {
  name: 'Ana Souza', email: 'ana@email.com', password: 'senha-ok-123', age: 41, gender: 'Feminino', phone: '(11) 9', cpf: '000',
  procedure: 'Abdominoplastia', surgeryDate: '2026-11-01', dischargeDate: '2026-11-03', hospital: 'Hospital X'
};

describe('validatePatient (criar)', () => {
  it('aceita um cadastro completo, apara textos e devolve a senha a parte', () => {
    const result = validatePatient({ ...base, name: '  Ana Souza  ' });
    assert.equal(result.ok, true);
    assert.equal(result.values.name, 'Ana Souza');
    assert.equal(result.password, 'senha-ok-123');
    assert.ok(!('password' in result.values));
  });

  it('exige nome, e-mail valido e senha de 8 a 128 caracteres', () => {
    for (const over of [{ name: '' }, { name: '  ' }, { email: undefined }, { email: 'invalido' }, { email: 'a@b' }, { password: undefined }, { password: 'curta' }, { password: 'x'.repeat(129) }]) {
      assert.equal(validatePatient({ ...base, ...over }).ok, false, JSON.stringify(over));
    }
  });

  it('os demais campos sao opcionais e viram texto vazio ou zero', () => {
    const result = validatePatient({ name: 'X', email: 'x@y.com', password: 'senha-ok-123' });
    assert.equal(result.ok, true);
    assert.deepEqual([result.values.age, result.values.gender, result.values.phone, result.values.surgeryDate], [0, '', '', '']);
  });

  it('recusa tipos errados e tamanhos acima do limite', () => {
    for (const over of [{ name: 'x'.repeat(121) }, { age: -1 }, { age: 131 }, { age: 'x' }, { age: 4.5 }, { phone: 'x'.repeat(31) }, { cpf: 'x'.repeat(21) }, { hospital: 7 }, { procedure: 'x'.repeat(121) }]) {
      assert.equal(validatePatient({ ...base, ...over }).ok, false, JSON.stringify(over));
    }
  });

  it('datas: vazio ou AAAA-MM-DD que existe no calendario', () => {
    for (const surgeryDate of ['', '2026-02-28', '2024-02-29']) assert.equal(validatePatient({ ...base, surgeryDate }).ok, true, surgeryDate);
    for (const surgeryDate of ['2026-13-45', '2026-02-30', 'ontem', '01/11/2026', '2026-1-1', 20261101]) assert.equal(validatePatient({ ...base, surgeryDate }).ok, false, String(surgeryDate));
  });

  it('avatar: vazio, https ou imagem de verdade; o resto e recusado', () => {
    const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64')}`;
    for (const avatar of ['', 'https://ui-avatars.com/api/?name=A', jpeg]) assert.equal(validatePatient({ ...base, avatar }).ok, true, avatar.slice(0, 30));
    for (const avatar of ['javascript:alert(1)', 'http://x.com/a.png', 'data:image/svg+xml;base64,PHN2Zy8+', `https://x.com/${'a'.repeat(500)}`, 5]) {
      assert.equal(validatePatient({ ...base, avatar }).ok, false, String(avatar).slice(0, 30));
    }
  });

  it('so devolve campos do cadastro: id, versao, status e sinais nunca passam', () => {
    const result = validatePatient({ ...base, id: 'x', version: 9, status: 'critico', currentPain: 9, postOpDay: 99, careTeam: ['a'] });
    assert.deepEqual(Object.keys(result.values).sort(), ['age', 'avatar', 'cpf', 'dischargeDate', 'email', 'gender', 'hospital', 'name', 'phone', 'procedure', 'surgeryDate'].sort());
  });

  it('aceita clientId curto como chave de idempotencia', () => {
    assert.equal(validatePatient({ ...base, clientId: 'pat-abc' }).clientId, 'pat-abc');
    assert.equal(validatePatient({ ...base, clientId: 'a'.repeat(101) }).clientId, undefined);
  });

  it('corpo ausente nao quebra', () => {
    for (const input of [undefined, null, 'x', []]) assert.equal(validatePatient(input).ok, false);
  });
});

describe('validatePatient (editar, parcial)', () => {
  it('devolve so o que veio e ignora senha', () => {
    const result = validatePatient({ phone: '123', password: 'tentativa-x-123' }, { partial: true });
    assert.deepEqual(result, { ok: true, values: { phone: '123' }, password: undefined, clientId: undefined });
  });

  it('corpo sem campos validos e edicao vazia; campo presente e invalido recusa tudo', () => {
    assert.deepEqual(validatePatient({}, { partial: true }).values, {});
    assert.equal(validatePatient({ email: 'invalido' }, { partial: true }).ok, false);
    assert.equal(validatePatient({ name: '' }, { partial: true }).ok, false);
    assert.equal(validatePatient({ surgeryDate: 'ontem' }, { partial: true }).ok, false);
  });
});

describe('validatePassword', () => {
  it('aceita 8 a 128 caracteres e recusa o resto', () => {
    assert.deepEqual(validatePassword({ password: 'oito-ok!' }), { ok: true, password: 'oito-ok!' });
    for (const password of ['', 'curta', undefined, null, 12345678, 'x'.repeat(129)]) assert.equal(validatePassword({ password }).ok, false, String(password));
    assert.equal(validatePassword(undefined).ok, false);
  });
});

describe('validateCareTeam', () => {
  it('aceita lista de ids, inclusive vazia, e preserva a ordem (o primeiro e o cirurgiao)', () => {
    assert.deepEqual(validateCareTeam({ professionalIds: [] }), { ok: true, professionalIds: [] });
    assert.deepEqual(validateCareTeam({ professionalIds: ['prof-1', 'prof-9'] }), { ok: true, professionalIds: ['prof-1', 'prof-9'] });
  });

  it('recusa o que nao e lista de ids distintos, curtos e em numero razoavel', () => {
    for (const professionalIds of ['prof-1', undefined, null, [1], [''], ['a', 'a'], ['x'.repeat(101)], Array.from({ length: 21 }, (_, i) => `p${i}`)]) {
      assert.equal(validateCareTeam({ professionalIds }).ok, false, JSON.stringify(professionalIds)?.slice(0, 30));
    }
  });
});

describe('postOpDay', () => {
  const now = new Date('2026-11-26T15:00:00Z');
  it('conta os dias desde a cirurgia', () => {
    assert.equal(postOpDay('2026-11-26', now), 0);
    assert.equal(postOpDay('2026-11-25', now), 1);
    assert.equal(postOpDay('2026-11-01', now), 25);
  });
  it('data futura, vazia ou invalida vira 0', () => {
    for (const date of ['2026-12-31', '', 'ontem', undefined]) assert.equal(postOpDay(date, now), 0, String(date));
  });
});

describe('defaultAvatar', () => {
  it('usa o mesmo formato do front, com o nome codificado', () => {
    assert.equal(defaultAvatar('Ana Souza'), 'https://ui-avatars.com/api/?name=Ana%20Souza&background=E6F0FA&color=0B5CAB');
  });
});
