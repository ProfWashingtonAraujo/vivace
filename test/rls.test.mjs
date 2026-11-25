// Prova o controle de acesso por registro. Conecta como vivace_api, o papel que
// a aplicacao usa, porque policies nao se aplicam ao dono da tabela: testar com
// o dono nao provaria nada.
//
// Cada teste afirma a NEGACAO: nao basta ver que o admin enxerga tudo, e que o
// paciente alheio sumiu. Tambem exige a migracao e a importacao rodadas antes
// (npm run db:cluster && npm run db:migrate && npm run db:import).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asAdmin, createPool, withSession } from '../db/session.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pool = createPool();

// As contagens esperadas vêm do mesmo arquivo que alimentou o banco, e não de números
// escritos aqui: o arquivo de desenvolvimento de cada pessoa tem mais check-ins e notas
// do que o seed do repositório, e um número fixo só passaria numa dessas bases.
const importFile = process.env.VIVACE_IMPORT_FILE ?? join(root, '.data', 'vivace-state.json');
const sizeOf = (patientId, collection) =>
  JSON.parse(readFileSync(importFile, 'utf8')).patients.find(item => item.id === patientId)[collection].length;

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
    assert.equal(await count(patient('pat-1'), 'SELECT count(*)::int AS total FROM check_ins'), sizeOf('pat-1', 'checkIns'));
    assert.equal(await count(patient('pat-2'), 'SELECT count(*)::int AS total FROM check_ins'), sizeOf('pat-2', 'checkIns'));
  });

  it('profissional alheio nao le os check-ins de pat-3', async () => {
    // prof-2 ve pat-1 e pat-2 (este sem equipe). Nada de pat-3/pat-4.
    assert.equal(await count(professional('prof-2'), 'SELECT count(*)::int AS total FROM check_ins'),
      sizeOf('pat-1', 'checkIns') + sizeOf('pat-2', 'checkIns'));
    assert.equal(await count(professional('prof-2'), 'SELECT count(*)::int AS total FROM check_ins WHERE patient_id = $1', ['pat-3']), 0);
    assert.equal(await count(professional('prof-1'), 'SELECT count(*)::int AS total FROM check_ins WHERE patient_id = $1', ['pat-3']), sizeOf('pat-3', 'checkIns'));
  });

  it('paciente nao le notas clinicas, nem as proprias', async () => {
    // As notas clinicas de pat-1 vem do arquivo de origem.
    assert.equal(await count(admin, 'SELECT count(*)::int AS total FROM clinical_notes WHERE patient_id = $1', ['pat-1']), sizeOf('pat-1', 'clinicalNotes'));
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

// ---------------------------------------------------------------------------
// Achados I1 e I9 da revisao: o RLS nao pode dar escrita ampla ao papel de
// paciente, e ninguem alem do admin pode deixar um paciente sem equipe.

// Uma escrita negada pode aparecer de dois jeitos: erro 42501 (INSERT que viola
// WITH CHECK, ou o guarda de colunas) ou zero linhas afetadas (UPDATE e DELETE
// sao filtrados linha a linha pela policy). Os dois bloqueiam; o que nao pode
// acontecer e a escrita passar.
const blocked = async (session, sql, params) => {
  try {
    return (await run(session, sql, params)).rowCount === 0;
  } catch (error) {
    return error.code === '42501';
  }
};

describe('I1: o paciente nao escreve alem do que lhe cabe', () => {
  it('nao altera, cria nem apaga a propria prescricao', async () => {
    assert.ok(await blocked(patient('pat-1'), "UPDATE medications SET name = 'alterado', dose = '999mg' WHERE patient_id = 'pat-1'"));
    assert.ok(await blocked(patient('pat-1'),
      `INSERT INTO medications (patient_id, id, position, name) VALUES ('pat-1', 'med-forjada', 99, 'Opioide')`));
    assert.ok(await blocked(patient('pat-1'), "DELETE FROM medications WHERE patient_id = 'pat-1'"));
    assert.equal(await count(admin, "SELECT count(*)::int AS total FROM medications WHERE name = 'alterado' OR id = 'med-forjada'"), 0);
    assert.ok(await count(admin, "SELECT count(*)::int AS total FROM medications WHERE patient_id = 'pat-1'") > 0, 'a prescricao foi apagada');
  });

  it('nao escreve nas instrucoes nem nos horarios dos medicamentos', async () => {
    assert.ok(await blocked(patient('pat-1'), "UPDATE instructions SET content = 'x' WHERE patient_id = 'pat-1'"));
    assert.ok(await blocked(patient('pat-1'), "DELETE FROM medication_times WHERE patient_id = 'pat-1'"));
  });

  it('nao forja mensagem da equipe, mas manda a propria', async () => {
    assert.ok(await blocked(patient('pat-1'),
      `INSERT INTO messages (patient_id, id, position, sender, sender_name, timestamp, text, is_read)
       VALUES ('pat-1', 'msg-forjada', 99, 'equipe', 'Dra. Falsa', '10:00', 'conduta alterada', false)`));
    assert.equal(await count(admin, "SELECT count(*)::int AS total FROM messages WHERE id = 'msg-forjada'"), 0);

    const own = await run(patient('pat-1'),
      `INSERT INTO messages (patient_id, id, position, sender, sender_name, timestamp, text, is_read)
       VALUES ('pat-1', 'msg-propria-i1', 98, 'paciente', 'Mariana Souza', '10:01', 'ola', false)`);
    assert.equal(own.rowCount, 1);
    await run(admin, "DELETE FROM messages WHERE id = 'msg-propria-i1'");
  });

  it('nao reescreve nem apaga mensagens ja enviadas', async () => {
    assert.ok(await blocked(patient('pat-1'), "UPDATE messages SET text = 'editado', sender = 'equipe' WHERE patient_id = 'pat-1'"));
    assert.ok(await blocked(patient('pat-1'), "DELETE FROM messages WHERE patient_id = 'pat-1'"));
    assert.equal(await count(admin, "SELECT count(*)::int AS total FROM messages WHERE text = 'editado'"), 0);
  });

  it('nao muda o resultado da avaliacao de uma foto, nem a envia ja aprovada', async () => {
    assert.ok(await blocked(patient('pat-1'),
      "UPDATE wound_photos SET review_status = 'avaliado_adequado', reviewed_by = 'Dr. Falso' WHERE patient_id = 'pat-1'"));
    assert.equal(await count(admin, "SELECT count(*)::int AS total FROM wound_photos WHERE reviewed_by = 'Dr. Falso'"), 0);
    assert.ok(await blocked(patient('pat-1'),
      `INSERT INTO wound_photos (patient_id, id, position, date, day_label, image_source_url, patient_notes, review_status, review_feedback, reviewed_by, reviewed_at)
       VALUES ('pat-1', 'wp-forjada', 0, '', 'D+1', 'x', '', 'avaliado_adequado', '', 'Dr. Falso', '')`));
    assert.equal(await count(admin, "SELECT count(*)::int AS total FROM wound_photos WHERE id = 'wp-forjada'"), 0);
  });

  it('envia foto pendente e reordena as proprias fotos (o fluxo do check-in)', async () => {
    const shifted = await run(patient('pat-1'), "UPDATE wound_photos SET position = position + 1 WHERE patient_id = 'pat-1'");
    assert.ok(shifted.rowCount >= 0);
    const inserted = await run(patient('pat-1'),
      `INSERT INTO wound_photos (patient_id, id, position, date, day_label, image_source_url, patient_notes, review_status, review_feedback, reviewed_by, reviewed_at)
       VALUES ('pat-1', 'wp-i1-ok', 0, '', 'D+1', 'x', 'minha foto', 'pendente', '', '', '')`);
    assert.equal(inserted.rowCount, 1);
    await run(admin, "DELETE FROM wound_photos WHERE id = 'wp-i1-ok'");
  });

  it('nao forja evento da equipe na linha do tempo, mas registra o proprio check-in', async () => {
    assert.ok(await blocked(patient('pat-1'),
      `INSERT INTO timeline_events (patient_id, id, position, date, day_label, title, description, author, type)
       VALUES ('pat-1', 'tl-forjado', 99, '', 'D+1', 'Prescricao alterada', 'x', 'Dr. Falso', 'prescricao')`));
    assert.ok(await blocked(patient('pat-1'),
      `INSERT INTO timeline_events (patient_id, id, position, date, day_label, title, description, author, type)
       VALUES ('pat-1', 'tl-forjado-2', 99, '', 'D+1', 'x', 'x', 'Dr. Falso', 'checkin')`));
    assert.equal(await count(admin, "SELECT count(*)::int AS total FROM timeline_events WHERE id LIKE 'tl-forjado%'"), 0);

    const own = await run(patient('pat-1'),
      `INSERT INTO timeline_events (patient_id, id, position, date, day_label, title, description, author, type)
       VALUES ('pat-1', 'tl-i1-ok', 99, '', 'D+1', 'Check-in', 'x', 'Mariana Souza (Paciente)', 'checkin')`);
    assert.equal(own.rowCount, 1);
    await run(admin, "DELETE FROM timeline_events WHERE id = 'tl-i1-ok'");
  });

  it('nao altera os proprios dados cadastrais (identidade, contato, procedimento)', async () => {
    // allergies e text[]: atribuir um texto simples daria erro de sintaxe de array (22P02),
    // que nao e um bloqueio de RLS, entao o valor precisa ser um array de verdade.
    for (const change of [
      "email = 'tomada@x.com'", "name = 'Outro Nome'", "cpf = '000.000.000-00'", "phone = '(00) 0'",
      "procedure = 'outro'", "allergies = ARRAY['alergia-alterada-i1']", "hospital = 'outro'", "surgeon_label = 'Dr. Falso'"
    ]) {
      assert.ok(await blocked(patient('pat-1'), `UPDATE patients SET ${change} WHERE id = 'pat-1'`), `alterou ${change}`);
    }
    assert.equal(await count(admin, "SELECT count(*)::int AS total FROM patients WHERE email = 'tomada@x.com' OR name = 'Outro Nome'"), 0);
  });

  it('atualiza os sinais do proprio check-in (o fluxo do check-in)', async () => {
    const result = await run(patient('pat-1'),
      `UPDATE patients SET current_pain = 3, current_temp = 36.6, last_check_in_time = 'Hoje', status = 'estavel',
         wound_review_pending = true, medication_adherence_percent = 90 WHERE id = 'pat-1'`);
    assert.equal(result.rowCount, 1);
  });

  it('confirma doses (inclui virar a confirmacao), mas nao muda a que dose pertence', async () => {
    const dose = (await run(admin, "SELECT medication_id, time FROM medication_doses WHERE patient_id = 'pat-1' LIMIT 1")).rows[0];
    const med = dose ?? (await run(admin,
      "SELECT m.id AS medication_id, t.time FROM medications m JOIN medication_times t ON t.patient_id = m.patient_id AND t.medication_id = m.id WHERE m.patient_id = 'pat-1' LIMIT 1")).rows[0];
    assert.ok(med, 'sem dose para testar');
    const toggled = await run(patient('pat-1'),
      `INSERT INTO medication_doses (patient_id, medication_id, time, taken) VALUES ('pat-1', $1, $2, true)
       ON CONFLICT (patient_id, medication_id, time) DO UPDATE SET taken = NOT medication_doses.taken`, [med.medication_id, med.time]);
    assert.equal(toggled.rowCount, 1);
    assert.ok(await blocked(patient('pat-1'),
      "UPDATE medication_doses SET time = 'qualquer' WHERE patient_id = 'pat-1'"));
    assert.ok(await blocked(patient('pat-1'), "DELETE FROM medication_doses WHERE patient_id = 'pat-1'"));
  });

  it('nao toca nos dados de outro paciente', async () => {
    assert.ok(await blocked(patient('pat-1'), "UPDATE patients SET current_pain = 9 WHERE id = 'pat-3'"));
    assert.ok(await blocked(patient('pat-1'), "UPDATE check_ins SET pain_level = 0 WHERE patient_id = 'pat-3'"));
  });

  it('a equipe continua escrevendo normalmente', async () => {
    const medication = await run(professional('prof-1'), "UPDATE medications SET instructions = 'tomar apos o cafe' WHERE patient_id = 'pat-3'");
    assert.ok(medication.rowCount >= 1);
    const message = await run(professional('prof-1'),
      `INSERT INTO messages (patient_id, id, position, sender, sender_name, timestamp, text, is_read)
       VALUES ('pat-3', 'msg-equipe-i1', 99, 'equipe', 'Rafaely Carvalho', '10:00', 'ola', false)`);
    assert.equal(message.rowCount, 1);
    const review = await run(professional('prof-1'), "UPDATE wound_photos SET review_feedback = 'ok' WHERE patient_id = 'pat-3'");
    assert.ok(review.rowCount >= 0);
    await run(admin, "DELETE FROM messages WHERE id = 'msg-equipe-i1'");
    const adminWrite = await run(admin, "UPDATE patients SET blood_pressure = '110/70 mmHg' WHERE id = 'pat-3'");
    assert.equal(adminWrite.rowCount, 1);
  });
});

describe('I9: a equipe do paciente nao se esvazia por baixo', () => {
  it('profissional nao tira um colega da equipe', async () => {
    assert.ok(await blocked(professional('prof-1'),
      "DELETE FROM patient_care_team WHERE patient_id = 'pat-1' AND professional_id = 'prof-2'"));
    assert.equal(await count(admin, "SELECT count(*)::int AS total FROM patient_care_team WHERE patient_id = 'pat-1' AND professional_id = 'prof-2'"), 1);
  });

  it('profissional nao deixa o paciente sem equipe saindo dela', async () => {
    // pat-3 so tem o prof-1. Sair deixaria o paciente sem equipe, e sem equipe ele
    // fica visivel a qualquer profissional.
    assert.ok(await blocked(professional('prof-1'),
      "DELETE FROM patient_care_team WHERE patient_id = 'pat-3' AND professional_id = 'prof-1'"));
    assert.equal(await count(admin, "SELECT count(*)::int AS total FROM patient_care_team WHERE patient_id = 'pat-3'"), 1);
  });

  it('profissional pode sair quando a equipe continua com alguem', async () => {
    const left = await run(professional('prof-2'),
      "DELETE FROM patient_care_team WHERE patient_id = 'pat-1' AND professional_id = 'prof-2'");
    assert.equal(left.rowCount, 1);
    assert.equal(await count(admin, "SELECT count(*)::int AS total FROM patient_care_team WHERE patient_id = 'pat-1'"), 1);
    await run(admin,
      `INSERT INTO patient_care_team (patient_id, professional_id, role, position)
       VALUES ('pat-1', 'prof-2', 'equipe', 1) ON CONFLICT DO NOTHING`);
  });

  it('o admin pode esvaziar uma equipe (decisao administrativa)', async () => {
    const removed = await run(admin, "DELETE FROM patient_care_team WHERE patient_id = 'pat-4'");
    assert.ok(removed.rowCount >= 1);
    await run(admin,
      `INSERT INTO patient_care_team (patient_id, professional_id, role, position)
       VALUES ('pat-4', 'prof-1', 'cirurgiao', 0) ON CONFLICT DO NOTHING`);
    assert.equal(await count(admin, "SELECT count(*)::int AS total FROM patient_care_team WHERE patient_id = 'pat-4'"), 1);
  });

  it('apagar o paciente leva a equipe junto, sem o guarda atrapalhar', async () => {
    await run(admin,
      `INSERT INTO patients SELECT (jsonb_populate_record(NULL::patients, to_jsonb(p) || '{"id":"pat-tmp-i9","email":"tmp-i9@x.com","name":"Temporario I9"}'::jsonb)).*
         FROM patients p WHERE p.id = 'pat-3'`);
    await run(admin,
      `INSERT INTO patient_care_team (patient_id, professional_id, role, position) VALUES ('pat-tmp-i9', 'prof-1', 'cirurgiao', 0)`);
    const removed = await run(professional('prof-1'), "DELETE FROM patients WHERE id = 'pat-tmp-i9'");
    assert.equal(removed.rowCount, 1);
    assert.equal(await count(admin, "SELECT count(*)::int AS total FROM patient_care_team WHERE patient_id = 'pat-tmp-i9'"), 0);
  });
});
