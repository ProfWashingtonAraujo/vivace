import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseIfMatch, validateInstruction, validateMedication } from '../lib/catalog.mjs';

describe('parseIfMatch', () => {
  it('le a versao em numero puro, entre aspas e como etag fraco', () => {
    assert.deepEqual(parseIfMatch('3'), { ok: true, version: 3 });
    assert.deepEqual(parseIfMatch('"3"'), { ok: true, version: 3 });
    assert.deepEqual(parseIfMatch('W/"3"'), { ok: true, version: 3 });
    assert.deepEqual(parseIfMatch('  7  '), { ok: true, version: 7 });
  });

  it('ausente ou vazio e "faltando" (a chamada exige a precondicao)', () => {
    assert.deepEqual(parseIfMatch(undefined), { ok: false, reason: 'missing' });
    assert.deepEqual(parseIfMatch(''), { ok: false, reason: 'missing' });
    assert.deepEqual(parseIfMatch('   '), { ok: false, reason: 'missing' });
  });

  it('o que nao e inteiro positivo e "invalido", inclusive o curinga *', () => {
    for (const header of ['abc', '1.5', '-1', '0', '*', '1,2', '3abc', '99999999999']) {
      assert.deepEqual(parseIfMatch(header), { ok: false, reason: 'invalid' }, header);
    }
  });
});

const baseMedication = { name: 'Dipirona', dose: '500mg', frequency: '6/6h', purpose: 'Dor', instructions: 'Apos a refeicao', times: ['06:00', '12:00'] };

describe('validateMedication (criar)', () => {
  it('aceita uma medicacao completa e apara os textos', () => {
    const result = validateMedication({ ...baseMedication, name: '  Dipirona  ' });
    assert.equal(result.ok, true);
    assert.equal(result.values.name, 'Dipirona');
    assert.deepEqual(result.values.times, ['06:00', '12:00']);
  });

  it('dose, frequencia, finalidade e instrucoes sao opcionais e viram texto vazio', () => {
    const result = validateMedication({ name: 'X', times: ['08:00'] });
    assert.equal(result.ok, true);
    assert.deepEqual(
      [result.values.dose, result.values.frequency, result.values.purpose, result.values.instructions],
      ['', '', '', '']
    );
  });

  it('exige nome e ao menos um horario', () => {
    assert.equal(validateMedication({ ...baseMedication, name: '' }).ok, false);
    assert.equal(validateMedication({ ...baseMedication, name: '   ' }).ok, false);
    assert.equal(validateMedication({ ...baseMedication, times: [] }).ok, false);
    assert.equal(validateMedication({ name: 'X' }).ok, false);
  });

  it('recusa tipos errados e tamanhos acima do limite', () => {
    for (const over of [
      { name: 42 }, { name: 'x'.repeat(101) }, { dose: 7 }, { dose: 'x'.repeat(101) }, { frequency: 'x'.repeat(101) },
      { purpose: 'x'.repeat(201) }, { instructions: 'x'.repeat(501) }, { times: 'nao-e-lista' }, { times: [6] }
    ]) {
      assert.equal(validateMedication({ ...baseMedication, ...over }).ok, false, JSON.stringify(over).slice(0, 50));
    }
  });

  it('horarios: formato HH:MM de 00:00 a 23:59, sem repetir, no maximo 12', () => {
    for (const times of [['25:00'], ['8:00'], ['08:60'], ['08:00', '08:00'], ['ab:cd'], Array.from({ length: 13 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`)]) {
      assert.equal(validateMedication({ ...baseMedication, times }).ok, false, JSON.stringify(times).slice(0, 40));
    }
    assert.equal(validateMedication({ ...baseMedication, times: ['00:00', '23:59'] }).ok, true);
    assert.equal(validateMedication({ ...baseMedication, times: Array.from({ length: 12 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`) }).ok, true);
  });

  it('so devolve campos da medicacao: id, versao e outros nunca passam por aqui', () => {
    const result = validateMedication({ ...baseMedication, id: 'med-forjado', version: 50, takenToday: { '06:00': true } });
    assert.deepEqual(Object.keys(result.values).sort(), ['dose', 'frequency', 'instructions', 'name', 'purpose', 'times']);
  });

  it('aceita clientId curto como chave de idempotencia e ignora o invalido', () => {
    assert.equal(validateMedication({ ...baseMedication, clientId: 'med-abc' }).clientId, 'med-abc');
    assert.equal(validateMedication({ ...baseMedication, clientId: 7 }).clientId, undefined);
    assert.equal(validateMedication({ ...baseMedication, clientId: 'a'.repeat(101) }).clientId, undefined);
  });

  it('corpo ausente nao quebra', () => {
    assert.equal(validateMedication(undefined).ok, false);
    assert.equal(validateMedication(null).ok, false);
    assert.equal(validateMedication('x').ok, false);
  });
});

describe('validateMedication (editar, parcial)', () => {
  it('devolve so os campos que vieram', () => {
    const result = validateMedication({ dose: '1g' }, { partial: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.values, { dose: '1g' });
  });

  it('um corpo sem campos validos e uma edicao vazia, nao um erro', () => {
    assert.deepEqual(validateMedication({}, { partial: true }), { ok: true, values: {}, clientId: undefined });
    assert.deepEqual(validateMedication({ id: 'x', version: 9 }, { partial: true }).values, {});
  });

  it('um campo presente e invalido recusa a edicao inteira', () => {
    assert.equal(validateMedication({ dose: 7 }, { partial: true }).ok, false);
    assert.equal(validateMedication({ name: '' }, { partial: true }).ok, false);
    assert.equal(validateMedication({ times: [] }, { partial: true }).ok, false);
    assert.equal(validateMedication({ times: ['99:99'] }, { partial: true }).ok, false);
  });

  it('aceita trocar os horarios', () => {
    assert.deepEqual(validateMedication({ times: ['06:00', '09:00'] }, { partial: true }).values, { times: ['06:00', '09:00'] });
  });
});

const baseInstruction = { category: 'curativo', title: 'Trocar o curativo', content: 'Uma vez ao dia.', important: false };

describe('validateInstruction', () => {
  it('aceita uma instrucao completa', () => {
    const result = validateInstruction(baseInstruction);
    assert.equal(result.ok, true);
    assert.deepEqual(result.values, { category: 'curativo', title: 'Trocar o curativo', content: 'Uma vez ao dia.', important: false });
  });

  it('as seis categorias do front sao validas e as outras nao', () => {
    for (const category of ['curativo', 'alimentacao', 'atividade', 'higiene', 'alerta', 'medicacao']) {
      assert.equal(validateInstruction({ ...baseInstruction, category }).ok, true, category);
    }
    for (const category of ['inventada', '', undefined, 3]) {
      assert.equal(validateInstruction({ ...baseInstruction, category }).ok, false, String(category));
    }
  });

  it('exige titulo; conteudo e importante tem padrao', () => {
    assert.equal(validateInstruction({ ...baseInstruction, title: '' }).ok, false);
    const result = validateInstruction({ category: 'alerta', title: 'T' });
    assert.equal(result.ok, true);
    assert.equal(result.values.content, '');
    assert.equal(result.values.important, false);
  });

  it('recusa tamanhos acima do limite e tipos errados', () => {
    for (const over of [{ title: 'x'.repeat(121) }, { content: 'x'.repeat(2_001) }, { important: 'sim' }, { iconName: 'x'.repeat(51) }, { iconName: 4 }]) {
      assert.equal(validateInstruction({ ...baseInstruction, ...over }).ok, false, JSON.stringify(over).slice(0, 40));
    }
  });

  it('iconName so aparece quando vem, e id e versao nunca passam', () => {
    assert.equal('iconName' in validateInstruction(baseInstruction).values, false);
    assert.equal(validateInstruction({ ...baseInstruction, iconName: 'bandage' }).values.iconName, 'bandage');
    assert.equal('id' in validateInstruction({ ...baseInstruction, id: 'x', version: 9 }).values, false);
  });

  it('parcial: so o que veio, e campo invalido presente recusa', () => {
    assert.deepEqual(validateInstruction({ content: 'novo' }, { partial: true }).values, { content: 'novo' });
    assert.equal(validateInstruction({ category: 'inventada' }, { partial: true }).ok, false);
    assert.equal(validateInstruction({ title: '' }, { partial: true }).ok, false);
    assert.deepEqual(validateInstruction({}, { partial: true }), { ok: true, values: {}, clientId: undefined });
  });
});
