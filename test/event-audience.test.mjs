import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldDeliver } from '../lib/event-audience.mjs';

const event = { type: 'message.created', patientId: 'pat-1' };
const team = { everyone: false, professionalIds: ['prof-1'] };
const noTeam = { everyone: true, professionalIds: [] };

describe('shouldDeliver', () => {
  it('o proprio paciente recebe', () => {
    assert.equal(shouldDeliver({ role: 'patient', userId: 'pat-1' }, event, team), true);
  });

  it('outro paciente nao recebe', () => {
    assert.equal(shouldDeliver({ role: 'patient', userId: 'pat-2' }, event, team), false);
  });

  it('profissional da equipe recebe', () => {
    assert.equal(shouldDeliver({ role: 'professional', userId: 'prof-1' }, event, team), true);
  });

  it('profissional fora da equipe nao recebe', () => {
    assert.equal(shouldDeliver({ role: 'professional', userId: 'prof-9' }, event, team), false);
  });

  it('paciente sem equipe e visivel a qualquer profissional, como no RLS', () => {
    assert.equal(shouldDeliver({ role: 'professional', userId: 'prof-9' }, event, noTeam), true);
  });

  it('admin recebe tudo', () => {
    assert.equal(shouldDeliver({ role: 'admin', userId: 'adm-1' }, event, team), true);
  });

  it('sem publico conhecido, so o paciente dono e o admin recebem (falha fechada)', () => {
    assert.equal(shouldDeliver({ role: 'professional', userId: 'prof-1' }, event, null), false);
    assert.equal(shouldDeliver({ role: 'patient', userId: 'pat-1' }, event, null), true);
    assert.equal(shouldDeliver({ role: 'admin', userId: 'adm-1' }, event, null), true);
  });

  it('evento sem patientId nao vai para profissional nem paciente', () => {
    const orphan = { type: 'x' };
    assert.equal(shouldDeliver({ role: 'professional', userId: 'prof-1' }, orphan, team), false);
    assert.equal(shouldDeliver({ role: 'patient', userId: 'pat-1' }, orphan, team), false);
  });

  it('papel desconhecido nao recebe', () => {
    assert.equal(shouldDeliver({ role: 'visitante', userId: 'x' }, event, team), false);
  });
});
