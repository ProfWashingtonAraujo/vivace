import { spawn, spawnSync } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { createPool, withSession } from '../db/session.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = 'http://127.0.0.1:3194';
// O mesmo arquivo que o import usa para alimentar o banco (veja db/import-from-json.mjs).
const importFile = process.env.VIVACE_IMPORT_FILE ?? resolve(root, '.data', 'vivace-state.json');
const json = { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' };

// Conecta como vivace_api, o papel da aplicação, para os testes de sessão e
// bloqueio olharem a tabela como ela realmente fica gravada, e não só a resposta
// da API.
const pool = createPool();

const todayLabel = () => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date());
const adminSession = { role: 'admin', userId: 'adm-1' };

// Cada paciente so faz um check-in por dia. Os testes que enviam check-ins por outro motivo
// partem de um dia limpo (os check-ins de hoje passam para uma data antiga, sem sair da lista);
// os que testam a regra passam keepToday.
const clearToday = () => withSession(pool, adminSession, client => client.query("UPDATE check_ins SET date = '01/01/2000' WHERE date = $1", [todayLabel()]));

const call = async (path, { method = 'GET', token, body, ip = '10.0.0.1', at = base, headers: extraHeaders = {}, keepToday = false } = {}) => {
  if (path === '/api/checkins' && method === 'POST' && !keepToday) await clearToday();
  const headers = { ...json, 'X-Forwarded-For': ip, ...extraHeaders };
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
  // Um arquivo por porta, em modo de anexar: os testes reiniciam o servidor, e com
  // 'w' o log de cada reinicio apagava o do anterior, escondendo o erro de um teste
  // que falhou antes.
  const log = openSync(`/tmp/vivace-api-test-${env.VIVACE_API_PORT ?? '3194'}.log`, 'a');
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
      // Os testes simulam IPs pelo X-Forwarded-For, o que so vale com um proxy
      // confiavel na frente, como no Render. Sem isso o cabecalho e ignorado.
      VIVACE_TRUST_PROXY_HOPS: '1',
      // A suite faz centenas de requisicoes (cada teste entra de novo), bem acima do teto
      // padrao de 300 por minuto por IP e 120 por sessao. Os testes do proprio limite sobem
      // servidores a parte com valores explicitos, que vencem estes.
      VIVACE_RATE_IP_MAX: '100000',
      VIVACE_RATE_SESSION_MAX: '100000',
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

describe('PUT /api/state foi removido (fase 4)', () => {
  it('nenhum papel grava o estado inteiro: responde 405', async () => {
    for (const username of ['Rafaely Carvalho', 'mariana', 'admin@vivace.med.br']) {
      const token = (await login(username)).token;
      const result = await call('/api/state', { method: 'PUT', token, body: { patients: [], professionals: [] } });
      assert.equal(result.status, 405, username);
    }
  });

  it('o GET continua e nada foi apagado', async () => {
    const admin = (await login('admin@vivace.med.br')).token;
    assert.ok((await call('/api/state', { token: admin })).body.patients.length >= 4);
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

    // Os ids "originais" vêm do mesmo arquivo que alimentou o banco, e não de ids
    // escritos aqui: o arquivo de desenvolvimento de cada pessoa tem check-ins e fotos
    // diferentes dos do seed do repositório.
    const original = JSON.parse(readFileSync(importFile, 'utf8')).patients.find(p => p.id === 'pat-1');

    // A UI le checkIns[0] como "de hoje", entao o mais recente entra no inicio.
    // Dois check-ins novos foram criados por outros testes, nesta ordem:
    // chk-e2e-1 e depois chk-intruso. O ultimo criado e o primeiro da lista.
    const checkIns = patient.checkIns.map(c => c.id);
    assert.equal(checkIns[0], 'chk-intruso');
    assert.equal(checkIns[1], 'chk-e2e-1');
    assert.deepEqual(checkIns.slice(2), original.checkIns.map(c => c.id), 'os check-ins originais mantem a ordem relativa');

    // A timeline e lida em ordem cronologica, entao cresce no fim.
    const timeline = patient.timeline.map(event => event.id);
    assert.equal(timeline[0], original.timeline[0].id);
    assert.equal(timeline[timeline.length - 2], 'tl-chk-e2e-1');
    assert.equal(timeline[timeline.length - 1], 'tl-chk-intruso');

    // Fotos nao mudam de ordem.
    assert.deepEqual(patient.woundPhotos.map(photo => photo.id), original.woundPhotos.map(photo => photo.id));

    // Mensagens: as originais mais a do teste, em ordem de chegada.
    const messages = patient.messages.map(message => message.id);
    assert.deepEqual(messages, [...original.messages.map(message => message.id), 'msg-teste-1']);
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

  it('o preflight libera PATCH e If-Match, que as edicoes do front usam de outra origem', async () => {
    const response = await fetch(`${base}/api/professionals/prof-1`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization,content-type,if-match' }
    });
    const methods = (response.headers.get('access-control-allow-methods') ?? '').split(/\s*,\s*/);
    const headers = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(/\s*,\s*/);
    assert.ok(methods.includes('PATCH'), `PATCH fora dos metodos: ${methods}`);
    for (const name of ['authorization', 'content-type', 'if-match']) assert.ok(headers.includes(name), `${name} fora dos cabecalhos: ${headers}`);
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

// ---------------------------------------------------------------------------
// Achados C1 e C2 da revisao: o stream de eventos nao pode contornar a equipe
// do paciente, e o limite de tentativas nao pode ser contornado.

const openStream = async token => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, {
    headers: { ...json, Authorization: `Bearer ${token}` },
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const block of decoder.decode(value, { stream: true }).split('\n\n')) {
          if (block.startsWith('data: ')) events.push(JSON.parse(block.slice(6)));
        }
      }
    } catch {
      // abortado pelo teste
    }
  })();
  return { events, close: () => controller.abort() };
};

const waitFor = async (predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
};

const postMessage = (token, patientId, text) =>
  call('/api/messages', { method: 'POST', token, body: { patientId, text, clientMessageId: `sse-${text}` } });

describe('C1: o stream de eventos respeita a equipe do paciente', () => {
  const streams = [];
  const open = async token => {
    const stream = await openStream(token);
    streams.push(stream);
    return stream;
  };
  after(() => streams.forEach(stream => stream.close()));

  before(() => ensureOutsider());

  it('profissional fora da equipe nao recebe a mensagem do paciente; o da equipe e o admin recebem', async () => {
    const teamMember = await open((await login('Rafaely Carvalho')).token);
    const outsider = await open((await login('Helena Duarte')).token);
    const admin = await open((await login('admin@vivace.med.br')).token);

    const sent = await postMessage((await login('mariana')).token, 'pat-1', 'ola equipe (c1)');
    assert.equal(sent.status, 201);

    assert.ok(await waitFor(() => teamMember.events.some(event => event.type === 'message.created')), 'a equipe nao recebeu');
    assert.ok(await waitFor(() => admin.events.some(event => event.type === 'message.created')), 'o admin nao recebeu');
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.deepEqual(outsider.events.filter(event => event.patientId === 'pat-1'), [], 'profissional fora da equipe recebeu evento de pat-1');
  });

  it('pat-2 tem equipe explicita: o profissional da equipe recebe e quem esta fora nao', async () => {
    const teamMember = await open((await login('Rafaely Carvalho')).token);
    const outsider = await open((await login('Helena Duarte')).token);
    const sent = await postMessage((await login('carlos')).token, 'pat-2', 'equipe explicita (c1)');
    assert.equal(sent.status, 201);
    assert.ok(await waitFor(() => teamMember.events.some(event => event.patientId === 'pat-2')), 'a equipe de pat-2 deveria receber');
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.deepEqual(outsider.events.filter(event => event.patientId === 'pat-2'), [], 'quem esta fora da equipe recebeu o evento de pat-2');
  });

  it('o evento de check-in tambem nao vaza para fora da equipe', async () => {
    const outsider = await open((await login('Helena Duarte')).token);
    const teamMember = await open((await login('Rafaely Carvalho')).token);
    const checkIn = await call('/api/checkins', {
      method: 'POST',
      token: (await login('mariana')).token,
      body: { id: 'chk-c1-sse', checkIn: { painLevel: 3, temperature: 36.6, mobilityScore: 'repouso_absoluto', symptoms: [], notes: 'segredo clinico', mood: 'bem' } }
    });
    assert.equal(checkIn.status, 201);
    assert.ok(await waitFor(() => teamMember.events.some(event => event.type === 'checkin.created')));
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.deepEqual(outsider.events.filter(event => event.type === 'checkin.created'), []);
  });
});

describe('C2: o limite de tentativas de login nao se contorna', () => {
  const clearAttempts = () => pool.query('DELETE FROM login_attempts');
  before(clearAttempts);
  after(clearAttempts);

  it('curinga no identificador nao resolve conta, mesmo com a senha certa', async () => {
    for (const username of ['%%%', 'mar_', '%', '_%_']) {
      const result = await call('/api/auth/login', { method: 'POST', body: { username, password: 'vivace-demo' }, ip: '10.9.5.1' });
      assert.equal(result.status, 401, `"${username}" nao devia autenticar`);
    }
  });

  it('variacoes do mesmo identificador compartilham o bloqueio da conta', async () => {
    // Todas resolvem para pat-1. Cada tentativa vem de um IP novo, para que so a
    // chave de conta possa segurar.
    const variants = ['mariana', 'mariana.souza@email.com', 'mariana.souza', 'mariana.s', 'mariana.so'];
    for (const [index, username] of variants.entries()) {
      const result = await call('/api/auth/login', { method: 'POST', body: { username, password: 'errada' }, ip: `10.9.6.${index + 1}` });
      assert.equal(result.status, 401, `tentativa ${index + 1} deveria ser 401`);
    }
    const locked = await call('/api/auth/login', { method: 'POST', body: { username: 'mariana.sou', password: 'vivace-demo' }, ip: '10.9.6.99' });
    assert.equal(locked.status, 429, 'uma variacao nova do identificador ganhou tentativas novas');
  });

  it('sem proxy confiavel, girar o X-Forwarded-For nao zera o limite por IP', async () => {
    await clearAttempts();
    const at = 'http://127.0.0.1:3198';
    const pid = await startServer({ VIVACE_API_PORT: '3198', VIVACE_TRUST_PROXY_HOPS: '0' });
    try {
      const statuses = [];
      for (let attempt = 0; attempt < 7; attempt += 1) {
        // Identificador diferente e IP forjado diferente a cada tentativa: so o
        // endereco real do socket pode acumular a contagem.
        const result = await call('/api/auth/login', {
          method: 'POST', at, ip: `203.0.113.${attempt + 1}`, body: { username: `fantasma-c2-${attempt}`, password: 'errada' }
        });
        statuses.push(result.status);
      }
      assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429], `o X-Forwarded-For forjado escapou do limite: ${statuses.join(',')}`);
    } finally {
      stopServer(pid);
    }
  });

  it('identificador e senha gigantes sao recusados antes de qualquer trabalho', async () => {
    const huge = await call('/api/auth/login', { method: 'POST', ip: '10.9.7.1', body: { username: 'a'.repeat(500), password: 'x' } });
    assert.equal(huge.status, 400);
    // 5.000 caracteres passam do teto de corpo do login (4 KB): a recusa vem como 413,
    // antes mesmo de olhar a senha.
    const longPassword = await call('/api/auth/login', { method: 'POST', ip: '10.9.7.2', body: { username: 'mariana', password: 'x'.repeat(5_000) } });
    assert.equal(longPassword.status, 413);
    // Dentro do teto de corpo mas acima do limite de senha (1024): 400.
    const longerThanLimit = await call('/api/auth/login', { method: 'POST', ip: '10.9.7.3', body: { username: 'mariana', password: 'x'.repeat(2_000) } });
    assert.equal(longerThanLimit.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Achados I5 e I6 da revisao (parte que precisa de banco): foto enviada,
// tamanho do check-in e a trava do ultimo administrador.

const tinyJpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64')}`;
const checkInBody = photo => ({
  id: `chk-i6-${Math.random().toString(36).slice(2, 8)}`,
  checkIn: { painLevel: 2, temperature: 36.5, mobilityScore: 'repouso_absoluto', symptoms: [], notes: 'ok', mood: 'bem' },
  ...(photo === undefined ? {} : { photo: { imageUrl: photo, patientNotes: 'foto' } })
});

describe('I6: foto e tamanho do check-in', () => {
  let token;
  before(async () => {
    token = (await login('mariana')).token;
  });

  it('jpeg real e aceito', async () => {
    const result = await call('/api/checkins', { method: 'POST', token, body: checkInBody(tinyJpeg) });
    assert.equal(result.status, 201, JSON.stringify(result.body));
  });

  it('SVG disfarçado de imagem e recusado com 400', async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64')}`;
    const result = await call('/api/checkins', { method: 'POST', token, body: checkInBody(svg) });
    assert.equal(result.status, 400);
  });

  it('texto declarado como jpeg e recusado com 400', async () => {
    const fake = `data:image/jpeg;base64,${Buffer.from('isto nao e uma imagem').toString('base64')}`;
    const result = await call('/api/checkins', { method: 'POST', token, body: checkInBody(fake) });
    assert.equal(result.status, 400);
  });

  it('check-in sem foto continua valido', async () => {
    const result = await call('/api/checkins', { method: 'POST', token, body: checkInBody(undefined) });
    assert.equal(result.status, 201);
  });

  it('corpo de check-in acima do teto de 8 MB vira 413, nao 500', async () => {
    const huge = `data:image/jpeg;base64,${'A'.repeat(9 * 1024 * 1024)}`;
    const result = await call('/api/checkins', { method: 'POST', token, body: checkInBody(huge) });
    assert.equal(result.status, 413);
  });

  it('login com corpo acima de 4 KB vira 413', async () => {
    const result = await call('/api/auth/login', { method: 'POST', ip: '10.9.8.1', body: { username: 'mariana', password: 'x'.repeat(10_000) } });
    assert.equal(result.status, 413);
  });
});


// ---------------------------------------------------------------------------
// Achado I4 da revisao: o runtime da API nao usa a credencial de dono.

describe('I4: a API funciona sem a credencial de dono do banco', () => {
  it('servidor com MIGRATION_DATABASE_URL inutilizavel ainda autentica e cria sessao', async () => {
    const at = 'http://127.0.0.1:3293';
    const pid = await startServer({
      VIVACE_API_PORT: '3293',
      MIGRATION_DATABASE_URL: 'postgres://ninguem:x@127.0.0.1:1/x'
    });
    try {
      for (const username of ['admin@vivace.med.br', 'Rafaely Carvalho', 'mariana']) {
        const result = await call('/api/auth/login', { method: 'POST', at, ip: '10.9.9.1', body: { username, password: 'vivace-demo' } });
        assert.equal(result.status, 200, `${username}: ${JSON.stringify(result.body)}`);
      }
    } finally {
      stopServer(pid);
    }
  });

  it('app_bootstrap_admin, chamado pelo papel da aplicacao, nao altera um admin existente', async () => {
    const before = (await pool.query("SELECT app_lookup_account('admin@vivace.med.br') AS found")).rows.length;
    const result = await pool.query("SELECT app_bootstrap_admin('adm-intruso', 'Intruso', 'intruso@x.com', 'scrypt$a$b') AS created");
    assert.equal(result.rows[0].created, false);
    const admin = await login('admin@vivace.med.br');
    assert.equal(admin.role, 'admin');
    assert.ok(before >= 1);
  });

  it('com a tabela de admins vazia, o bootstrap cria uma unica conta e a segunda chamada nao cria outra', async () => {
    const owner = createPool('postgres://vivace:vivace@127.0.0.1:55432/vivace');
    try {
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.role', 'admin', true), set_config('app.user_id', 'adm-1', true)");
        await client.query("DELETE FROM account_credentials WHERE role = 'admin'");
        await client.query('DELETE FROM admins');
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const first = await pool.query("SELECT app_bootstrap_admin('adm-1', 'Administrador', 'admin@vivace.med.br', 'scrypt$salt$hash') AS created");
      const second = await pool.query("SELECT app_bootstrap_admin('adm-2', 'Outro', 'outro@x.com', 'scrypt$s2$h2') AS created");
      assert.equal(first.rows[0].created, true);
      assert.equal(second.rows[0].created, false);
    } finally {
      await owner.end();
      // O restante da suite espera o admin de demonstracao com a senha padrao.
      const restore = spawnSync(process.execPath, [resolve(root, 'db/import-from-json.mjs'), '--force'], { cwd: root, encoding: 'utf8' });
      assert.equal(restore.status, 0, `restauracao falhou: ${restore.stderr}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Fase 0 do plano I2/I3: o PUT nao pode perder o que outras pessoas criaram
// depois da leitura da equipe, nem aceitar autoria vinda do cliente, nem apagar
// varios pacientes de uma vez.

const staffState = async token => (await call('/api/state', { token })).body;
const patientOf = (state, id) => state.patients.find(patient => patient.id === id);


// ---------------------------------------------------------------------------
// Fase 2, area 1: notas clinicas, avaliacao de foto e remetente das mensagens.
// O servidor decide autor, data, revisor e linha do tempo; o cliente so manda a
// intencao (o texto da nota, o veredito e o comentario).

const ensureOutsider = async () => {
  // Helena nao esta na equipe de ninguem: so enxerga o paciente sem equipe, se houver.
  const admin = (await login('admin@vivace.med.br')).token;
  const full = await staffState(admin);
  const existing = full.professionals.find(professional => professional.email === 'helena@vivace.med.br');
  if (existing) return existing.id;
  const created = await call('/api/professionals', {
    method: 'POST', token: admin,
    body: { name: 'Helena Duarte', role: 'Cirurgia Plastica', crmCoren: 'CRM-SP 222.111', email: 'helena@vivace.med.br', specialty: 'Cirurgia Plastica', password: 'vivace-demo' }
  });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  return created.body.professional.id;
};

const postNote = (token, patientId, body) =>
  call(`/api/patients/${patientId}/clinical-notes`, { method: 'POST', token, body });

const putReview = (token, patientId, photoId, body) =>
  call(`/api/patients/${patientId}/wound-photos/${photoId}/review`, { method: 'PUT', token, body });

// O paciente envia uma foto de verdade (pelo check-in) e devolve o id dela.
const patientSendsPhoto = async () => {
  const sent = await call('/api/checkins', {
    method: 'POST', token: (await login('mariana')).token, body: checkInBody(tinyJpeg)
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  return sent.body.patient.woundPhotos[0].id;
};

describe('Fase 2 / area 1: notas clinicas', () => {
  before(() => ensureOutsider());

  it('a equipe cria a nota; autor, data e id vem do servidor, nao do cliente', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const sent = await postNote(staff, 'pat-1', {
      text: 'Paciente evoluindo bem', author: 'Dra. Falsa', date: '01/01/2000 00:00', id: 'cn-forjado'
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const { note } = sent.body;
    assert.equal(note.author, 'Rafaely Carvalho');
    assert.match(note.date, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    assert.notEqual(note.date, '01/01/2000 00:00');
    assert.notEqual(note.id, 'cn-forjado');
    assert.equal(note.text, 'Paciente evoluindo bem');

    const notes = patientOf(await staffState(staff), 'pat-1').clinicalNotes;
    assert.equal(notes[0].id, note.id, 'a nota nova deve ser a primeira');
    assert.equal(notes[0].author, 'Rafaely Carvalho');
  });

  it('repetir o mesmo clientId nao duplica a nota', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const body = { text: 'nota idempotente area1', clientId: 'cn-cliente-area1' };
    const first = await postNote(staff, 'pat-1', body);
    const second = await postNote(staff, 'pat-1', body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.note.id, first.body.note.id);
    const copies = patientOf(await staffState(staff), 'pat-1').clinicalNotes.filter(note => note.text === 'nota idempotente area1');
    assert.equal(copies.length, 1);
  });

  it('o paciente nao cria nota (403) e nao ve as notas da equipe', async () => {
    const patientToken = (await login('mariana')).token;
    assert.equal((await postNote(patientToken, 'pat-1', { text: 'tentativa' })).status, 403);
    assert.deepEqual(patientOf(await staffState(patientToken), 'pat-1').clinicalNotes, []);
  });

  it('profissional fora da equipe nao escreve em paciente que nao ve', async () => {
    const outsider = (await login('Helena Duarte')).token;
    const result = await postNote(outsider, 'pat-1', { text: 'intruso' });
    assert.equal(result.status, 404);
    const notes = patientOf(await staffState((await login('Rafaely Carvalho')).token), 'pat-1').clinicalNotes;
    assert.ok(!notes.some(note => note.text === 'intruso'));
  });

  it('paciente inexistente responde 404', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    assert.equal((await postNote(staff, 'pat-que-nao-existe', { text: 'x' })).status, 404);
  });

  it('texto vazio, so espacos ou grande demais respondem 400', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    for (const text of ['', '   ', 'x'.repeat(2_001), 42, undefined]) {
      assert.equal((await postNote(staff, 'pat-1', { text })).status, 400, `texto ${JSON.stringify(text)?.slice(0, 20)}`);
    }
  });

  it('o evento da nota chega a equipe, nunca ao paciente, e nao carrega o texto', async () => {
    const staffStream = await openStream((await login('Rafaely Carvalho')).token);
    const patientStream = await openStream((await login('mariana')).token);
    try {
      const sent = await postNote((await login('Rafaely Carvalho')).token, 'pat-1', { text: 'segredo clinico area1' });
      assert.equal(sent.status, 201);
      assert.ok(await waitFor(() => staffStream.events.some(event => event.type === 'clinical-note.created')), 'a equipe nao recebeu');
      await new Promise(resolve => setTimeout(resolve, 1_000));
      assert.deepEqual(patientStream.events.filter(event => event.type === 'clinical-note.created'), [], 'o paciente recebeu o evento da nota');
      const event = staffStream.events.find(item => item.type === 'clinical-note.created');
      assert.ok(!JSON.stringify(event).includes('segredo clinico'), 'o evento carrega o texto da nota');
    } finally {
      staffStream.close();
      patientStream.close();
    }
  });
});

describe('Fase 2 / area 1: avaliacao de foto da ferida', () => {
  before(() => ensureOutsider());

  it('a equipe avalia; revisor, data e linha do tempo vem do servidor', async () => {
    const photoId = await patientSendsPhoto();
    const staff = (await login('Rafaely Carvalho')).token;
    const reviewed = await putReview(staff, 'pat-1', photoId, {
      status: 'avaliado_adequado', feedback: 'Boa cicatrizacao', reviewedBy: 'Dr. Falso', reviewedAt: '01/01/2000 as 00:00'
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    assert.equal(reviewed.body.photo.reviewStatus, 'avaliado_adequado');
    assert.equal(reviewed.body.photo.reviewedBy, 'Rafaely Carvalho');
    assert.match(reviewed.body.photo.reviewedAt, /^\d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}$/);

    const patient = patientOf(await staffState(staff), 'pat-1');
    const photo = patient.woundPhotos.find(item => item.id === photoId);
    assert.equal(photo.reviewStatus, 'avaliado_adequado');
    assert.equal(photo.reviewFeedback, 'Boa cicatrizacao');
    assert.equal(photo.reviewedBy, 'Rafaely Carvalho');

    const last = patient.timeline.at(-1);
    assert.equal(last.title, 'Cicatrização aprovada');
    assert.equal(last.author, 'Rafaely Carvalho');
    assert.equal(last.type, 'curativo');
    assert.equal(last.description, 'Boa cicatrizacao');

    const stillPending = patient.woundPhotos.some(item => !item.imageUrl.includes('images.unsplash.com') && item.reviewStatus === 'pendente');
    assert.equal(patient.woundReviewPending, stillPending, 'a marca de revisao pendente nao bate com as fotos');
    assert.equal(reviewed.body.woundReviewPending, stillPending);
  });

  it('o veredito "requer atencao" gera o titulo correspondente', async () => {
    const photoId = await patientSendsPhoto();
    const staff = (await login('Rafaely Carvalho')).token;
    assert.equal((await putReview(staff, 'pat-1', photoId, { status: 'requer_atencao', feedback: 'Vermelhidao' })).status, 200);
    const last = patientOf(await staffState(staff), 'pat-1').timeline.at(-1);
    assert.equal(last.title, 'Ferida requer atenção');
  });

  it('status invalido responde 400 e nada muda', async () => {
    const photoId = await patientSendsPhoto();
    const staff = (await login('Rafaely Carvalho')).token;
    for (const status of ['pendente', 'aprovada', '', undefined, 7]) {
      assert.equal((await putReview(staff, 'pat-1', photoId, { status, feedback: 'x' })).status, 400, `status ${JSON.stringify(status)}`);
    }
    const photo = patientOf(await staffState(staff), 'pat-1').woundPhotos.find(item => item.id === photoId);
    assert.equal(photo.reviewStatus, 'pendente');
  });

  it('comentario acima de 1000 caracteres responde 400', async () => {
    const photoId = await patientSendsPhoto();
    const staff = (await login('Rafaely Carvalho')).token;
    assert.equal((await putReview(staff, 'pat-1', photoId, { status: 'avaliado_adequado', feedback: 'x'.repeat(1_001) })).status, 400);
  });

  it('o paciente nao avalia a propria foto (403)', async () => {
    const photoId = await patientSendsPhoto();
    const patientToken = (await login('mariana')).token;
    assert.equal((await putReview(patientToken, 'pat-1', photoId, { status: 'avaliado_adequado', feedback: 'ok' })).status, 403);
  });

  it('foto inexistente e paciente fora da equipe respondem 404', async () => {
    const photoId = await patientSendsPhoto();
    const staff = (await login('Rafaely Carvalho')).token;
    assert.equal((await putReview(staff, 'pat-1', 'wp-que-nao-existe', { status: 'avaliado_adequado', feedback: 'x' })).status, 404);
    assert.equal((await putReview((await login('Helena Duarte')).token, 'pat-1', photoId, { status: 'avaliado_adequado', feedback: 'x' })).status, 404);
  });

  it('o paciente dono recebe o aviso da avaliacao, mas sem o texto do comentario', async () => {
    const photoId = await patientSendsPhoto();
    const patientStream = await openStream((await login('mariana')).token);
    try {
      const staff = (await login('Rafaely Carvalho')).token;
      assert.equal((await putReview(staff, 'pat-1', photoId, { status: 'avaliado_adequado', feedback: 'comentario reservado' })).status, 200);
      assert.ok(await waitFor(() => patientStream.events.some(event => event.type === 'wound-photo.reviewed')), 'o paciente nao recebeu o aviso');
      const event = patientStream.events.find(item => item.type === 'wound-photo.reviewed');
      assert.equal(event.photoId, photoId);
      assert.ok(!JSON.stringify(event).includes('comentario reservado'), 'o evento carrega o comentario');
    } finally {
      patientStream.close();
    }
  });
});

describe('Fase 2 / area 1: remetente das mensagens da equipe', () => {
  it('a mensagem da equipe leva o nome da sessao, mesmo que o cliente mande outro', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const sent = await call('/api/messages', {
      method: 'POST', token: staff,
      body: { patientId: 'pat-1', text: 'ola, tudo bem?', senderName: 'Dra. Falsa', clientMessageId: 'msg-area1-remetente' }
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const message = patientOf(await staffState(staff), 'pat-1').messages.find(item => item.id === 'msg-area1-remetente');
    assert.equal(message.sender, 'equipe');
    assert.equal(message.senderName, 'Rafaely Carvalho');
  });
});

// ---------------------------------------------------------------------------
// Fase 2, area 2: medicacoes e instrucoes. Criar, editar e apagar por chamadas
// proprias, com o cabecalho If-Match carregando a versao lida (fase 1). Uma edicao
// feita sobre uma versao velha responde 409 em vez de sobrescrever em silencio.

const medBody = (over = {}) => ({
  name: 'Dipirona', dose: '500mg', frequency: '6/6h', purpose: 'Dor', instructions: 'Apos a refeicao',
  times: ['06:00', '12:00', '18:00'], ...over
});
const instrBody = (over = {}) => ({
  category: 'curativo', title: 'Trocar o curativo', content: 'Uma vez ao dia, com soro.', important: false, ...over
});

const postItem = (kind, token, patientId, body) =>
  call(`/api/patients/${patientId}/${kind}`, { method: 'POST', token, body });
const patchItem = (kind, token, patientId, id, body, version) => call(`/api/patients/${patientId}/${kind}/${id}`, {
  method: 'PATCH', token, body, headers: version === undefined ? {} : { 'If-Match': String(version) }
});
const deleteItem = (kind, token, patientId, id, version) => call(`/api/patients/${patientId}/${kind}/${id}`, {
  method: 'DELETE', token, headers: version === undefined ? {} : { 'If-Match': String(version) }
});
const medicationOf = async (token, patientId, id) =>
  patientOf(await staffState(token), patientId).medications.find(item => item.id === id);
const instructionOf = async (token, patientId, id) =>
  patientOf(await staffState(token), patientId).instructions.find(item => item.id === id);

describe('Fase 2 / area 2: medicacoes', () => {
  before(() => ensureOutsider());

  it('a equipe cria; id e versao vem do servidor, e cada horario nasce nao tomado', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const created = await postItem('medications', staff, 'pat-1', { ...medBody(), id: 'med-forjado', version: 50 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { medication } = created.body;
    assert.notEqual(medication.id, 'med-forjado');
    assert.equal(medication.version, 1);
    assert.equal(medication.name, 'Dipirona');
    assert.deepEqual(medication.times, ['06:00', '12:00', '18:00']);
    assert.deepEqual(medication.takenToday, { '06:00': false, '12:00': false, '18:00': false });

    const read = await medicationOf(staff, 'pat-1', medication.id);
    assert.equal(read.name, 'Dipirona');
    assert.equal(read.version, 1);
  });

  it('repetir o mesmo clientId nao duplica a medicacao', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const body = { ...medBody({ name: 'Idempotente area2' }), clientId: 'med-cliente-area2' };
    const first = await postItem('medications', staff, 'pat-1', body);
    const second = await postItem('medications', staff, 'pat-1', body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.medication.id, first.body.medication.id);
    const copies = patientOf(await staffState(staff), 'pat-1').medications.filter(item => item.name === 'Idempotente area2');
    assert.equal(copies.length, 1);
  });

  it('o paciente nao cria, edita nem apaga (403); quem nao ve o paciente recebe 404', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const patientToken = (await login('mariana')).token;
    const outsider = (await login('Helena Duarte')).token;
    const { medication } = (await postItem('medications', staff, 'pat-1', medBody({ name: 'Acesso area2' }))).body;
    assert.equal((await postItem('medications', patientToken, 'pat-1', medBody())).status, 403);
    assert.equal((await patchItem('medications', patientToken, 'pat-1', medication.id, { name: 'x' }, 1)).status, 403);
    assert.equal((await deleteItem('medications', patientToken, 'pat-1', medication.id, 1)).status, 403);
    assert.equal((await postItem('medications', outsider, 'pat-1', medBody())).status, 404);
    assert.equal((await patchItem('medications', outsider, 'pat-1', medication.id, { name: 'x' }, 1)).status, 404);
    assert.equal((await deleteItem('medications', outsider, 'pat-1', medication.id, 1)).status, 404);
    assert.equal((await medicationOf(staff, 'pat-1', medication.id)).name, 'Acesso area2');
  });

  it('dados invalidos respondem 400', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const invalid = [
      { name: '' }, { name: 'x'.repeat(101) }, { name: 42 },
      { times: [] }, { times: ['25:00'] }, { times: ['8:00'] }, { times: ['06:00', '06:00'] },
      { times: Array.from({ length: 13 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`) },
      { times: 'nao-e-lista' }, { dose: 7 }, { instructions: 'x'.repeat(501) }
    ];
    for (const over of invalid) {
      const result = await postItem('medications', staff, 'pat-1', medBody(over));
      assert.equal(result.status, 400, `deveria recusar ${JSON.stringify(over).slice(0, 60)}`);
    }
  });

  it('editar com a versao certa sobe a versao e muda so o que veio', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const { medication } = (await postItem('medications', staff, 'pat-1', medBody({ name: 'Edicao area2' }))).body;
    const patched = await patchItem('medications', staff, 'pat-1', medication.id, { dose: '1g', id: 'med-forjado', version: 99 }, medication.version);
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.medication.version, medication.version + 1);
    assert.equal(patched.body.medication.dose, '1g');
    assert.equal(patched.body.medication.name, 'Edicao area2');
    assert.equal(patched.body.medication.id, medication.id);
    assert.deepEqual(patched.body.medication.times, medication.times);
  });

  it('sem If-Match responde 428; com versao velha responde 409, devolve a atual e nao grava', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const { medication } = (await postItem('medications', staff, 'pat-1', medBody({ name: 'Conflito area2' }))).body;
    assert.equal((await patchItem('medications', staff, 'pat-1', medication.id, { dose: 'x' })).status, 428);

    // A equipe le a versao 1; outra edicao a leva para a 2; a primeira chega atrasada.
    assert.equal((await patchItem('medications', staff, 'pat-1', medication.id, { dose: 'primeira' }, 1)).status, 200);
    const stale = await patchItem('medications', staff, 'pat-1', medication.id, { dose: 'atrasada' }, 1);
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.current.version, 2);
    assert.equal(stale.body.current.dose, 'primeira');
    assert.equal((await medicationOf(staff, 'pat-1', medication.id)).dose, 'primeira');

    // Cabecalho invalido nao vira conflito: e pedido malformado.
    for (const header of ['abc', '1.5', '-1', '']) {
      const result = await call(`/api/patients/pat-1/medications/${medication.id}`, {
        method: 'PATCH', token: staff, body: { dose: 'x' }, headers: { 'If-Match': header }
      });
      assert.ok([400, 428].includes(result.status), `If-Match ${JSON.stringify(header)} deu ${result.status}`);
    }
  });

  it('regravar os mesmos valores nao sobe a versao', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const { medication } = (await postItem('medications', staff, 'pat-1', medBody({ name: 'Igual area2' }))).body;
    const same = await patchItem('medications', staff, 'pat-1', medication.id, { name: 'Igual area2', times: medication.times }, medication.version);
    assert.equal(same.status, 200);
    assert.equal(same.body.medication.version, medication.version);
  });

  it('mudar so os horarios tambem sobe a versao, e as doses ja tomadas dos horarios que ficam sao mantidas', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const patientToken = (await login('mariana')).token;
    const { medication } = (await postItem('medications', staff, 'pat-1', medBody({ name: 'Horarios area2' }))).body;
    const taken = await call('/api/medication-taken', {
      method: 'POST', token: patientToken, body: { medicationId: medication.id, time: '06:00' }
    });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));

    const patched = await patchItem('medications', staff, 'pat-1', medication.id, { times: ['06:00', '09:00'] }, medication.version);
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.medication.version, medication.version + 1, 'trocar os horarios nao subiu a versao');
    assert.deepEqual(patched.body.medication.times, ['06:00', '09:00']);
    assert.deepEqual(patched.body.medication.takenToday, { '06:00': true, '09:00': false });
  });

  it('apagar exige a versao: velha responde 409 e nao apaga; certa apaga', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const { medication } = (await postItem('medications', staff, 'pat-1', medBody({ name: 'Apagar area2' }))).body;
    assert.equal((await deleteItem('medications', staff, 'pat-1', medication.id)).status, 428);
    assert.equal((await patchItem('medications', staff, 'pat-1', medication.id, { dose: 'nova' }, 1)).status, 200);
    assert.equal((await deleteItem('medications', staff, 'pat-1', medication.id, 1)).status, 409);
    assert.ok(await medicationOf(staff, 'pat-1', medication.id), 'a medicacao foi apagada com versao velha');
    assert.equal((await deleteItem('medications', staff, 'pat-1', medication.id, 2)).status, 200);
    assert.equal(await medicationOf(staff, 'pat-1', medication.id), undefined);
  });

  it('medicacao ou paciente inexistente respondem 404', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    assert.equal((await patchItem('medications', staff, 'pat-1', 'med-que-nao-existe', { dose: 'x' }, 1)).status, 404);
    assert.equal((await deleteItem('medications', staff, 'pat-1', 'med-que-nao-existe', 1)).status, 404);
    assert.equal((await postItem('medications', staff, 'pat-que-nao-existe', medBody())).status, 404);
  });

  it('a aderencia do paciente e recalculada ao criar e ao apagar, pela mesma conta das doses', async () => {
    // O percentual gravado no seed pode nao bater com as doses; o que se confere e que,
    // depois de cada operacao, ele passa a ser exatamente o que as doses implicam.
    const adherenceFrom = patient => {
      const slots = patient.medications.flatMap(item => item.times.map(time => item.takenToday[time]));
      return slots.length ? Math.round(slots.filter(Boolean).length / slots.length * 100) : 100;
    };
    const staff = (await login('Rafaely Carvalho')).token;
    const { medication } = (await postItem('medications', staff, 'pat-1', medBody({ name: 'Aderencia area2' }))).body;
    const afterCreate = patientOf(await staffState(staff), 'pat-1');
    assert.equal(afterCreate.medicationAdherencePercent, adherenceFrom(afterCreate));
    assert.equal((await deleteItem('medications', staff, 'pat-1', medication.id, medication.version)).status, 200);
    const afterDelete = patientOf(await staffState(staff), 'pat-1');
    assert.equal(afterDelete.medicationAdherencePercent, adherenceFrom(afterDelete));
  });

  it('o evento chega a equipe e ao paciente dono, sem o conteudo da medicacao', async () => {
    const staffToken = (await login('Rafaely Carvalho')).token;
    const staffStream = await openStream(staffToken);
    const patientStream = await openStream((await login('mariana')).token);
    try {
      const created = await postItem('medications', staffToken, 'pat-1', medBody({ name: 'Evento area2 sigiloso' }));
      assert.equal(created.status, 201);
      for (const stream of [staffStream, patientStream]) {
        assert.ok(await waitFor(() => stream.events.some(event => event.type === 'medication.changed')), 'faltou o evento');
        const event = stream.events.find(item => item.type === 'medication.changed');
        assert.equal(event.medicationId, created.body.medication.id);
        assert.equal(event.change, 'created');
        assert.ok(!JSON.stringify(event).includes('sigiloso'), 'o evento carrega o conteudo');
      }
    } finally {
      staffStream.close();
      patientStream.close();
    }
  });
});

describe('Fase 2 / area 2: instrucoes de pos-operatorio', () => {
  before(() => ensureOutsider());

  it('a equipe cria; id e versao vem do servidor, e o icone padrao e a categoria', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const created = await postItem('instructions', staff, 'pat-1', { ...instrBody(), id: 'inst-forjada', version: 50 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { instruction } = created.body;
    assert.notEqual(instruction.id, 'inst-forjada');
    assert.equal(instruction.version, 1);
    assert.equal(instruction.iconName, 'curativo');
    assert.equal((await instructionOf(staff, 'pat-1', instruction.id)).title, 'Trocar o curativo');
  });

  it('repetir o clientId nao duplica; paciente 403; quem nao ve o paciente 404', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const body = { ...instrBody({ title: 'Idempotente area2' }), clientId: 'inst-cliente-area2' };
    const first = await postItem('instructions', staff, 'pat-1', body);
    const second = await postItem('instructions', staff, 'pat-1', body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.instruction.id, first.body.instruction.id);
    assert.equal(patientOf(await staffState(staff), 'pat-1').instructions.filter(item => item.title === 'Idempotente area2').length, 1);
    assert.equal((await postItem('instructions', (await login('mariana')).token, 'pat-1', instrBody())).status, 403);
    assert.equal((await postItem('instructions', (await login('Helena Duarte')).token, 'pat-1', instrBody())).status, 404);
  });

  it('dados invalidos respondem 400', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    for (const over of [
      { title: '' }, { title: 'x'.repeat(121) }, { category: 'inventada' }, { category: undefined },
      { content: 'x'.repeat(2_001) }, { important: 'sim' }, { iconName: 'x'.repeat(51) }
    ]) {
      assert.equal((await postItem('instructions', staff, 'pat-1', instrBody(over))).status, 400, `deveria recusar ${JSON.stringify(over).slice(0, 60)}`);
    }
  });

  it('editar com a versao certa sobe; sem If-Match 428; velha 409 com a atual e sem gravar', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const { instruction } = (await postItem('instructions', staff, 'pat-1', instrBody({ title: 'Conflito area2' }))).body;
    assert.equal((await patchItem('instructions', staff, 'pat-1', instruction.id, { content: 'x' })).status, 428);

    const ok = await patchItem('instructions', staff, 'pat-1', instruction.id, { content: 'primeira', important: true }, 1);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.instruction.version, 2);
    assert.equal(ok.body.instruction.important, true);
    assert.equal(ok.body.instruction.title, 'Conflito area2');

    const stale = await patchItem('instructions', staff, 'pat-1', instruction.id, { content: 'atrasada' }, 1);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.current.version, 2);
    assert.equal((await instructionOf(staff, 'pat-1', instruction.id)).content, 'primeira');
  });

  it('regravar os mesmos valores nao sobe a versao', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const { instruction } = (await postItem('instructions', staff, 'pat-1', instrBody({ title: 'Igual area2' }))).body;
    const same = await patchItem('instructions', staff, 'pat-1', instruction.id, { title: 'Igual area2' }, instruction.version);
    assert.equal(same.status, 200);
    assert.equal(same.body.instruction.version, instruction.version);
  });

  it('apagar exige a versao; instrucao inexistente responde 404', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const { instruction } = (await postItem('instructions', staff, 'pat-1', instrBody({ title: 'Apagar area2' }))).body;
    assert.equal((await deleteItem('instructions', staff, 'pat-1', instruction.id)).status, 428);
    assert.equal((await patchItem('instructions', staff, 'pat-1', instruction.id, { content: 'y' }, 1)).status, 200);
    assert.equal((await deleteItem('instructions', staff, 'pat-1', instruction.id, 1)).status, 409);
    assert.ok(await instructionOf(staff, 'pat-1', instruction.id));
    assert.equal((await deleteItem('instructions', staff, 'pat-1', instruction.id, 2)).status, 200);
    assert.equal(await instructionOf(staff, 'pat-1', instruction.id), undefined);
    assert.equal((await deleteItem('instructions', staff, 'pat-1', 'inst-que-nao-existe', 1)).status, 404);
  });
});


// ---------------------------------------------------------------------------
// Fase 2, area 3b: cadastro de paciente por chamadas proprias (criar, editar com
// If-Match, apagar, trocar a senha) e equipe definida so pelo admin.

const newPatient = (over = {}) => ({
  name: 'Paciente 3b', email: `p3b-${Math.random().toString(36).slice(2, 9)}@email.com`, password: 'senha-3b-ok',
  age: 41, gender: 'Feminino', phone: '(11) 90000-0000', cpf: '000.000.000-00', procedure: 'Abdominoplastia',
  surgeryDate: '2026-11-01', dischargeDate: '2026-11-03', hospital: 'Hospital X', ...over
});
const postPatient = (token, body) => call('/api/patients', { method: 'POST', token, body });
const ifMatch = version => (version === undefined ? {} : { 'If-Match': String(version) });
const patchPatient = (token, id, body, version) => call(`/api/patients/${id}`, { method: 'PATCH', token, body, headers: ifMatch(version) });
const deletePatient = (token, id, version) => call(`/api/patients/${id}`, { method: 'DELETE', token, headers: ifMatch(version) });
const putPassword = (token, id, body) => call(`/api/patients/${id}/password`, { method: 'PUT', token, body });
const putTeam = (token, id, body) => call(`/api/patients/${id}/care-team`, { method: 'PUT', token, body });
const visibleIds = async token => (await staffState(token)).patients.map(patient => patient.id);
const loginAs = (username, password, ip) => call('/api/auth/login', { method: 'POST', ip, body: { username, password } });

describe('Fase 2 / area 3b: criar paciente', () => {
  before(() => ensureOutsider());

  it('o profissional cria; id, versao, status e dia de pos-operatorio vem do servidor, e ele entra na equipe', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const created = await postPatient(staff, { ...newPatient(), id: 'pat-forjado', version: 9, status: 'critico', postOpDay: 99 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { patient } = created.body;
    assert.notEqual(patient.id, 'pat-forjado');
    assert.equal(patient.version, 1);
    assert.equal(patient.status, 'estavel');
    const expectedDay = Math.max(0, Math.floor((Date.now() - new Date('2026-11-01T12:00:00').getTime()) / 86_400_000));
    assert.ok(Math.abs(patient.postOpDay - expectedDay) <= 1, `postOpDay ${patient.postOpDay} esperado ~${expectedDay}`);
    assert.match(patient.avatar, /^https:\/\/ui-avatars\.com\//);
    assert.deepEqual([patient.timeline, patient.medications, patient.checkIns, patient.messages], [[], [], [], []]);

    assert.ok((await visibleIds(staff)).includes(patient.id), 'o criador nao ve o paciente que criou');
    assert.ok(!(await visibleIds((await login('Helena Duarte')).token)).includes(patient.id), 'um profissional fora da equipe o ve');
    assert.ok((await visibleIds((await login('admin@vivace.med.br')).token)).includes(patient.id));
  });

  it('a senha informada abre o login do paciente novo', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const body = newPatient({ password: 'minha-senha-3b' });
    assert.equal((await postPatient(staff, body)).status, 201);
    const result = await loginAs(body.email, 'minha-senha-3b', '10.9.3.1');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.role, 'patient');
  });

  it('repetir o mesmo clientId nao duplica; e-mail repetido responde 409', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const body = { ...newPatient({ name: 'Idempotente 3b' }), clientId: 'pat-cliente-3b' };
    const first = await postPatient(staff, body);
    const second = await postPatient(staff, body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.patient.id, first.body.patient.id);
    assert.equal((await postPatient(staff, newPatient({ email: body.email }))).status, 409);
    assert.equal((await postPatient(staff, newPatient({ email: 'mariana.souza@email.com' }))).status, 409);
  });

  it('dados invalidos respondem 400', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const invalid = [
      { name: '' }, { name: 'x'.repeat(121) }, { email: 'invalido' }, { email: undefined }, { password: 'curta' },
      { password: undefined }, { age: -1 }, { age: 200 }, { age: 'x' }, { surgeryDate: '2026-13-45' }, { surgeryDate: 'ontem' },
      { cpf: 'x'.repeat(21) }, { avatar: 'javascript:alert(1)' }, { avatar: 'http://inseguro.com/a.png' },
      { avatar: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}` }
    ];
    for (const over of invalid) {
      assert.equal((await postPatient(staff, newPatient(over))).status, 400, `deveria recusar ${JSON.stringify(over).slice(0, 50)}`);
    }
  });

  it('o paciente nao cria (403); o admin cria sem equipe e so ele ve; com professionalIds a equipe passa a ver', async () => {
    assert.equal((await postPatient((await login('mariana')).token, newPatient())).status, 403);
    const admin = (await login('admin@vivace.med.br')).token;
    const orphan = (await postPatient(admin, newPatient({ name: 'Sem equipe 3b' }))).body.patient;
    assert.ok((await visibleIds(admin)).includes(orphan.id));
    assert.ok(!(await visibleIds((await login('Rafaely Carvalho')).token)).includes(orphan.id), 'a equipe ve um paciente sem equipe');

    const withTeam = (await postPatient(admin, { ...newPatient({ name: 'Com equipe 3b' }), professionalIds: ['prof-1'] })).body.patient;
    assert.ok((await visibleIds((await login('Rafaely Carvalho')).token)).includes(withTeam.id));
    assert.ok(!(await visibleIds((await login('Helena Duarte')).token)).includes(withTeam.id));
  });
});

describe('Fase 2 / area 3b: editar e apagar paciente', () => {
  before(() => ensureOutsider());
  const fresh = async name => {
    const staff = (await login('Rafaely Carvalho')).token;
    return { staff, patient: (await postPatient(staff, newPatient({ name }))).body.patient };
  };

  it('editar com a versao certa sobe a versao, muda so o que veio e recalcula o dia de pos-operatorio', async () => {
    const { staff, patient } = await fresh('Edicao 3b');
    const patched = await patchPatient(staff, patient.id, { phone: '(11) 98888-7777', surgeryDate: '2026-11-20', status: 'critico', currentPain: 9, id: 'x', version: 50 }, patient.version);
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const updated = patched.body.patient;
    assert.equal(updated.version, patient.version + 1);
    assert.equal(updated.phone, '(11) 98888-7777');
    assert.equal(updated.name, 'Edicao 3b');
    assert.equal(updated.id, patient.id);
    assert.equal(updated.status, 'estavel', 'o status e do paciente/equipe, nao do cadastro');
    assert.equal(updated.currentPain, 0);
    assert.notEqual(updated.postOpDay, patient.postOpDay, 'o dia de pos-operatorio nao foi recalculado');
  });

  it('sem If-Match 428; versao velha 409 com a atual e sem gravar; mesmos valores nao sobem a versao', async () => {
    const { staff, patient } = await fresh('Conflito 3b');
    assert.equal((await patchPatient(staff, patient.id, { phone: 'x' })).status, 428);
    assert.equal((await patchPatient(staff, patient.id, { phone: 'primeira' }, 1)).status, 200);
    const stale = await patchPatient(staff, patient.id, { phone: 'atrasada' }, 1);
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.current.version, 2);
    assert.equal(stale.body.current.phone, 'primeira');
    const same = await patchPatient(staff, patient.id, { phone: 'primeira' }, 2);
    assert.equal(same.status, 200);
    assert.equal(same.body.patient.version, 2);
  });

  it('e-mail ja usado responde 409; a senha no corpo do PATCH e ignorada', async () => {
    const { staff, patient } = await fresh('Email 3b');
    assert.equal((await patchPatient(staff, patient.id, { email: 'mariana.souza@email.com' }, patient.version)).status, 409);
    const body = newPatient({ name: 'Senha 3b', password: 'senha-original-3b' });
    const created = (await postPatient(staff, body)).body.patient;
    assert.equal((await patchPatient(staff, created.id, { password: 'tentativa-3b-x' }, created.version)).status, 200);
    assert.equal((await loginAs(body.email, 'senha-original-3b', '10.9.3.2')).status, 200, 'a senha original deveria continuar valendo');
  });

  it('paciente 403 e profissional fora da equipe 404', async () => {
    const { patient } = await fresh('Acesso 3b');
    assert.equal((await patchPatient((await login('mariana')).token, patient.id, { phone: 'x' }, 1)).status, 403);
    assert.equal((await patchPatient((await login('Helena Duarte')).token, patient.id, { phone: 'x' }, 1)).status, 404);
    assert.equal((await deletePatient((await login('Helena Duarte')).token, patient.id, 1)).status, 404);
  });

  it('apagar exige a versao: sem ela 428, velha 409 e nao apaga, certa apaga; inexistente 404', async () => {
    const { staff, patient } = await fresh('Apagar 3b');
    assert.equal((await deletePatient(staff, patient.id)).status, 428);
    assert.equal((await patchPatient(staff, patient.id, { phone: 'nova' }, 1)).status, 200);
    assert.equal((await deletePatient(staff, patient.id, 1)).status, 409);
    assert.ok((await visibleIds(staff)).includes(patient.id));
    assert.equal((await deletePatient(staff, patient.id, 2)).status, 200);
    assert.ok(!(await visibleIds(staff)).includes(patient.id));
    assert.equal((await deletePatient(staff, 'pat-que-nao-existe', 1)).status, 404);
  });
});

describe('Fase 2 / area 3b: senha e equipe do paciente', () => {
  before(() => ensureOutsider());

  it('a equipe troca a senha: a nova entra, a antiga nao; senha curta 400; paciente 403; fora da equipe 404', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const body = newPatient({ name: 'Troca senha 3b', password: 'senha-antiga-3b' });
    const { patient } = (await postPatient(staff, body)).body;
    assert.equal((await putPassword(staff, patient.id, { password: 'senha-nova-3b-ok' })).status, 200);
    assert.equal((await loginAs(body.email, 'senha-nova-3b-ok', '10.9.3.3')).status, 200);
    assert.equal((await loginAs(body.email, 'senha-antiga-3b', '10.9.3.4')).status, 401);
    for (const password of ['curta', '', undefined, 12345678]) {
      assert.equal((await putPassword(staff, patient.id, { password })).status, 400, `senha ${JSON.stringify(password)}`);
    }
    assert.equal((await putPassword((await login('mariana')).token, patient.id, { password: 'senha-nova-3b-ok' })).status, 403);
    assert.equal((await putPassword((await login('Helena Duarte')).token, patient.id, { password: 'senha-nova-3b-ok' })).status, 404);
  });

  it('so o admin define a equipe: troca, esvazia, recusa profissional que nao existe', async () => {
    const admin = (await login('admin@vivace.med.br')).token;
    const staff = (await login('Rafaely Carvalho')).token;
    const helena = await ensureOutsider();
    const { patient } = (await postPatient(admin, { ...newPatient({ name: 'Equipe 3b' }), professionalIds: ['prof-1'] })).body;
    assert.equal((await putTeam(staff, patient.id, { professionalIds: [] })).status, 403, 'profissional nao define equipe');
    assert.equal((await putTeam((await login('mariana')).token, patient.id, { professionalIds: [] })).status, 403);
    assert.ok((await visibleIds(staff)).includes(patient.id));

    const emptied = await putTeam(admin, patient.id, { professionalIds: [] });
    assert.equal(emptied.status, 200, JSON.stringify(emptied.body));
    assert.deepEqual(emptied.body.careTeam, []);
    assert.ok(!(await visibleIds(staff)).includes(patient.id), 'a equipe esvaziada continua vendo o paciente');
    assert.ok((await visibleIds(admin)).includes(patient.id));

    const restored = await putTeam(admin, patient.id, { professionalIds: ['prof-1', helena] });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual(restored.body.careTeam, [{ professionalId: 'prof-1', role: 'cirurgiao' }, { professionalId: helena, role: 'equipe' }]);
    assert.ok((await visibleIds(staff)).includes(patient.id));
    assert.ok((await visibleIds((await login('Helena Duarte')).token)).includes(patient.id));

    assert.equal((await putTeam(admin, patient.id, { professionalIds: ['prof-inexistente'] })).status, 404);
    assert.equal((await putTeam(admin, patient.id, { professionalIds: 'prof-1' })).status, 400);
    assert.equal((await putTeam(admin, patient.id, { professionalIds: ['prof-1', 'prof-1'] })).status, 400);
    assert.equal((await putTeam(admin, 'pat-que-nao-existe', { professionalIds: [] })).status, 404);
  });
});

// ---------------------------------------------------------------------------
// Fase 2, areas 4 e 5: profissionais, administradores e status do paciente por
// chamadas proprias.

const api = (method, path, token, body, version) => call(path, { method, token, body, headers: ifMatch(version) });
const newPro = (over = {}) => ({
  name: 'Dra. Teste 45', email: `pro45-${Math.random().toString(36).slice(2, 9)}@vivace.med.br`, password: 'senha-pro-45-ok',
  role: 'Cirurgia Plastica', crmCoren: 'CRM-SP 999.001', specialty: 'Plastica', ...over
});
const newAdmin = (over = {}) => ({
  name: 'Admin Teste 45', email: `adm45-${Math.random().toString(36).slice(2, 9)}@vivace.med.br`, password: 'senha-adm-45-ok', ...over
});

describe('Fase 2 / area 4: profissionais', () => {
  it('o admin cadastra; id e versao vem do servidor, a senha abre o login, e so o admin cadastra', async () => {
    const admin = (await login('admin@vivace.med.br')).token;
    const body = newPro();
    const created = await api('POST', '/api/professionals', admin, { ...body, id: 'prof-forjado', version: 9 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { professional } = created.body;
    assert.notEqual(professional.id, 'prof-forjado');
    assert.equal(professional.version, 1);
    assert.equal(professional.name, 'Dra. Teste 45');
    assert.equal(professional.crmCoren, 'CRM-SP 999.001');
    assert.ok(!('password' in professional) && !('passwordHash' in professional));
    const entered = await loginAs(body.email, body.password, '10.9.4.1');
    assert.equal(entered.status, 200, JSON.stringify(entered.body));
    assert.equal(entered.body.role, 'professional');

    assert.equal((await api('POST', '/api/professionals', (await login('Rafaely Carvalho')).token, newPro())).status, 403);
    assert.equal((await api('POST', '/api/professionals', (await login('mariana')).token, newPro())).status, 403);
  });

  it('clientId nao duplica, e-mail repetido responde 409 e dados invalidos respondem 400', async () => {
    const admin = (await login('admin@vivace.med.br')).token;
    const body = { ...newPro(), clientId: 'prof-cliente-45' };
    const first = await api('POST', '/api/professionals', admin, body);
    const second = await api('POST', '/api/professionals', admin, body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.professional.id, first.body.professional.id);
    assert.equal((await api('POST', '/api/professionals', admin, newPro({ email: body.email }))).status, 409);
    assert.equal((await api('POST', '/api/professionals', admin, newPro({ email: 'rafaely.carvalho@vivace.med.br' }))).status, 409);
    for (const over of [{ name: '' }, { email: 'invalido' }, { password: 'curta' }, { crmCoren: 'x'.repeat(41) }, { role: 7 }, { avatar: 'javascript:alert(1)' }]) {
      assert.equal((await api('POST', '/api/professionals', admin, newPro(over))).status, 400, JSON.stringify(over));
    }
  });

  it('editar com If-Match: 428 sem ele, 409 com a versao velha (e a atual no corpo), 200 e versao igual sem mudanca', async () => {
    const admin = (await login('admin@vivace.med.br')).token;
    const { professional } = (await api('POST', '/api/professionals', admin, newPro())).body;
    assert.equal((await api('PATCH', `/api/professionals/${professional.id}`, admin, { specialty: 'x' })).status, 428);
    const patched = await api('PATCH', `/api/professionals/${professional.id}`, admin, { specialty: 'Cirurgia', id: 'x', version: 50 }, 1);
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.professional.version, 2);
    assert.equal(patched.body.professional.specialty, 'Cirurgia');
    const stale = await api('PATCH', `/api/professionals/${professional.id}`, admin, { specialty: 'atrasada' }, 1);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.current.version, 2);
    const same = await api('PATCH', `/api/professionals/${professional.id}`, admin, { specialty: 'Cirurgia' }, 2);
    assert.equal(same.body.professional.version, 2);
    assert.equal((await api('PATCH', '/api/professionals/prof-que-nao-existe', admin, { specialty: 'x' }, 1)).status, 404);
    assert.equal((await api('PATCH', `/api/professionals/${professional.id}`, (await login('Rafaely Carvalho')).token, { specialty: 'x' }, 2)).status, 403);
  });

  it('apagar: exige If-Match, avisa quais pacientes ficaram sem equipe, a equipe some e as sessoes dele acabam', async () => {
    const admin = (await login('admin@vivace.med.br')).token;
    const body = newPro();
    const { professional } = (await api('POST', '/api/professionals', admin, body)).body;
    const { patient } = (await api('POST', '/api/patients', admin, { ...newPatient({ name: 'Do profissional 45' }), professionalIds: [professional.id] })).body;
    const proToken = (await loginAs(body.email, body.password, '10.9.4.2')).body.token;
    assert.ok((await visibleIds(proToken)).includes(patient.id));

    assert.equal((await api('DELETE', `/api/professionals/${professional.id}`, admin)).status, 428);
    assert.equal((await api('DELETE', `/api/professionals/${professional.id}`, admin, undefined, 99)).status, 409);
    const removed = await api('DELETE', `/api/professionals/${professional.id}`, admin, undefined, 1);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body.patientsWithoutTeam, [patient.id]);
    assert.equal((await call('/api/state', { token: proToken })).status, 401, 'a sessao do profissional apagado continua valendo');
    assert.ok((await visibleIds(admin)).includes(patient.id));
    assert.ok(!(await visibleIds((await login('Rafaely Carvalho')).token)).includes(patient.id));
    assert.equal((await api('DELETE', '/api/professionals/prof-que-nao-existe', admin, undefined, 1)).status, 404);
  });

  it('a senha: o admin troca, a nova entra e a antiga nao; senha curta 400; outro papel 403', async () => {
    const admin = (await login('admin@vivace.med.br')).token;
    const body = newPro({ password: 'senha-antiga-45' });
    const { professional } = (await api('POST', '/api/professionals', admin, body)).body;
    assert.equal((await api('PUT', `/api/professionals/${professional.id}/password`, admin, { password: 'senha-nova-45-ok' })).status, 200);
    assert.equal((await loginAs(body.email, 'senha-nova-45-ok', '10.9.4.3')).status, 200);
    assert.equal((await loginAs(body.email, 'senha-antiga-45', '10.9.4.4')).status, 401);
    assert.equal((await api('PUT', `/api/professionals/${professional.id}/password`, admin, { password: 'curta' })).status, 400);
    assert.equal((await api('PUT', `/api/professionals/${professional.id}/password`, (await login('Rafaely Carvalho')).token, { password: 'senha-nova-45-ok' })).status, 403);
  });
});

describe('Fase 2 / area 4: administradores', () => {
  it('cria, edita com If-Match e apaga; so o admin; e nunca apaga o ultimo', async () => {
    const admin = (await login('admin@vivace.med.br')).token;
    const body = newAdmin();
    const created = await api('POST', '/api/admins', admin, { ...body, id: 'adm-forjado', version: 9 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const second = created.body.admin;
    assert.notEqual(second.id, 'adm-forjado');
    assert.equal(second.version, 1);
    assert.equal((await loginAs(body.email, body.password, '10.9.4.5')).body.role, 'admin');

    assert.equal((await api('POST', '/api/admins', (await login('Rafaely Carvalho')).token, newAdmin())).status, 403);
    assert.equal((await api('PATCH', `/api/admins/${second.id}`, admin, { name: 'x' })).status, 428);
    const patched = await api('PATCH', `/api/admins/${second.id}`, admin, { name: 'Renomeado 45' }, 1);
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.admin.version, 2);
    assert.equal((await api('PATCH', `/api/admins/${second.id}`, admin, { name: 'atrasado' }, 1)).status, 409);
    assert.equal((await api('POST', '/api/admins', admin, newAdmin({ email: body.email }))).status, 409);
    assert.equal((await api('POST', '/api/admins', admin, newAdmin({ password: 'curta' }))).status, 400);

    assert.equal((await api('DELETE', `/api/admins/${second.id}`, admin, undefined, 2)).status, 200);
    assert.equal((await loginAs(body.email, body.password, '10.9.4.6')).status, 401);

    // Sobrou um so: apagar este deixaria o sistema sem ninguem para administrar.
    const [only] = (await staffState(admin)).admins;
    const refused = await api('DELETE', `/api/admins/${only.id}`, admin, undefined, only.version);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal((await staffState(admin)).admins.length, 1);
  });

  it('a senha de um administrador troca por chamada propria', async () => {
    const admin = (await login('admin@vivace.med.br')).token;
    const body = newAdmin({ password: 'senha-antiga-adm' });
    const { admin: created } = (await api('POST', '/api/admins', admin, body)).body;
    assert.equal((await api('PUT', `/api/admins/${created.id}/password`, admin, { password: 'senha-nova-adm-ok' })).status, 200);
    assert.equal((await loginAs(body.email, 'senha-nova-adm-ok', '10.9.4.7')).status, 200);
    assert.equal((await api('DELETE', `/api/admins/${created.id}`, admin, undefined, 1)).status, 200);
  });
});

describe('Super administrador', () => {
  it('so o super cria, apaga e promove administradores; o admin comum edita so a propria conta', async () => {
    const root = (await login('admin@vivace.med.br')).token;
    assert.equal((await staffState(root)).admins.find(item => item.id === 'adm-1').isSuper, true);

    const body = newAdmin();
    const { admin: common } = (await api('POST', '/api/admins', root, body)).body;
    assert.equal(common.isSuper, false, 'quem nasce sem pedir nao e super');
    const commonToken = (await loginAs(body.email, body.password, '10.9.5.1')).body.token;

    assert.equal((await api('POST', '/api/admins', commonToken, newAdmin())).status, 403);
    assert.equal((await api('DELETE', `/api/admins/${common.id}`, commonToken, undefined, common.version)).status, 403);
    assert.equal((await api('PATCH', '/api/admins/adm-1', commonToken, { name: 'invadido' }, 1)).status, 403);
    assert.equal((await api('PUT', '/api/admins/adm-1/password', commonToken, { password: 'senha-invasora-1' })).status, 403);
    assert.equal((await api('PATCH', `/api/admins/${common.id}`, commonToken, { isSuper: true }, common.version)).status, 403, 'ninguem se promove');

    const own = await api('PATCH', `/api/admins/${common.id}`, commonToken, { name: 'Eu mesmo' }, common.version);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal((await api('PUT', `/api/admins/${common.id}/password`, commonToken, { password: 'minha-senha-nova-1' })).status, 200);

    const promoted = await api('PATCH', `/api/admins/${common.id}`, root, { isSuper: true }, own.body.admin.version);
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    assert.equal(promoted.body.admin.isSuper, true);
    assert.equal((await api('DELETE', `/api/admins/${common.id}`, root, undefined, promoted.body.admin.version)).status, 200);
  });

  it('a foto do administrador: comeca vazia, o proprio admin troca e remove, e foto invalida 400', async () => {
    const root = (await login('admin@vivace.med.br')).token;
    const body = newAdmin();
    const { admin: created } = (await api('POST', '/api/admins', root, body)).body;
    assert.equal(created.avatar, '');
    const token = (await loginAs(body.email, body.password, '10.9.5.2')).body.token;
    const photo = 'https://exemplo.com/foto.png';
    const set = await api('PATCH', `/api/admins/${created.id}`, token, { avatar: photo }, created.version);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.admin.avatar, photo);
    assert.equal((await api('PATCH', `/api/admins/${created.id}`, token, { avatar: 'javascript:alert(1)' }, set.body.admin.version)).status, 400);
    const cleared = await api('PATCH', `/api/admins/${created.id}`, token, { avatar: '' }, set.body.admin.version);
    assert.equal(cleared.body.admin.avatar, '', 'sem foto o admin continua sem foto (nao ganha a padrao)');
    assert.equal((await api('DELETE', `/api/admins/${created.id}`, root, undefined, cleared.body.admin.version)).status, 200);
  });

  it('nunca fica sem super admin: nao apaga nem rebaixa o ultimo', async () => {
    const root = (await login('admin@vivace.med.br')).token;
    const { admins } = await staffState(root);
    const supers = admins.filter(item => item.isSuper);
    assert.equal(supers.length, 1);
    const [only] = supers;
    const demote = await api('PATCH', `/api/admins/${only.id}`, root, { isSuper: false }, only.version);
    assert.equal(demote.status, 409, JSON.stringify(demote.body));
    const remove = await api('DELETE', `/api/admins/${only.id}`, root, undefined, only.version);
    assert.equal(remove.status, 409, JSON.stringify(remove.body));
    assert.equal((await staffState(root)).admins.find(item => item.id === only.id).isSuper, true);
  });
});

describe('Fase 2 / area 5: status do paciente', () => {
  before(() => ensureOutsider());

  it('a equipe define o status; valores invalidos 400; paciente 403; fora da equipe 404', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    const { patient } = (await api('POST', '/api/patients', staff, newPatient({ name: 'Status 45' }))).body;
    const set = await api('PUT', `/api/patients/${patient.id}/status`, staff, { status: 'critico' });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.status, 'critico');
    assert.equal(patientOf(await staffState(staff), patient.id).status, 'critico');
    assert.equal((await api('PUT', `/api/patients/${patient.id}/status`, staff, { status: 'atencao' })).status, 200);

    for (const status of ['grave', '', undefined, null, 3]) {
      assert.equal((await api('PUT', `/api/patients/${patient.id}/status`, staff, { status })).status, 400, JSON.stringify(status));
    }
    assert.equal(patientOf(await staffState(staff), patient.id).status, 'atencao');
    assert.equal((await api('PUT', `/api/patients/${patient.id}/status`, (await login('mariana')).token, { status: 'estavel' })).status, 403);
    assert.equal((await api('PUT', `/api/patients/${patient.id}/status`, (await login('Helena Duarte')).token, { status: 'estavel' })).status, 404);
    assert.equal((await api('PUT', '/api/patients/pat-que-nao-existe/status', staff, { status: 'estavel' })).status, 404);
  });

  it('um check-in do paciente recalcula o status pela dor e temperatura, como antes', async () => {
    const staff = (await login('Rafaely Carvalho')).token;
    assert.equal((await api('PUT', '/api/patients/pat-1/status', staff, { status: 'estavel' })).status, 200);
    const sent = await call('/api/checkins', {
      method: 'POST', token: (await login('mariana')).token,
      body: { id: 'chk-45-status', checkIn: { painLevel: 8, temperature: 36.6, mobilityScore: 'repouso_absoluto', symptoms: [], notes: '', mood: 'mal' } }
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(patientOf(await staffState(staff), 'pat-1').status, 'critico');
  });
});

describe('Check-in diario: um por dia, sem refazer', () => {
  const body = id => ({ id, checkIn: { painLevel: 2, temperature: 36.6, symptoms: [], notes: '', mood: 'bem' } });
  const send = (token, id) => call('/api/checkins', { method: 'POST', token, keepToday: true, body: body(id) });
  const countToday = async () => (await withSession(pool, adminSession, client => client.query(
    "SELECT count(*)::int AS total FROM check_ins WHERE patient_id = 'pat-1' AND date = $1", [todayLabel()]))).rows[0].total;

  it('o segundo check-in do mesmo dia responde 409 e nao grava', async () => {
    await clearToday();
    const token = (await login('mariana')).token;
    assert.equal((await send(token, 'chk-dia-1')).status, 201);
    const second = await send(token, 'chk-dia-2');
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.match(second.body.error, /check-in de hoje/);
    assert.equal(await countToday(), 1);
  });

  it('repetir o mesmo envio (mesmo id) continua valendo e nao duplica', async () => {
    await clearToday();
    const token = (await login('mariana')).token;
    assert.equal((await send(token, 'chk-dia-3')).status, 201);
    assert.equal((await send(token, 'chk-dia-3')).status, 201);
    assert.equal(await countToday(), 1);
  });

  it('envios simultaneos gravam um so', async () => {
    await clearToday();
    const token = (await login('mariana')).token;
    const results = await Promise.all(['chk-par-a', 'chk-par-b', 'chk-par-c'].map(id => send(token, id)));
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409, 409]);
    assert.equal(await countToday(), 1);
  });

  it('no dia seguinte o paciente volta a poder fazer', async () => {
    await clearToday();
    const token = (await login('mariana')).token;
    assert.equal((await send(token, 'chk-dia-4')).status, 201);
    await withSession(pool, adminSession, client => client.query("UPDATE check_ins SET date = '01/01/2020' WHERE patient_id = 'pat-1' AND id = 'chk-dia-4'"));
    assert.equal((await send(token, 'chk-dia-5')).status, 201);
    await withSession(pool, adminSession, client => client.query("DELETE FROM check_ins WHERE patient_id = 'pat-1' AND date = '01/01/2020'"));
  });
});

describe('Dose tomada: so o paciente marca, e so vale no dia', () => {
  const firstSlot = async token => {
    const medication = (await call('/api/state', { token })).body.patients[0].medications[0];
    return { medicationId: medication.id, time: medication.times[0] };
  };
  const takenNow = async token => {
    const { medicationId, time } = await firstSlot(token);
    return (await call('/api/state', { token })).body.patients[0].medications.find(item => item.id === medicationId).takenToday[time];
  };

  it('a equipe nao marca dose por ele: 403', async () => {
    const patientToken = (await login('mariana')).token;
    const slot = await firstSlot(patientToken);
    const staff = (await login('Rafaely Carvalho')).token;
    assert.equal((await call('/api/medication-taken', { method: 'POST', token: staff, body: { patientId: 'pat-1', ...slot } })).status, 403);
    const admin = (await login('admin@vivace.med.br')).token;
    assert.equal((await call('/api/medication-taken', { method: 'POST', token: admin, body: { patientId: 'pat-1', ...slot } })).status, 403);
  });

  it('o paciente marca e desmarca a dose de hoje', async () => {
    const token = (await login('mariana')).token;
    const slot = await firstSlot(token);
    const before = await takenNow(token);
    assert.equal((await call('/api/medication-taken', { method: 'POST', token, body: slot })).status, 200);
    assert.equal(await takenNow(token), !before);
    assert.equal((await call('/api/medication-taken', { method: 'POST', token, body: slot })).status, 200);
    assert.equal(await takenNow(token), before);
  });

  it('a marca de outro dia nao aparece como tomada, e clicar marca a de hoje', async () => {
    const token = (await login('mariana')).token;
    const slot = await firstSlot(token);
    await withSession(pool, adminSession, client => client.query(
      "UPDATE medication_doses SET taken = true, taken_on = '2020-01-01' WHERE patient_id = 'pat-1' AND medication_id = $1 AND time = $2",
      [slot.medicationId, slot.time]));
    assert.equal(await takenNow(token), false, 'a marca antiga apareceu como tomada hoje');
    assert.equal((await call('/api/medication-taken', { method: 'POST', token, body: slot })).status, 200);
    assert.equal(await takenNow(token), true);
  });

  it('dose antiga marcada sem dia (anterior a migracao 020): clicar marca hoje, nao da erro', async () => {
    const token = (await login('mariana')).token;
    const slot = await firstSlot(token);
    await withSession(pool, adminSession, client => client.query(
      "UPDATE medication_doses SET taken = true, taken_on = NULL WHERE patient_id = 'pat-1' AND medication_id = $1 AND time = $2",
      [slot.medicationId, slot.time]));
    assert.equal(await takenNow(token), false, 'a marca sem dia apareceu como tomada');
    assert.equal((await call('/api/medication-taken', { method: 'POST', token, body: slot })).status, 200);
    assert.equal(await takenNow(token), true);
  });
});

describe('Saturacao no check-in e reabertura do check-in pela equipe', () => {
  const body = (id, extra = {}) => ({
    id, patientId: 'pat-1',
    checkIn: { dayLabel: 'D+9', painLevel: 2, temperature: 36.6, mobilityScore: 'caminha_bem', symptoms: [], notes: '', mood: 'bem', ...extra }
  });
  const send = (token, id, extra, keepToday = true) => call('/api/checkins', { method: 'POST', token, keepToday, body: body(id, extra) });

  it('guarda a saturacao no check-in e no paciente', async () => {
    const token = (await login('mariana')).token;
    const result = await call('/api/checkins', { method: 'POST', token, body: body('chk-spo2-ok', { spo2: 97 }) });
    assert.equal(result.status, 201);
    assert.equal(result.body.patient.currentSpo2, 97);
    assert.equal(result.body.patient.checkIns[0].spo2, 97);
    assert.equal(result.body.patient.status, 'estavel');
  });

  it('abaixo de 90% o paciente fica critico, de 90 a 94% em atencao', async () => {
    const token = (await login('mariana')).token;
    const low = await call('/api/checkins', { method: 'POST', token, body: body('chk-spo2-88', { spo2: 88 }) });
    assert.equal(low.body.patient.status, 'critico');
    const mid = await call('/api/checkins', { method: 'POST', token, body: body('chk-spo2-92', { spo2: 92 }) });
    assert.equal(mid.body.patient.status, 'atencao');
  });

  it('sem saturacao o check-in vale e o ultimo valor continua', async () => {
    const token = (await login('mariana')).token;
    await call('/api/checkins', { method: 'POST', token, body: body('chk-spo2-first', { spo2: 96 }) });
    const result = await call('/api/checkins', { method: 'POST', token, body: body('chk-spo2-none') });
    assert.equal(result.status, 201);
    assert.equal(result.body.patient.checkIns[0].spo2, null);
    assert.equal(result.body.patient.currentSpo2, 96);
  });

  it('saturacao fora de 50 a 100 ou nao inteira: 400', async () => {
    const token = (await login('mariana')).token;
    for (const spo2 of [49, 101, 90.5, 'abc']) {
      assert.equal((await call('/api/checkins', { method: 'POST', token, body: body(`chk-spo2-bad-${spo2}`, { spo2 }) })).status, 400, `spo2 ${spo2}`);
    }
  });

  it('o check-in de hoje so reabre pela equipe, e o historico guarda os dois', async () => {
    const patient = (await login('mariana')).token;
    const staff = (await login('Rafaely Carvalho')).token;
    assert.equal((await call('/api/checkins', { method: 'POST', token: patient, body: body('chk-reopen-1') })).status, 201);

    const again = await send(patient, 'chk-reopen-2');
    assert.equal(again.status, 409);
    assert.match(again.body.error, /reabri/i);

    assert.equal((await call('/api/patients/pat-1/check-in/reopen', { method: 'POST', token: patient })).status, 403);

    const reopened = await call('/api/patients/pat-1/check-in/reopen', { method: 'POST', token: staff });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.patient.checkInReopened, true);
    assert.equal(reopened.body.patient.timeline.at(-1).title, 'Check-in reaberto');
    const seen = (await call('/api/state', { token: patient })).body.patients[0];
    assert.equal(seen.checkInReopened, true, 'o paciente tem que ver o check-in reaberto');

    const second = await send(patient, 'chk-reopen-2', { painLevel: 3 });
    assert.equal(second.status, 201);
    assert.equal(second.body.patient.checkInReopened, false);
    const ids = second.body.patient.checkIns.map(item => item.id);
    assert.ok(ids.includes('chk-reopen-1') && ids.includes('chk-reopen-2'), 'o envio anterior sumiu');
    assert.equal(ids[0], 'chk-reopen-2');

    assert.equal((await send(patient, 'chk-reopen-3')).status, 409, 'reabrir libera so mais um envio');
  });
});
