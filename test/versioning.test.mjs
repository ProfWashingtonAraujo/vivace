// Fase 1 do plano de escritas granulares: as entidades que a equipe edita
// (pacientes, medicações, instruções e profissionais) ganham um número de versão,
// que só sobe quando o CONTEÚDO muda. É o que permitirá, na fase 2, recusar com 409
// uma edição feita sobre uma versão velha.
//
// A parte delicada é o "só quando o conteúdo muda": o PUT regrava todas as linhas a
// cada salvamento com os mesmos valores, e a posição é reescrita a cada vez. Se isso
// subisse a versão, toda edição legítima bateria num conflito.
//
// Precisa de banco (npm run db:cluster && npm run db:migrate) e do arquivo de import.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAggregate } from '../db/aggregate.mjs';
import { createPool, withSession } from '../db/session.mjs';
import { putState } from '../db/store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pool = createPool();
const admin = { role: 'admin', userId: 'adm-1' };

const run = (sql, params) => withSession(pool, admin, client => client.query(sql, params));
const readState = () => withSession(pool, admin, client => readAggregate(client));

const keyOf = {
  patients: "id",
  professionals: "id",
  medications: "patient_id || '/' || id",
  instructions: "patient_id || '/' || id"
};

const snapshot = async () => {
  const result = {};
  for (const [table, key] of Object.entries(keyOf)) {
    const { rows } = await run(`SELECT ${key} AS k, version FROM ${table} ORDER BY 1`);
    result[table] = Object.fromEntries(rows.map(row => [row.k, row.version]));
  }
  return result;
};

const importState = () => {
  const result = spawnSync(process.execPath, [join(root, 'db', 'import-from-json.mjs'), '--force'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`import falhou: ${result.stderr || result.stdout}`);
};

before(importState);

after(async () => {
  await pool.end();
  try {
    importState();
  } catch (error) {
    console.error(`falha ao restaurar o banco: ${error.message}`);
  }
});

const firstMedication = "patient_id = 'pat-1' AND id = (SELECT min(id) FROM medications WHERE patient_id = 'pat-1')";
const versionOf = async (table, where) => (await run(`SELECT version FROM ${table} WHERE ${where}`)).rows[0].version;

describe('a versao existe e comeca em 1', () => {
  for (const table of Object.keys(keyOf)) {
    it(`${table}: toda linha importada esta na versao 1`, async () => {
      const total = (await run(`SELECT count(*)::int AS total FROM ${table}`)).rows[0].total;
      const outras = (await run(`SELECT count(*)::int AS total FROM ${table} WHERE version <> 1`)).rows[0].total;
      assert.ok(total > 0, `${table} esta vazia`);
      assert.equal(outras, 0);
    });
  }
});

describe('a versao sobe quando o conteudo muda', () => {
  it('medicacoes: mudar o nome sobe a versao em 1', async () => {
    const antes = await versionOf('medications', firstMedication);
    await run(`UPDATE medications SET name = name || ' (alterada)' WHERE ${firstMedication}`);
    assert.equal(await versionOf('medications', firstMedication), antes + 1);
  });

  it('instrucoes: mudar o conteudo sobe a versao em 1', async () => {
    const where = "patient_id = 'pat-1' AND id = (SELECT min(id) FROM instructions WHERE patient_id = 'pat-1')";
    const antes = await versionOf('instructions', where);
    await run(`UPDATE instructions SET content = content || ' (alterado)' WHERE ${where}`);
    assert.equal(await versionOf('instructions', where), antes + 1);
  });

  it('profissionais: mudar a especialidade sobe a versao em 1', async () => {
    const antes = await versionOf('professionals', "id = 'prof-1'");
    await run("UPDATE professionals SET specialty = specialty || ' (alterada)' WHERE id = 'prof-1'");
    assert.equal(await versionOf('professionals', "id = 'prof-1'"), antes + 1);
  });

  it('pacientes: mudar o cadastro (telefone) sobe a versao em 1', async () => {
    const antes = await versionOf('patients', "id = 'pat-1'");
    await run("UPDATE patients SET phone = phone || '1' WHERE id = 'pat-1'");
    assert.equal(await versionOf('patients', "id = 'pat-1'"), antes + 1);
  });

  it('duas mudancas seguidas sobem duas vezes', async () => {
    const antes = await versionOf('medications', firstMedication);
    await run(`UPDATE medications SET dose = dose || '1' WHERE ${firstMedication}`);
    await run(`UPDATE medications SET dose = dose || '2' WHERE ${firstMedication}`);
    assert.equal(await versionOf('medications', firstMedication), antes + 2);
  });
});

describe('a versao NAO sobe quando nada relevante mudou', () => {
  it('regravar os mesmos valores nao sobe a versao', async () => {
    const antes = await versionOf('medications', firstMedication);
    await run(`UPDATE medications SET name = name, dose = dose WHERE ${firstMedication}`);
    assert.equal(await versionOf('medications', firstMedication), antes);
  });

  it('so a posicao mudando nao sobe a versao (o PUT reescreve a posicao a cada salvamento)', async () => {
    for (const [table, where] of [
      ['medications', firstMedication],
      ['instructions', "patient_id = 'pat-1' AND id = (SELECT min(id) FROM instructions WHERE patient_id = 'pat-1')"],
      ['professionals', "id = 'prof-1'"],
      ['patients', "id = 'pat-1'"]
    ]) {
      const antes = await versionOf(table, where);
      await run(`UPDATE ${table} SET position = position + 5 WHERE ${where}`);
      assert.equal(await versionOf(table, where), antes, `${table}: a posicao subiu a versao`);
    }
  });

  it('pacientes: os sinais que o proprio paciente gera nao sobem a versao', async () => {
    // Senao um check-in do paciente derrubaria a edicao do cadastro que a equipe tem aberta.
    const antes = await versionOf('patients', "id = 'pat-1'");
    await run(`UPDATE patients SET
        current_pain = current_pain + 1,
        current_temp = current_temp + 0.1,
        last_check_in_time = last_check_in_time || '.',
        status = CASE WHEN status = 'critico' THEN 'estavel' ELSE 'critico' END,
        wound_review_pending = NOT wound_review_pending,
        medication_adherence_percent = medication_adherence_percent - 1
      WHERE id = 'pat-1'`);
    assert.equal(await versionOf('patients', "id = 'pat-1'"), antes);
  });

  it('pacientes: mudar sinais e cadastro juntos sobe uma vez so', async () => {
    const antes = await versionOf('patients', "id = 'pat-1'");
    await run("UPDATE patients SET current_pain = current_pain + 1, phone = phone || '2' WHERE id = 'pat-1'");
    assert.equal(await versionOf('patients', "id = 'pat-1'"), antes + 1);
  });
});

describe('o cliente nao escolhe a versao', () => {
  it('gravar uma versao qualquer sem mudar o conteudo nao muda nada', async () => {
    const antes = await versionOf('medications', firstMedication);
    await run(`UPDATE medications SET version = 99 WHERE ${firstMedication}`);
    assert.equal(await versionOf('medications', firstMedication), antes);
  });

  it('gravar uma versao qualquer junto com uma mudanca real sobe so em 1', async () => {
    const antes = await versionOf('medications', firstMedication);
    await run(`UPDATE medications SET name = name || '!', version = 99 WHERE ${firstMedication}`);
    assert.equal(await versionOf('medications', firstMedication), antes + 1);
  });

  it('inserir uma linha ja comeca na versao 1, mesmo pedindo outra', async () => {
    await run(`INSERT INTO instructions (patient_id, id, position, category, title, content, icon_name, important, version)
               VALUES ('pat-1', 'ins-versao-teste', 99, 'c', 't', 'x', 'i', false, 77)`);
    assert.equal(await versionOf('instructions', "patient_id = 'pat-1' AND id = 'ins-versao-teste'"), 1);
    await run("DELETE FROM instructions WHERE id = 'ins-versao-teste'");
  });
});

describe('a leitura entrega a versao', () => {
  it('pacientes, medicacoes, instrucoes e profissionais trazem version', async () => {
    const state = await readState();
    assert.ok(Number.isInteger(state.patients[0].version), 'paciente sem version');
    assert.ok(state.patients.every(patient => Number.isInteger(patient.version)));
    const withMedications = state.patients.find(patient => patient.medications.length);
    assert.ok(withMedications.medications.every(medication => Number.isInteger(medication.version)), 'medicacao sem version');
    const withInstructions = state.patients.find(patient => patient.instructions.length);
    assert.ok(withInstructions.instructions.every(instruction => Number.isInteger(instruction.version)), 'instrucao sem version');
    assert.ok(state.professionals.every(professional => Number.isInteger(professional.version)), 'profissional sem version');
  });

  it('a versao lida e a que esta no banco', async () => {
    const state = await readState();
    const banco = await snapshot();
    for (const patient of state.patients) assert.equal(patient.version, banco.patients[patient.id]);
    for (const professional of state.professionals) assert.equal(professional.version, banco.professionals[professional.id]);
  });
});

describe('o PUT nao mexe nas versoes sem mudanca real', () => {
  it('salvar o mesmo estado de novo nao muda nenhuma versao', async () => {
    // O primeiro salvamento pode normalizar um rotulo (surgeon_label recebe o nome
    // exibido do cirurgiao); a partir dai o estado esta estavel.
    await putState(admin, await readState());
    const antes = await snapshot();
    await putState(admin, await readState());
    assert.deepEqual(await snapshot(), antes);
  });

  it('alterar so uma medicacao pelo PUT sobe so a versao dela', async () => {
    await putState(admin, await readState());
    const antes = await snapshot();
    const state = await readState();
    const patient = state.patients.find(item => item.id === 'pat-1');
    const alvo = patient.medications[0];
    alvo.name = `${alvo.name} (via PUT)`;
    await putState(admin, state);

    const depois = await snapshot();
    const chave = `pat-1/${alvo.id}`;
    assert.equal(depois.medications[chave], antes.medications[chave] + 1);
    assert.deepEqual({ ...depois.medications, [chave]: 0 }, { ...antes.medications, [chave]: 0 }, 'outra medicacao mudou de versao');
    assert.deepEqual(depois.patients, antes.patients, 'a versao de algum paciente mudou');
    assert.deepEqual(depois.instructions, antes.instructions);
    assert.deepEqual(depois.professionals, antes.professionals);
  });
});

describe('os horarios de uma medicacao contam como conteudo dela', () => {
  // Os horarios moram em medication_times, outra tabela. Sem tratamento, mudar so os
  // horarios nao tocaria a linha da medicacao e a versao nao subiria: uma edicao
  // concorrente dos horarios passaria despercebida.
  const medWhere = "patient_id = 'pat-1' AND id = (SELECT min(id) FROM medications WHERE patient_id = 'pat-1')";
  const timesOf = async () => (await run(`SELECT time, position FROM medication_times
      WHERE patient_id = 'pat-1' AND medication_id = (SELECT min(id) FROM medications WHERE patient_id = 'pat-1') ORDER BY position`)).rows;

  it('acrescentar um horario sobe a versao da medicacao', async () => {
    const antes = await versionOf('medications', medWhere);
    await run(`INSERT INTO medication_times (patient_id, medication_id, time, position)
               VALUES ('pat-1', (SELECT min(id) FROM medications WHERE patient_id = 'pat-1'), '23:59', 99)`);
    assert.equal(await versionOf('medications', medWhere), antes + 1);
  });

  it('regravar um horario com os mesmos valores nao sobe a versao (o PUT faz isso a cada salvamento)', async () => {
    const antes = await versionOf('medications', medWhere);
    await run(`UPDATE medication_times SET position = position WHERE patient_id = 'pat-1'
               AND medication_id = (SELECT min(id) FROM medications WHERE patient_id = 'pat-1')`);
    assert.equal(await versionOf('medications', medWhere), antes);
  });

  it('trocar a ordem dos horarios sobe a versao', async () => {
    const times = await timesOf();
    assert.ok(times.length >= 2, 'precisa de ao menos 2 horarios');
    const antes = await versionOf('medications', medWhere);
    await run(`UPDATE medication_times SET position = position + 100 WHERE patient_id = 'pat-1' AND time = $1
               AND medication_id = (SELECT min(id) FROM medications WHERE patient_id = 'pat-1')`, [times[0].time]);
    assert.equal(await versionOf('medications', medWhere), antes + 1);
  });

  it('remover um horario sobe a versao', async () => {
    const antes = await versionOf('medications', medWhere);
    await run(`DELETE FROM medication_times WHERE patient_id = 'pat-1' AND time = '23:59'
               AND medication_id = (SELECT min(id) FROM medications WHERE patient_id = 'pat-1')`);
    assert.equal(await versionOf('medications', medWhere), antes + 1);
  });

  it('apagar a medicacao leva os horarios junto, sem erro do gatilho', async () => {
    await run(`INSERT INTO medications (patient_id, id, position, name) VALUES ('pat-1', 'med-gatilho-teste', 99, 'x')`);
    await run(`INSERT INTO medication_times (patient_id, medication_id, time, position) VALUES ('pat-1', 'med-gatilho-teste', '10:00', 0)`);
    await run("DELETE FROM medications WHERE patient_id = 'pat-1' AND id = 'med-gatilho-teste'");
    const left = (await run("SELECT count(*)::int AS total FROM medication_times WHERE medication_id = 'med-gatilho-teste'")).rows[0].total;
    assert.equal(left, 0);
  });
});
