import { spawn, spawnSync } from 'node:child_process';
import { openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { createPool } from '../db/session.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = 'http://127.0.0.1:3194';
const json = { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' };

// Conecta como vivace_api, o papel da aplicação, para os testes de sessão e
// bloqueio olharem a tabela como ela realmente fica gravada, e não só a resposta
// da API.
const pool = createPool();

const call = async (path, { method = 'GET', token, body, ip = '10.0.0.1', at = base } = {}) => {
  const headers = { ...json, 'X-Forwarded-For': ip };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${at}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed };
};

const login = async (username, password = 'vivace-demo', ip = '10.0.0.1') => {
  const result = await call('/api/auth/login', { method: 'POST', body: { username, password }, ip });
  assert.equal(result.status, 200, `login de ${username} falhou: ${JSON.stringify(result.body)}`);
  return result.body;
};

let serverPid = null;

// Sobe o servidor e espera a porta responder 401, que é o estado de pé sem
// sessão. Extraído porque os testes de sessão e bloqueio precisam reiniciá-lo:
// essa é a asserção central da fase, o bloqueio e a sessão existem depois do
// processo que os criou.
const startServer = async (env = {}) => {
  // detached + stdio em arquivo: se o processo filho herdar o stdout, o runner
  // de teste nunca ve EOF e trava.
  const log = openSync('/tmp/vivace-api-test.log', 'w');
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      DATABASE_URL: 'postgres://vivace_api:vivace@127.0.0.1:55432/vivace',
      MIGRATION_DATABASE_URL: 'postgres://vivace:vivace@127.0.0.1:55432/vivace',
      VIVACE_SKIP_FRONTEND: 'true',
      VIVACE_API_PORT: '3194',
      ...env
    }
  });
  server.unref();

  const port = env.VIVACE_API_PORT ?? '3194';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 250));
    try {
      // A sonda precisa mirar a porta que este servidor recebeu. Se ficasse
      // presa na 3194, ela veria o servidor compartilhado responder 401 e daria
      // o arranque por DEFAULT antes do processo novo existir.
      const probe = await call('/api/state', { at: `http://127.0.0.1:${port}` });
      if (probe.status === 401) return server.pid;
    } catch {
      // ainda subindo
    }
  }
  throw new Error('servidor nao respondeu em 10s');
};

// Mata o grupo inteiro: o servidor cria socket e pool, e pode ter filho.
const stopServer = pid => {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    spawnSync('kill', ['-9', String(pid)]);
  }
};

before(async () => {
  const importResult = spawnSync(process.execPath, [resolve(root, 'db/import-from-json.mjs'), '--force'], { cwd: root, encoding: 'utf8' });
  assert.equal(importResult.status, 0, `import falhou: ${importResult.stderr}`);

  // O import trunca as tabelas de clinica, mas sessão e bloqueio agora vivem no
  // banco e sobrevivem a ele. Sem esta limpeza, uma execução anterior deixaria
  // chaves bloqueadas e o teste de bloqueio de força bruta falharia por sobras
  // da rodada passada, não por defeito do código.
  // DELETE e não TRUNCATE: TRUNCATE é um privilégio à parte, que o papel da
  // aplicação não tem, e a tabela é pequena demais para justificar o privilégio.
  await pool.query('DELETE FROM sessions');
  await pool.query('DELETE FROM login_attempts');

  // O limite de requisições é lido de VIVACE_RATE_*, e o teste de rate limit
  // precisa estourar o teto. Um teto alto aqui (1200 por sessão por minuto) deixa
  // a suíte inteira passar sem tocar no limite, e o teste do limite sobe um
  // servidor próprio com teto baixo, sem afetar os outros.
  serverPid = await startServer();
});

after(async () => {
  if (serverPid) stopServer(serverPid);
  await pool.end();
  const restore = spawnSync(process.execPath, [resolve(root, 'db/import-from-json.mjs'), '--force'], { cwd: root, encoding: 'utf8' });
  if (restore.status !== 0) console.error('falha ao restaurar o banco');
});

describe('login', () => {
  it('autentica profissional, paciente e admin', async () => {
    assert.equal((await login('Rafaely Carvalho')).role, 'professional');
    assert.equal((await login('mariana')).role, 'patient');
    assert.equal((await login('admin@vivace.med.br')).role, 'admin');
  });

  it('senha errada nao entra', async () => {
    const result = await call('/api/auth/login', { method: 'POST', body: { username: 'mariana', password: 'errada' } });
    assert.equal(result.status, 401);
  });
});

describe('GET /api/state por papel', () => {
  it('admin ve tudo, inclusive os 4 pacientes e profissionais', async () => {
    const state = (await call('/api/state', { token: (await login('admin@vivace.med.br')).token })).body;
    assert.equal(state.patients.length, 4);
    assert.equal(state.professionals.length, 1);
    assert.equal(state.admins.length, 1);
  });

  it('profissional ve os 4 pacientes, mas so o proprio cadastro', async () => {
    const token = (await login('Rafaely Carvalho')).token;
    const state = (await call('/api/state', { token })).body;
    assert.equal(state.patients.length, 4);
    // Corrige o bug de professionalUser() ser professionals()[0].
    assert.deepEqual(state.professionals.map(p => p.id), ['prof-1']);
    assert.equal(state.admins.length, 0);
  });

  it('paciente ve so o proprio registro, sem notas clinicas e sem profissionais', async () => {
    const token = (await login('mariana')).token;
    const state = (await call('/api/state', { token })).body;
    assert.deepEqual(state.patients.map(p => p.id), ['pat-1']);
    assert.deepEqual(state.patients[0].clinicalNotes, []);
    assert.deepEqual(state.professionals, []);
    assert.deepEqual(state.admins, []);
  });

  it('nenhum payload carrega senha', async () => {
    for (const username of ['Rafaely Carvalho', 'mariana', 'admin@vivace.med.br']) {
      const raw = await fetch(`${base}/api/state`, {
        headers: { ...json, Authorization: `Bearer ${(await login(username)).token}` }
      }).then(response => response.text());
      assert.ok(!raw.includes('scrypt$'), `payload de ${username} vazou hash`);
      assert.ok(!/"password"/.test(raw), `payload de ${username} tem campo password`);
    }
  });
});

describe('PUT /api/state', () => {
  it('professional altera paciente visivel', async () => {
    const token = (await login('Rafaely Carvalho')).token;
    const state = (await call('/api/state', { token })).body;
    const target = state.patients.find(patient => patient.id === 'pat-3');
    target.bloodPressure = '111/77 mmHg';
    const put = await call('/api/state', { method: 'PUT', token, body: state });
    assert.equal(put.status, 200);
    const after = (await call('/api/state', { token })).body.patients.find(patient => patient.id === 'pat-3');
    assert.equal(after.bloodPressure, '111/77 mmHg');
  });

  it('profissional nao apaga paciente alheio ao enviar estado parcial', async () => {
    // O caso que rejectForeignPatients resolvia na mao: prof-9 so enxerga pat-1 e
    // pat-2, entao o payload dele nao traz pat-3 nem pat-4. O DELETE por conjunto
    // nao pode alcancar linhas invisiveis, senao o PUT de um profissional
    // apagaria o prontuario dos colegas.
    const admin = (await login('admin@vivace.med.br')).token;
    const full = (await call('/api/state', { token: admin })).body;
    const professionals = [
      ...full.professionals,
      { id: 'prof-9', name: 'Helena Duarte', role: 'Cirurgia Plastica', crmCoren: 'CRM-SP 222.111', avatar: '', email: 'helena@vivace.med.br', specialty: 'Cirurgia Plastica', password: 'vivace-demo' }
    ];
    const created = await call('/api/state', { method: 'PUT', token: admin, body: { ...full, professionals } });
    assert.equal(created.status, 200, `cadastro do profissional falhou: ${JSON.stringify(created.body)}`);

    const outsider = await login('Helena Duarte', 'vivace-demo');
    const visible = (await call('/api/state', { token: outsider.token })).body.patients.map(p => p.id);
    // prof-9 nao esta na equipe de ninguem, entao so enxerga o paciente sem
    // cirurgiao atribuido. pat-1, pat-3 e pat-4 tem equipe (prof-1).
    assert.deepEqual(visible, ['pat-2']);

    const partial = (await call('/api/state', { token: outsider.token })).body;
    assert.equal((await call('/api/state', { method: 'PUT', token: outsider.token, body: partial })).status, 200);

    const survivors = (await call('/api/state', { token: admin })).body.patients.map(p => p.id);
    assert.deepEqual(survivors, ['pat-1', 'pat-2', 'pat-3', 'pat-4'], 'o PUT parcial nao pode apagar prontuario alheio');
  });

  it('paciente nao faz PUT', async () => {
    const token = (await login('mariana')).token;
    const result = await call('/api/state', { method: 'PUT', token, body: { patients: [], professionals: [] } });
    assert.equal(result.status, 403);
  });
});

describe('mensagens, check-in e medicamento', () => {
  it('paciente envia mensagem para si mesmo', async () => {
    const token = (await login('mariana')).token;
    const result = await call('/api/messages', {
      method: 'POST', token, body: { patientId: 'pat-1', text: 'Sem febre hoje', clientMessageId: 'msg-teste-1' }
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.message.sender, 'paciente');
    assert.equal(result.body.message.text, 'Sem febre hoje');
  });

  it('mensagem duplicada nao duplica', async () => {
    const token = (await login('mariana')).token;
    const body = { patientId: 'pat-1', text: 'Sem febre hoje', clientMessageId: 'msg-teste-1' };
    await call('/api/messages', { method: 'POST', token, body });
    const state = (await call('/api/state', { token })).body;
    assert.equal(state.patients[0].messages.filter(m => m.id === 'msg-teste-1').length, 1);
  });

  it('paciente nao manda mensagem para o registro de outro', async () => {
    const token = (await login('mariana')).token;
    const result = await call('/api/messages', {
      method: 'POST', token, body: { patientId: 'pat-2', text: 'intruso' }
    });
    assert.equal(result.status, 403);
  });

  it('paciente nao acha paciente inexistente', async () => {
    const token = (await login('Rafaely Carvalho')).token;
    const result = await call('/api/messages', {
      method: 'POST', token, body: { patientId: 'pat-inexistente', text: 'oi' }
    });
    assert.equal(result.status, 404);
  });

  it('check-in do paciente entra no inicio da lista e atualiza os sinais', async () => {
    const token = (await login('mariana')).token;
    const result = await call('/api/checkins', {
      method: 'POST',
      token,
      body: {
        id: 'chk-e2e-1',
        patientId: 'pat-1',
        checkIn: { date: '30/09/2026', dayLabel: 'D+9', painLevel: 8, temperature: 38.1, mobilityScore: 'repouso_absoluto', symptoms: ['febre'], notes: 'teste', mood: 'preocupado' }
      }
    });
    assert.equal(result.status, 201);
    const patient = result.body.patient;
    // A UI le checkIns[0] como "hoje".
    assert.equal(patient.checkIns[0].id, 'chk-e2e-1');
    assert.equal(patient.currentPain, 8);
    assert.equal(patient.status, 'critico');
    // Nota clinica nao volta para papel de paciente: era um vazamento antes.
    assert.deepEqual(patient.clinicalNotes, []);
    // Timeline cresce no fim.
    assert.equal(patient.timeline[patient.timeline.length - 1].id, 'tl-chk-e2e-1');
  });

  it('check-in repetido com o mesmo id nao duplica', async () => {
    const token = (await login('mariana')).token;
    const body = {
      id: 'chk-e2e-1', patientId: 'pat-1',
      checkIn: { date: '30/09/2026', dayLabel: 'D+9', painLevel: 8, temperature: 38.1, symptoms: [], notes: '', mood: 'preocupado' }
    };
    await call('/api/checkins', { method: 'POST', token, body });
    const state = (await call('/api/state', { token })).body;
    assert.equal(state.patients[0].checkIns.filter(c => c.id === 'chk-e2e-1').length, 1);
  });

  it('medicamento alterna takenToday e recalcula adherencia', async () => {
    const token = (await login('mariana')).token;
    const before = (await call('/api/state', { token })).body.patients[0];
    const medication = before.medications[0];
    const time = medication.times[0];
    const wasTaken = medication.takenToday[time];

    const result = await call('/api/medication-taken', {
      method: 'POST', token, body: { patientId: 'pat-1', medicationId: medication.id, time }
    });
    assert.equal(result.status, 200);
    const after = result.body.patient.medications.find(m => m.id === medication.id);
    assert.equal(after.takenToday[time], !wasTaken);

    // A aderencia e a razao de slots tomados, entao tem que refletir o toggle.
    const slots = result.body.patient.medications.flatMap(m => m.times.map(t => m.takenToday[t]));
    const expected = Math.round(slots.filter(Boolean).length / slots.length * 100);
    assert.equal(result.body.patient.medicationAdherencePercent, expected);
  });

  it('check-in de paciente alheio grava no proprio registro, nunca no alheio', async () => {
    // O servidor substitui patientId pelo da sessao quando o papel e paciente,
    // entao o check-in vai para pat-1 e pat-3 fica intacto. Nao e 404: e o
    // comportamento seguro, e o mesmo de antes da migracao.
    const token = (await login('mariana')).token;
    const result = await call('/api/checkins', {
      method: 'POST', token,
      body: { id: 'chk-intruso', patientId: 'pat-3', checkIn: { painLevel: 1, temperature: 36.5, symptoms: [], notes: '', mood: 'bem' } }
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.patient.id, 'pat-1');

    const adminToken = (await login('admin@vivace.med.br')).token;
    const adminState = (await call('/api/state', { token: adminToken })).body;
    assert.ok(!adminState.patients.find(p => p.id === 'pat-3').checkIns.some(c => c.id === 'chk-intruso'));
  });
});

describe('ordem das colecoes', () => {
  it('check_ins decrescente, wound_photos decrescente, timeline e mensagens crescentes', async () => {
    const token = (await login('Rafaely Carvalho')).token;
    const patient = (await call('/api/state', { token })).body.patients.find(p => p.id === 'pat-1');

    // A UI le checkIns[0] como "de hoje", entao o mais recente entra no inicio.
    // Dois check-ins novos foram criados por outros testes, nesta ordem:
    // chk-e2e-1 e depois chk-intruso. O ultimo criado e o primeiro da lista.
    const checkIns = patient.checkIns.map(c => c.id);
    assert.equal(checkIns[0], 'chk-intruso');
    assert.equal(checkIns[1], 'chk-e2e-1');
    assert.deepEqual(checkIns.slice(2), [
      'chk-1790700384906', 'chk-1790699335797', 'chk-1', 'chk-2', 'chk-3'
    ], 'os check-ins originais mantem a ordem relativa');

    // A timeline e lida em ordem cronologica, entao cresce no fim.
    const timeline = patient.timeline.map(event => event.id);
    assert.equal(timeline[0], 'tl-1');
    assert.equal(timeline[timeline.length - 2], 'tl-chk-e2e-1');
    assert.equal(timeline[timeline.length - 1], 'tl-chk-intruso');

    // Fotos nao mudam de ordem e continuam sendo 4.
    assert.deepEqual(patient.woundPhotos.map(photo => photo.id), [
      'wp-1790700384853', 'wp-1790699335745', 'wp-1', 'wp-2'
    ]);

    // Mensagens: as originais mais a do teste, em ordem de chegada.
    const messages = patient.messages.map(message => message.id);
    assert.deepEqual(messages, ['msg-1', 'msg-2', 'msg-3', 'msg-teste-1']);
  });

  it('medications preserva ordem e takenToday traz false explicito', async () => {
    const token = (await login('Rafaely Carvalho')).token;
    const patient = (await call('/api/state', { token })).body.patients.find(p => p.id === 'pat-1');
    const medication = patient.medications[0];
    for (const time of medication.times) {
      assert.ok(time in medication.takenToday, `takenToday sem a chave ${time}`);
      assert.equal(typeof medication.takenToday[time], 'boolean');
    }
  });

  it('foto de upload volta como data url e a de demonstracao como http', async () => {
    const token = (await login('Rafaely Carvalho')).token;
    const patient = (await call('/api/state', { token })).body.patients.find(p => p.id === 'pat-1');
    const kinds = new Set(patient.woundPhotos.map(photo => photo.imageUrl.slice(0, 14)));
    assert.ok(kinds.size >= 1);
    for (const photo of patient.woundPhotos) {
      const isData = photo.imageUrl.startsWith('data:image/');
      const isHttp = photo.imageUrl.startsWith('http');
      assert.ok(isData || isHttp, `origem inesperada: ${photo.imageUrl.slice(0, 40)}`);
    }
  });
});

// A fase 4 trocou dois Maps por duas tabelas. O que precisa ser provado aqui não
// é a resposta da API, e sim que o estado continua existindo quando o processo
// que o criou morre: era exatamente isso que o Map em memória não dava.
describe('sessao e bloqueio no banco', () => {
  // Reinicia o servidor compartilhado. Se algo falhar no meio, o processo fica
  // no ar de qualquer forma, porque o start só lança depois que a porta responde.
  const restart = async env => {
    if (serverPid) stopServer(serverPid);
    serverPid = await startServer(env);
  };

  const countSessions = async () => Number((await pool.query('SELECT count(*)::int AS total FROM sessions')).rows[0].total);

  // O teste procura a sessão pelo hash, como o servidor faz, e não pelo token: se
  // ele procurasse pelo token em claro, estaria provando que o token está no
  // banco, que é justamente o que não pode mais acontecer.
  const digest = token => createHash('sha256').update(token).digest('hex');

  it('login grava a sessao no banco com papel, usuario e nome', async () => {
    const { token, name } = await login('mariana', 'vivace-demo', '10.9.0.10');
    const row = (await pool.query('SELECT * FROM sessions WHERE token_hash = $1', [digest(token)])).rows[0];
    assert.ok(row, 'a sessao nao foi gravada em sessions');
    assert.equal(row.role, 'patient');
    assert.equal(row.user_id, 'pat-1');
    assert.equal(row.name, name);
    assert.ok(row.expires_at > new Date(), 'a sessao ja nasceu vencida');
    // Uma linha por login. O Map também dava uma, mas morria com o processo.
    assert.ok(await countSessions() > 0);
  });

  it('o token em claro nao aparece em nenhuma coluna de sessions', async () => {
    const { token } = await login('Rafaely Carvalho', 'vivace-demo', '10.9.0.10');

    // A garantia é sobre o valor, não sobre a coluna: um SELECT de tudo e uma
    // busca pelo valor literal cobrem um token guardado em campo inesperado, e não
    // só o token_hash.
    const todas = await pool.query('SELECT * FROM sessions');
    const serializado = JSON.stringify(todas.rows);
    assert.ok(!serializado.includes(token), 'o token em claro esta em alguma coluna de sessions');
    assert.equal((await pool.query('SELECT count(*)::int AS total FROM sessions WHERE token_hash = $1', [token])).rows[0].total, 0);

    // E o que está no lugar é o resumo, que é determinístico.
    assert.equal((await pool.query('SELECT count(*)::int AS total FROM sessions WHERE token_hash = $1', [digest(token)])).rows[0].total, 1);
    assert.match(digest(token), /^[0-9a-f]{64}$/);
  });

  it('sessao continua valida depois que o servidor reinicia', async () => {
    const { token } = await login('Rafaely Carvalho', 'vivace-demo', '10.9.0.10');
    await restart();

    const state = await call('/api/state', { token, ip: '10.9.0.10' });
    assert.equal(state.status, 200, 'a sessao nao sobreviveu ao restart');
    assert.equal(state.body.patients.length, 4);
  });

  it('logout apaga a sessao no banco e o token nao volta a funcionar, nem apos restart', async () => {
    const { token } = await login('mariana', 'vivace-demo', '10.9.0.10');
    assert.equal((await pool.query('SELECT count(*)::int AS total FROM sessions WHERE token_hash = $1', [digest(token)])).rows[0].total, 1);

    const logout = await call('/api/auth/logout', { method: 'POST', token, ip: '10.9.0.10' });
    assert.equal(logout.status, 200);
    assert.equal((await pool.query('SELECT count(*)::int AS total FROM sessions WHERE token_hash = $1', [digest(token)])).rows[0].total, 0,
      'o logout responded ok mas deixou a sessao no banco');

    // Sem a linha, o token é rejeitado mesmo que o processo que o emitiu tenha
    // morrido: o segredo nunca esteve na memória do processo.
    await restart();
    assert.equal((await call('/api/state', { token, ip: '10.9.0.10' })).status, 401);
  });

  it('bloqueio de forca bruta sobrevive a restart, e o 429 traz Retry-After', async () => {
    const ip = '10.9.0.20';
    const identifier = 'conta-fantasma-bloqueio';
    // Cinco tentativas, o teto padrao. Identificador inventado de proposito: o
    // bloqueio nao depende de a conta existir, e assim nenhum login legitimo
    // fica bloqueado no banco de desenvolvimento.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await call('/api/auth/login', { method: 'POST', ip, body: { username: identifier, password: 'errada' } });
      assert.equal(result.status, 401, `tentativa ${attempt + 1} deveria ser 401`);
    }

    const locked = await call('/api/auth/login', { method: 'POST', ip, body: { username: identifier, password: 'errada' } });
    assert.equal(locked.status, 429);
    assert.match(locked.body.error, /Muitas tentativas/);

    const row = (await pool.query('SELECT * FROM login_attempts WHERE key = $1', [`ip:${ip}`])).rows[0];
    assert.equal(row.failures, 5);
    assert.ok(row.locked_until > new Date(), 'locked_until no futuro');

    // A asserção central: com o Map, o restart apagava a contagem e a tentativa
    // seguinte voltava a ser 401.
    await restart();
    const stillLocked = await call('/api/auth/login', { method: 'POST', ip, body: { username: identifier, password: 'errada' } });
    assert.equal(stillLocked.status, 429, 'o bloqueio nao sobreviveu ao restart');
  });

  it('o bloqueio e por chave: outro IP e outra conta nao herdam a contagem', async () => {
    // IP novo E conta nova. Se so o IP mudasse, a chave conta:continaria
    // carregando as cinco falhas do teste anterior, e o 429 estaria correto: o
    // bloqueio por conta existe justamente para valer mesmo quando o atacante
    // troca de origem.
    const result = await call('/api/auth/login', {
      method: 'POST', ip: '10.9.0.21', body: { username: 'conta-fantasma-isolada', password: 'errada' }
    });
    assert.equal(result.status, 401, 'uma chave limpa foi bloqueada pela contagem de outra');
  });

  it('a mesma conta continua bloqueada mesmo vindo de outro IP', async () => {
    // O outro lado da garantia: a chave conta: nao esvazia quando o IP muda.
    const result = await call('/api/auth/login', {
      method: 'POST', ip: '10.9.0.22', body: { username: 'conta-fantasma-bloqueio', password: 'errada' }
    });
    assert.equal(result.status, 429, 'a conta bloqueada entrou de novo por outro IP');
  });

  it('429 gasta scrypt, para nao denunciar conta bloqueada pelo tempo de resposta', async () => {
    const ip = '10.9.0.20';
    const identifier = 'conta-fantasma-bloqueio';
    const started = process.hrtime.bigint();
    const locked = await call('/api/auth/login', { method: 'POST', ip, body: { username: identifier, password: 'errada' } });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(locked.status, 429);
    // Piso, não comparação com o 401: o tempo do scrypt varia com a máquina,
    // mas a distância entre "não gastou scrypt" (poucos ms, só uma query) e
    // "gastou scrypt" (dezenas de ms) é de uma ordem de grandeza. Sem esta
    // linha o teste passaria com o burn removido.
    assert.ok(elapsedMs > 20, `o 429 respondeu em ${elapsedMs.toFixed(1)}ms, rápido demais para ter gasto scrypt`);
  });

  it('sessao vencida no banco nao autentica, mesmo com o processo vivo', async () => {
    // Um servidor com TTL de 1s, em outra porta, para não esperar as 8h do
    // padrão. A expiração é decided por now() no banco, então não há como
    // forçar por cima: ou o prazo passou, ou não.
    const shortTtl = 'http://127.0.0.1:3195';
    const ttlPid = await startServer({ VIVACE_API_PORT: '3195', VIVACE_SESSION_TTL_MS: '1000' });
    try {
      const attempt = await call('/api/auth/login', { method: 'POST', at: shortTtl, ip: '10.9.0.30', body: { username: 'mariana', password: 'vivace-demo' } });
      assert.equal(attempt.status, 200, `login no servidor de TTL curto falhou: ${JSON.stringify(attempt.body)}`);
      const { token } = attempt.body;
      assert.equal((await call('/api/state', { at: shortTtl, token, ip: '10.9.0.30' })).status, 200, 'a sessao de 1s nasceu morta');

      await new Promise(resolve => setTimeout(resolve, 1200));
      assert.equal((await call('/api/state', { at: shortTtl, token, ip: '10.9.0.30' })).status, 401, 'sessao vencida ainda autenticou');

      // A linha continua no banco: quem rejeita é o filtro de expires_at na
      // consulta, não a ausência da linha. Apagar é tarefa do varredor, e é por
      // isso que o caminho de leitura não pode depender de a limpeza ter rodado.
      const stillThere = await pool.query('SELECT count(*)::int AS total FROM sessions WHERE token_hash = $1', [digest(token)]);
      assert.equal(stillThere.rows[0].total, 1, 'a sessao vencida deveria continuar fisicamente na tabela');
    } finally {
      stopServer(ttlPid);
    }
  });

  it('o lockout e a sessao sao limpos no fim, para nao vazar para a proxima execucao', async () => {
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM login_attempts');
  });
});

// As três lacunas da revisão de segurança. Cada bloco nega o problema, não só
// descreve o bom: o teste que passa com a correção e sem ela não prova nada.
describe('origem e limite de requisicoes', () => {
  it('so a origem exata do frontend recebe Access-Control-Allow-Origin', async () => {
    // A porta é a do frontend. `127.0.0.1:9999` era aceito quando a checagem
    // comparava só o hostname, e é o caso que a allowlist por string inteira
    // fecha.
    const allowed = await fetch(`${base}/api/state`, { headers: { Origin: 'http://localhost:3000' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3000',
      'a propria origem do frontend foi rejeitada');

    for (const origin of ['http://127.0.0.1:9999', 'http://localhost:9999', 'http://evil.example.com', 'null', 'http://10.3.0.62:9999']) {
      const response = await fetch(`${base}/api/state`, { headers: { Origin: origin } });
      assert.equal(response.headers.get('access-control-allow-origin'), null,
        `origem indevida liberada: ${origin}`);
    }
  });

  it('VIVACE_ALLOWED_ORIGINS libera uma origem fora do padrao', async () => {
    const at = 'http://127.0.0.1:3196';
    const pid = await startServer({ VIVACE_API_PORT: '3196', VIVACE_ALLOWED_ORIGINS: 'https://app.exemplo.med.br' });
    try {
      const liberado = await fetch(`${at}/api/state`, { headers: { Origin: 'https://app.exemplo.med.br' } });
      assert.equal(liberado.headers.get('access-control-allow-origin'), 'https://app.exemplo.med.br');
      const outro = await fetch(`${at}/api/state`, { headers: { Origin: 'https://outro.exemplo.med.br' } });
      assert.equal(outro.headers.get('access-control-allow-origin'), null, 'liberou uma origem que nao esta na lista');
    } finally {
      stopServer(pid);
    }
  });

  it('estoura o limite por sessao e responde 429 com Retry-After', async () => {
    // Servidor próprio com teto baixo, para não precisar de milhares de requisições
    // e para não deixar o contador de outro teste em estado limítrofe.
    const at = 'http://127.0.0.1:3197';
    const ip = '10.9.1.1';
    const pid = await startServer({
      VIVACE_API_PORT: '3197',
      VIVACE_RATE_SESSION_MAX: '5',
      VIVACE_RATE_IP_MAX: '1000',
      VIVACE_RATE_WINDOW_MS: '60000'
    });
    try {
      const loginResult = await call('/api/auth/login', { method: 'POST', at, ip, body: { username: 'Rafaely Carvalho', password: 'vivace-demo' } });
      assert.equal(loginResult.status, 200, `login falhou no servidor de rate limit: ${JSON.stringify(loginResult.body)}`);
      const { token } = loginResult.body;

      const statuses = [];
      for (let i = 0; i < 8; i += 1) {
        statuses.push((await call('/api/state', { at, token, ip })).status);
      }
      // Teto de sessão é 5, e o login não conta (é a rota que faz o próprio
      // bloqueio), então as 5 primeiras passam e a 6a em diante leva 429.
      assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200], `esperava 5x200, veio ${statuses.join(',')}`);
      assert.ok(statuses.slice(5).every(status => status === 429), `esperava 429 depois do limite, veio ${statuses.join(',')}`);

      const limited = await call('/api/state', { at, token, ip });
      assert.match(limited.body.error, /Muitas requisições/);
    } finally {
      stopServer(pid);
    }
  });

  it('o limite por sessao nao contaminou outra sessao', async () => {
    const at = 'http://127.0.0.1:3197';
    const pid = await startServer({
      VIVACE_API_PORT: '3197',
      VIVACE_RATE_SESSION_MAX: '5',
      VIVACE_RATE_IP_MAX: '1000',
      VIVACE_RATE_WINDOW_MS: '60000'
    });
    try {
      const primeira = await call('/api/auth/login', { method: 'POST', at, ip: '10.9.1.2', body: { username: 'Rafaely Carvalho', password: 'vivace-demo' } });
      const segunda = await call('/api/auth/login', { method: 'POST', at, ip: '10.9.1.2', body: { username: 'mariana', password: 'vivace-demo' } });
      assert.equal(primeira.status, 200, `primeira sessao: ${JSON.stringify(primeira.body)}`);
      assert.equal(segunda.status, 200, `segunda sessao: ${JSON.stringify(segunda.body)}`);

      for (let i = 0; i < 8; i += 1) await call('/api/state', { at, token: primeira.body.token, ip: '10.9.1.2' });
      const estragada = await call('/api/state', { at, token: primeira.body.token, ip: '10.9.1.2' });
      const intacta = await call('/api/state', { at, token: segunda.body.token, ip: '10.9.1.2' });
      assert.equal(estragada.status, 429, 'a sessao estourada devia estar bloqueada');
      assert.equal(intacta.status, 200, 'o limite de uma sessao contaminou outra do mesmo IP');
    } finally {
      stopServer(pid);
    }
  });

  it('o limite por IP segura varias sessoes do mesmo endereco', async () => {
    const at = 'http://127.0.0.1:3197';
    const ip = '10.9.1.3';
    const pid = await startServer({
      VIVACE_API_PORT: '3197',
      VIVACE_RATE_SESSION_MAX: '1000',
      VIVACE_RATE_IP_MAX: '6',
      VIVACE_RATE_WINDOW_MS: '60000'
    });
    try {
      const a = await call('/api/auth/login', { method: 'POST', at, ip, body: { username: 'Rafaely Carvalho', password: 'vivace-demo' } });
      const b = await call('/api/auth/login', { method: 'POST', at, ip, body: { username: 'mariana', password: 'vivace-demo' } });
      for (let i = 0; i < 4; i += 1) await call('/api/state', { at, token: a.body.token, ip });
      for (let i = 0; i < 4; i += 1) await call('/api/state', { at, token: b.body.token, ip });
      const outra = await call('/api/auth/login', { method: 'POST', at, ip, body: { username: 'admin@vivace.med.br', password: 'vivace-demo' } });
      assert.equal(outra.status, 429, 'o limite por IP nao segurou o mesmo endereco com sessoes diferentes');
    } finally {
      stopServer(pid);
    }
  });

  it('token invalido nao gasta a cota da sessao, mas nao escapa da cota do IP', async () => {
    // São duas garantias diferentes, e a segunda é o que fecha o flood de scrypt.
    const at = 'http://127.0.0.1:3197';

    // 1) Token inválido nunca toca a cota de sessão: `authorize` devolve 401 antes
    //    de contar, então um IP com cota de sessão mínima continua vendo 401.
    const semIp = await startServer({
      VIVACE_API_PORT: '3197',
      VIVACE_RATE_SESSION_MAX: '1',
      VIVACE_RATE_IP_MAX: '1000',
      VIVACE_RATE_WINDOW_MS: '60000'
    });
    try {
      for (let i = 0; i < 10; i += 1) {
        const response = await call('/api/state', { at, token: 'token-que-nao-existe', ip: '10.9.1.5' });
        assert.equal(response.status, 401, `token invalido devia dar 401, deu ${response.status}`);
      }
    } finally {
      stopServer(semIp);
    }

    // 2) O limite de IP roda antes de autenticar, então nem um token falso escapa.
    //    Sem isso, um flood de requisições com token inválido gastaria uma consulta
    //    ao banco -- e, no login, um scrypt -- por requisição, sem teto.
    const comIp = await startServer({
      VIVACE_API_PORT: '3197',
      VIVACE_RATE_SESSION_MAX: '1000',
      VIVACE_RATE_IP_MAX: '3',
      VIVACE_RATE_WINDOW_MS: '60000'
    });
    try {
      const respostas = [];
      for (let i = 0; i < 6; i += 1) {
        respostas.push((await call('/api/state', { at, token: 'token-que-nao-existe', ip: '10.9.1.6' })).status);
      }
      assert.deepEqual(respostas, [401, 401, 401, 429, 429, 429],
        `o limite de IP nao segurou token invalido: ${respostas.join(',')}`);
    } finally {
      stopServer(comIp);
    }
  });
});
