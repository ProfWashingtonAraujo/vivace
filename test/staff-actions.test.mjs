import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { brDateTime } from '../lib/br-time.mjs';
import { validateNote, validateReview, reviewTimelineTitle } from '../lib/staff-actions.mjs';
import { shouldDeliver } from '../lib/event-audience.mjs';

describe('brDateTime', () => {
  it('formata data e hora no fuso de Sao Paulo, como o front (dd/mm/aaaa e hh:mm)', () => {
    // 14:05 UTC = 11:05 em Sao Paulo (UTC-3).
    assert.deepEqual(brDateTime(new Date('2026-11-25T14:05:00Z')), { date: '25/11/2026', time: '11:05' });
  });

  it('a data segue o dia local, nao o do UTC', () => {
    // 01:30 UTC de 26/11 ainda e 22:30 de 25/11 em Sao Paulo.
    assert.deepEqual(brDateTime(new Date('2026-11-26T01:30:00Z')), { date: '25/11/2026', time: '22:30' });
  });

  it('completa com zero (dia, mes, hora e minuto)', () => {
    assert.deepEqual(brDateTime(new Date('2026-03-04T12:07:00Z')), { date: '04/03/2026', time: '09:07' });
  });
});

describe('validateNote', () => {
  it('aceita um texto e o apara', () => {
    assert.deepEqual(validateNote({ text: '  evoluindo bem  ' }), { ok: true, text: 'evoluindo bem', clientId: undefined });
  });

  it('aceita um clientId curto como chave de idempotencia', () => {
    assert.equal(validateNote({ text: 'x', clientId: 'cn-abc' }).clientId, 'cn-abc');
  });

  it('recusa texto vazio, so espacos, que nao e string ou acima de 2000', () => {
    for (const text of ['', '   ', 42, null, undefined, {}, 'x'.repeat(2_001)]) {
      assert.equal(validateNote({ text }).ok, false, `deveria recusar ${JSON.stringify(text)?.slice(0, 20)}`);
    }
    assert.equal(validateNote({ text: 'x'.repeat(2_000) }).ok, true);
  });

  it('ignora clientId que nao e texto curto', () => {
    assert.equal(validateNote({ text: 'x', clientId: 7 }).clientId, undefined);
    assert.equal(validateNote({ text: 'x', clientId: 'a'.repeat(101) }).clientId, undefined);
  });

  it('corpo ausente ou nao-objeto nao quebra', () => {
    assert.equal(validateNote(undefined).ok, false);
    assert.equal(validateNote(null).ok, false);
    assert.equal(validateNote('texto').ok, false);
  });

  it('so devolve o que a nota usa: autor e data nunca passam por aqui', () => {
    const result = validateNote({ text: 'x', author: 'Dra. Falsa', date: '01/01/2000' });
    assert.deepEqual(Object.keys(result).sort(), ['clientId', 'ok', 'text']);
  });
});

describe('validateReview', () => {
  it('aceita os dois vereditos validos', () => {
    assert.equal(validateReview({ status: 'avaliado_adequado', feedback: 'ok' }).ok, true);
    assert.equal(validateReview({ status: 'requer_atencao', feedback: 'vermelhidao' }).ok, true);
  });

  it('recusa pendente, valores desconhecidos e tipos errados', () => {
    for (const status of ['pendente', 'aprovada', '', undefined, null, 7, {}]) {
      assert.equal(validateReview({ status, feedback: 'x' }).ok, false, `deveria recusar ${JSON.stringify(status)}`);
    }
  });

  it('o comentario e opcional, e apara espacos', () => {
    assert.equal(validateReview({ status: 'avaliado_adequado' }).feedback, '');
    assert.equal(validateReview({ status: 'avaliado_adequado', feedback: '  bom  ' }).feedback, 'bom');
  });

  it('recusa comentario acima de 1000 caracteres ou que nao e texto', () => {
    assert.equal(validateReview({ status: 'avaliado_adequado', feedback: 'x'.repeat(1_001) }).ok, false);
    assert.equal(validateReview({ status: 'avaliado_adequado', feedback: 12 }).ok, false);
    assert.equal(validateReview({ status: 'avaliado_adequado', feedback: 'x'.repeat(1_000) }).ok, true);
  });

  it('so devolve veredito e comentario: revisor e data nunca passam por aqui', () => {
    const result = validateReview({ status: 'avaliado_adequado', feedback: 'x', reviewedBy: 'Dr. Falso', reviewedAt: '01/01/2000' });
    assert.deepEqual(Object.keys(result).sort(), ['feedback', 'ok', 'status']);
  });

  it('corpo ausente nao quebra', () => {
    assert.equal(validateReview(undefined).ok, false);
    assert.equal(validateReview(null).ok, false);
  });
});

describe('reviewTimelineTitle', () => {
  it('usa os mesmos titulos que o front usava', () => {
    assert.equal(reviewTimelineTitle('avaliado_adequado'), 'Cicatrização aprovada');
    assert.equal(reviewTimelineTitle('requer_atencao'), 'Ferida requer atenção');
  });
});

describe('shouldDeliver com eventos so da equipe', () => {
  const staffOnly = { type: 'clinical-note.created', patientId: 'pat-1', staffOnly: true };
  const team = { everyone: false, professionalIds: ['prof-1'] };

  it('o paciente dono do registro NAO recebe', () => {
    assert.equal(shouldDeliver({ role: 'patient', userId: 'pat-1' }, staffOnly, team), false);
  });

  it('a equipe e o admin recebem', () => {
    assert.equal(shouldDeliver({ role: 'professional', userId: 'prof-1' }, staffOnly, team), true);
    assert.equal(shouldDeliver({ role: 'admin', userId: 'adm-1' }, staffOnly, team), true);
  });

  it('profissional fora da equipe continua sem receber', () => {
    assert.equal(shouldDeliver({ role: 'professional', userId: 'prof-9' }, staffOnly, team), false);
  });

  it('evento comum continua indo ao paciente dono', () => {
    assert.equal(shouldDeliver({ role: 'patient', userId: 'pat-1' }, { type: 'wound-photo.reviewed', patientId: 'pat-1' }, team), true);
  });
});
