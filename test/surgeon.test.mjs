import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayedSurgeon } from '../lib/surgeon.mjs';

const rafaely = { role: 'cirurgiao', name: 'Rafaely Carvalho', crm_coren: 'CRM-SP 148.920' };
const helena = { role: 'equipe', name: 'Helena Duarte', crm_coren: 'CRM-SP 222.111' };
const label = 'Dr. Marcos Albuquerque (CRM-SP 120.440)';

describe('displayedSurgeon', () => {
  it('o cirurgiao da equipe vence, com o nome atual do cadastro', () => {
    assert.equal(displayedSurgeon([helena, rafaely], label), 'Rafaely Carvalho (CRM-SP 148.920)');
  });

  it('sem cirurgiao na equipe, o rotulo guardado continua valendo (e o caso do pat-2: so ha membros "equipe")', () => {
    assert.equal(displayedSurgeon([helena], label), label);
  });

  it('sem equipe, o rotulo guardado', () => {
    assert.equal(displayedSurgeon([], label), label);
  });

  it('sem cirurgiao e sem rotulo, o primeiro membro da equipe', () => {
    assert.equal(displayedSurgeon([helena], ''), 'Helena Duarte (CRM-SP 222.111)');
  });

  it('sem equipe e sem rotulo, texto vazio', () => {
    assert.equal(displayedSurgeon([], ''), '');
    assert.equal(displayedSurgeon([], undefined), '');
  });
});
