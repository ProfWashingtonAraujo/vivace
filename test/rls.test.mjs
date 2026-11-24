// Prova o controle de acesso por registro. Conecta como vivace_api, o papel que
// a aplicacao usa, porque policies nao se aplicam ao dono da tabela: testar com
// o dono nao provaria nada.
//
// Cada teste afirma a NEGACAO: nao basta ver que o admin enxerga tudo, e que o
// paciente alheio sumiu. Tambem exige a migracao e a importacao rodadas antes
// (npm run db:cluster && npm run db:migrate && npm run db:import).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asAdmin, createPool, withSession } from '../db/session.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pool = createPool();

// Usa o mesmo withSession do servidor, para o teste exercitar o caminho real
// de GUCs em vez de uma copia que pode divergir.
const run = (session, sql, params) => withSession(pool, session, client => client.query(sql, params));

const patient = userId => ({ role: 'patient', userId });
const professional = userId => ({ role: 'professional', userId });
const admin = { role: 'admin', userId: 'adm-1' };

const count = async (session, sql, params) => (await run(session, sql, params)).rows[0].total;

before(async () => {
  // Reimporta para o teste comecar de um estado conhecido.
  const importResult = spawnSync(process.execPath, [join(root, 'db', 'import-from-json.mjs'), '--force'], {
    cwd: root, encoding: 'utf8'
  });
  if (importResult.status !== 0) {
    throw new Error(`import falhou: ${importResult.stderr || importResult.stdout}`);
  }
  // Segundo profissional, so na equipe de pat-1, para testar isolamento entre
  // profissionais. O JSON so tem o prof-1.
  await asAdmin(pool, async client => {
    await client.query(
      `INSERT INTO professionals (id, name, job_title, crm_coren, avatar, email, specialty, position)
       VALUES ('prof-2', 'Helena Duarte', 'Cirurgia Plastica', 'CRM-SP 222.111', '', 'helena@vivace.med.br', 'Cirurgia Plastica', 1)
       ON CONFLICT (id) DO NOTHING`
    );
    await client.query(
      `INSERT INTO patient_care_team (patient_id, professional_id, role, position)
       VALUES ('pat-1', 'prof-2', 'equipe', 1) ON CONFLICT DO NOTHING`
    );
  });
});

after(async () => {
  await pool.end();
  // Os testes gravam de verdade (prof-2, check-in de teste, blood_pressure de
  // pat-3) para que a escrita negada seja exercitada de fato. Sem restaurar, o
  // gate de paridade passaria a falhar depois de npm test por causa do teste, e
  // nao por causa de dados. Reimportar devolve o estado de origem.
  const importResult = spawnSync(process.execPath, [join(root, 'db', 'import-from-json.mjs'), '--force'], {
    cwd: root, encoding: 'utf8'
  });
  if (importResult.status !== 0) {
    console.error(`falha ao restaurar o banco: ${importResult.stderr || importResult.stdout}`);
  }
});

describe('visibilidade por papel', () => {
  it('admin ve os 4 pacientes', async () => {
    assert.equal(await count(admin, 'SELECT count(*)::int AS total FROM patients'), 4);
  });

  it('paciente ve apenas o proprio registro', async () => {
    const rows = (await run(patient('pat-1'), 'SELECT id FROM patients ORDER BY id')).rows;
    assert.deepEqual(rows.map(row => row.id), ['pat-1']);
  });

  it('profissional da equipe ve os 3 pacientes sob sua responsabilidad e o orfao', async () => {
    const rows = (await run(professional('prof-1'), 'SELECT id FROM patients ORDER BY id')).rows;
    // pat-1, pat-3, pat-4 estao na equipe do prof-1; pat-2 nao tem equipe e
    // segue visivel, como antes das policies.
    assert.deepEqual(rows.map(row => row.id), ['pat-1', 'pat-2', 'pat-3', 'pat-4']);
  });

  it('profissional de outro hospital nao ve os pacientes alheios', async () => {
    const rows = (await run(professional('prof-2'), 'SELECT id FROM patients ORDER BY id')).rows;
    // pat-1 esta na equipe dele; pat-2 segue visivel por nao ter equipe.
    assert.deepEqual(rows.map(row => row.id), ['pat-1', 'pat-2']);
  });

  it('profissional ve apenas o proprio cadastro, e admin ve todos', async () => {
    const own = (await run(professional('prof-1'), 'SELECT id FROM professionals')).rows;
    assert.deepEqual(own.map(row => row.id), ['prof-1']);
    const all = (await run(admin, 'SELECT id FROM professionals ORDER BY id')).rows;
    assert.deepEqual(all.map(row => row.id), ['prof-1', 'prof-2']);
  });

  it('paciente nao ve cadastro de profissionais nem de admins', async () => {
    assert.equal(await count(patient('pat-1'), 'SELECT count(*)::int AS total FROM professionals'), 0);
    assert.equal(await count(patient('pat-1'), 'SELECT count(*)::int AS total FROM admins'), 0);
  });
});

describe('negacao em tabelas filhas', () => {
  it('paciente nao le check-ins de outro paciente', async () => {
    assert.equal(await count(patient('pat-1'), 'SELECT count(*)::int AS total FROM check_ins'), 5);
    assert.equal(await count(patient('pat-2'), 'SELECT count(*)::int AS total FROM check_ins'), 1);
  });

  it('profissional alheio nao le os check-ins de pat-3', async () => {
    // prof-2 ve pat-1 (5 check-ins) e pat-2 (1, sem equipe): 6. Nada de pat-3/pat-4.
    assert.equal(await count(professional('prof-2'), 'SELECT count(*)::int AS total FROM check_ins'), 6);
    assert.equal(await count(professional('prof-2'), 'SELECT count(*)::int AS total FROM check_ins WHERE patient_id = $1', ['pat-3']), 0);
    assert.equal(await count(professional('prof-1'), 'SELECT count(*)::int AS total FROM check_ins WHERE patient_id = $1', ['pat-3']), 1);
  });

  it('paciente nao le notas clinicas, nem as proprias', async () => {
    // pat-1 tem 1 nota clinica no JSON de origem.
    assert.equal(await count(admin, 'SELECT count(*)::int AS total FROM clinical_notes WHERE patient_id = $1', ['pat-1']), 1);
    assert.equal(await count(patient('pat-1'), 'SELECT count(*)::int AS total FROM clinical_notes'), 0);
  });

  it('paciente nao ve a equipe de outro paciente', async () => {
    assert.equal(await count(patient('pat-1'), 'SELECT count(*)::int AS total FROM patient_care_team'), 2);
    assert.equal(await count(patient('pat-2'), 'SELECT count(*)::int AS total FROM patient_care_team'), 0);
  });
});

describe('escrita negada', () => {
  it('paciente nao altera check-in de outro paciente', async () => {
    const before = await count(admin, 'SELECT temperature FROM check_ins WHERE patient_id = $1', ['pat-2']);
    const result = await run(patient('pat-1'), 'UPDATE check_ins SET temperature = 44.0 WHERE patient_id = $1', ['pat-2']);
    assert.equal(result.rowCount, 0);
    const after = await count(admin, 'SELECT temperature FROM check_ins WHERE patient_id = $1', ['pat-2']);
    assert.equal(after, before);
  });

  it('paciente nao apaga mensagens de outro paciente', async () => {
    const before = await count(admin, 'SELECT count(*)::int AS total FROM messages WHERE patient_id = $1', ['pat-2']);
    const result = await run(patient('pat-1'), 'DELETE FROM messages WHERE patient_id = $1', ['pat-2']);
    assert.equal(result.rowCount, 0);
    assert.equal(await count(admin, 'SELECT count(*)::int AS total FROM messages WHERE patient_id = $1', ['pat-2']), before);
  });

  it('paciente nao insere check-in em nome de outro', async () => {
    // INSERT que viola WITH CHECK levanta erro; rowCount 0 so acontece em
    // UPDATE e DELETE, que sao filtrados linha a linha.
    await assert.rejects(
      () => run(patient('pat-1'),
        `INSERT INTO check_ins (patient_id, id, position, date, day_label, pain_level, temperature, mobility_score, symptoms, notes, mood, photo_uploaded)
         VALUES ('pat-2', 'chk-tentativa', 0, '', 'D+0', 1, 36.5, 'repouso_absoluto', '{}', '', 'bem', false)`),
      error => error.code === '42501'
    );
    assert.equal(await count(admin, 'SELECT count(*)::int AS total FROM check_ins WHERE id = $1', ['chk-tentativa']), 0);
  });

  it('paciente nao insere nota clinica', async () => {
    await assert.rejects(
      () => run(patient('pat-1'),
        `INSERT INTO clinical_notes (patient_id, id, position, author, date, text)
         VALUES ('pat-1', 'cn-tentativa', 0, 'x', '', 'tentativa')`),
      error => error.code === '42501'
    );
    assert.equal(await count(admin, 'SELECT count(*)::int AS total FROM clinical_notes WHERE id = $1', ['cn-tentativa']), 0);
  });

  it('profissional nao se adiciona a equipe de paciente alheio', async () => {
    await assert.rejects(
      () => run(professional('prof-2'),
        `INSERT INTO patient_care_team (patient_id, professional_id, role, position)
         VALUES ('pat-3', 'prof-2', 'equipe', 2)`),
      error => error.code === '42501'
    );
    assert.equal(await count(admin, 'SELECT count(*)::int AS total FROM patient_care_team WHERE patient_id = $1', ['pat-3']), 1);
  });

  it('profissional nao cadastra nem apaga outro profissional', async () => {
    await assert.rejects(
      () => run(professional('prof-1'),
        `INSERT INTO professionals (id, name, job_title, crm_coren, avatar, email, specialty, position)
         VALUES ('prof-3', 'Intruso', '', '', '', 'intruso@x.com', '', 9)`),
      error => error.code === '42501'
    );
    const remove = await run(professional('prof-1'), 'DELETE FROM professionals WHERE id = $1', ['prof-2']);
    assert.equal(remove.rowCount, 0);
  });
});

describe('escrita permitida', () => {
  it('paciente registra check-in proprio', async () => {
    const inserted = await run(patient('pat-1'),
      `INSERT INTO check_ins (patient_id, id, position, date, day_label, pain_level, temperature, mobility_score, symptoms, notes, mood, photo_uploaded)
       VALUES ('pat-1', 'chk-teste-ok', 0, '30/09/2026', 'D+9', 2, 36.4, 'caminha_pouco', '{}', 'ok', 'bem', false)`);
    assert.equal(inserted.rowCount, 1);
    assert.equal(await count(admin, 'SELECT count(*)::int AS total FROM check_ins WHERE id = $1', ['chk-teste-ok']), 1);
    await run(admin, 'DELETE FROM check_ins WHERE id = $1', ['chk-teste-ok']);
  });

  it('profissional da equipe mexe no paciente dele', async () => {
    const result = await run(professional('prof-1'), 'UPDATE patients SET blood_pressure = $1 WHERE id = $2', ['120/80 mmHg', 'pat-3']);
    assert.equal(result.rowCount, 1);
  });
});

describe('falha fechada e hash de senha', () => {
  it('sem identidade nao ve nada', async () => {
    // Sem set_config de app.role, app_role_name() devolve NULL e tudo nega.
    assert.equal(await count({ role: '', userId: '' }, 'SELECT count(*)::int AS total FROM patients'), 0);
  });

  it('papel desconhecido nao ve nada', async () => {
    assert.equal(await count({ role: 'superusuario', userId: 'x' }, 'SELECT count(*)::int AS total FROM patients'), 0);
  });

  it('hash de senha fica fora do alcance da aplicacao', async () => {
    // O hash nao esta mais em patients: mora em account_credentials, onde
    // vivace_api nao tem privilegio algum. Um REVOKE de coluna por tabela nao
    // resolveria, porque privilegio de coluna no Postgres e aditivo e nao pode
    // ser mais restritivo que o de tabela.
    await assert.rejects(
      () => run(admin, 'SELECT password_hash FROM patients LIMIT 1'),
      error => error.code === '42703',
      'a coluna password_hash nao deveria existir em patients'
    );
    await assert.rejects(
      () => run(admin, 'SELECT * FROM account_credentials LIMIT 1'),
      error => error.code === '42501',
      'esperava permission denied em account_credentials'
    );
  });
  it('app_lookup_account acha a conta e devolve o hash', async () => {
    const byName = await run(admin, 'SELECT * FROM app_lookup_account($1)', ['Mariana Souza']);
    assert.equal(byName.rows[0].role, 'patient');
    assert.equal(byName.rows[0].user_id, 'pat-1');
    assert.match(byName.rows[0].password_hash, /^scrypt\$/);

    const byPrefix = await run(admin, 'SELECT * FROM app_lookup_account($1)', ['mariana']);
    assert.equal(byPrefix.rows[0].user_id, 'pat-1');

    const byEmail = await run(admin, 'SELECT * FROM app_lookup_account($1)', ['admin@vivace.med.br']);
    assert.equal(byEmail.rows[0].role, 'admin');

    const unknown = await run(admin, 'SELECT * FROM app_lookup_account($1)', ['nao-existe']);
    assert.equal(unknown.rows.length, 0);
  });

  it('app_lookup_account ignora acento e caixa', async () => {
    const rows = (await run(admin, 'SELECT * FROM app_lookup_account($1)', ['rafAely carvalho'])).rows;
    assert.equal(rows[0].user_id, 'prof-1');
  });
});
