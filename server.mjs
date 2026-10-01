import { createServer } from 'node:http';
import { randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as store from './db/store.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const apiPort = Number(process.env.VIVACE_API_PORT ?? 3001);
const frontendPort = Number(process.env.VIVACE_FRONTEND_PORT ?? 3000);
const sessionTtlMs = Number(process.env.VIVACE_SESSION_TTL_MS ?? 8 * 60 * 60 * 1000);
const loginMaxAttempts = Math.max(1, Number(process.env.VIVACE_LOGIN_MAX_ATTEMPTS ?? 5));
const loginWindowMs = Math.max(1, Number(process.env.VIVACE_LOGIN_WINDOW_MS ?? 15 * 60 * 1000));
const loginLockoutMs = Math.max(1, Number(process.env.VIVACE_LOGIN_LOCKOUT_MS ?? 15 * 60 * 1000));
const extraOrigins = (process.env.VIVACE_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const eventClients = new Map();

const scrypt = (password, salt) => new Promise((resolve, reject) => {
  scryptCallback(password, salt, 64, (error, key) => (error ? reject(error) : resolve(key)));
});

const normalize = value => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const verifyPassword = async (password, stored) => {
  if (typeof stored !== 'string' || !stored) return false;
  if (!stored.startsWith('scrypt$')) return normalize(password) === normalize(stored);
  const [, salt, expected] = stored.split('$');
  if (!salt || !expected) return false;
  const key = await scrypt(password, salt);
  const expectedKey = Buffer.from(expected, 'hex');
  return key.length === expectedKey.length && timingSafeEqual(key, expectedKey);
};

const decoySalt = 'vivace-login-decoy';

// Gasta o mesmo tempo de scrypt quando não há hash para comparar, para que o
// tempo de resposta não revele se o usuário existe.
const burnScrypt = async password => {
  await scrypt(password, decoySalt);
};

const newSessionToken = () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

const createSession = account => store.createSession({ ...account, token: newSessionToken(), ttlMs: sessionTtlMs });

const bearerToken = request => {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

const sessionTokenFromUrl = url => new URL(url, 'http://localhost').searchParams.get('token') ?? '';

// EventSource não manda cabeçalho de autorização, então o token também chega por
// ?token= na URL. Ler dos dois aqui evita que cada rota repita o par.
const requestToken = request => bearerToken(request) || sessionTokenFromUrl(request.url);

// Assíncrono porque a sessão está no Postgres, e o que volta já vem filtrado
// por expires_at: se o token não existe ou venceu, findSession devolve null e não
// há expiresAt para o Node conferir. A expiração é absoluta, então este caminho
// não escreve nada.
const authenticate = async request => {
  const token = requestToken(request);
  return token ? store.findSession(token) : null;
};

const clientAddress = request => {
  const forwarded = request.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (value) return String(value).split(',')[0].trim();
  return request.socket.remoteAddress ?? 'desconhecido';
};

const loginKeys = (request, identifier) => [
  `ip:${clientAddress(request)}`,
  `conta:${normalize(identifier)}`
];

const humanizeWait = milliseconds => {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return `${seconds} segundo${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minuto${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hora${hours === 1 ? '' : 's'}`;
};

// A contagem mora no banco, não em um Map. A janela, o teto e a espera do
// bloqueio continuam lidos do .env: são política do servidor, não do schema.
const lockoutPolicy = { windowMs: loginWindowMs, lockoutMs: loginLockoutMs, maxAttempts: loginMaxAttempts };

// O timer que varria o Map virou um DELETE indexado. Continua unref(), para não
// segurar o processo aberto, e o .catch evita que uma falha de limpeza derrube o
// servidor: perder a limpeza custa uma linha obsoleta, não disponibilidade.
const sweepAuth = () => {
  void store.purgeExpiredAuth(loginWindowMs).catch(error => console.error('Falha ao limpar sessões:', error));
};

setInterval(sweepAuth, loginWindowMs).unref();

const allowedOrigin = request => {
  const origin = request.headers.origin;
  if (!origin) return null;
  if (extraOrigins.includes(origin)) return origin;
  try {
    const { hostname } = new URL(origin);
    const host = (request.headers.host ?? '').split(':')[0];
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === host ? origin : null;
  } catch {
    return null;
  }
};

const json = (request, response, status, value, extraHeaders = {}) => {
  const origin = allowedOrigin(request);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
    ...extraHeaders
  };
  if (origin) {
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Allow-Methods'] = 'GET, PUT, POST, DELETE, OPTIONS';
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Expose-Headers'] = 'Retry-After';
  }
  response.writeHead(status, headers);
  response.end(value === undefined ? undefined : JSON.stringify(value));
};

const unauthorized = (request, response) => json(request, response, 401, { error: 'Authentication required' });
const forbidden = (request, response) => json(request, response, 403, { error: 'Insufficient permissions' });

const readBody = request => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  request.on('data', chunk => {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) {
      reject(new Error('Payload too large'));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  request.on('error', reject);
});

const bootstrapAdmin = async () => store.bootstrapAdmin({
  id: 'adm-1',
  name: 'Administrador',
  email: process.env.VIVACE_BOOTSTRAP_EMAIL ?? 'admin@vivace.med.br',
  password: process.env.VIVACE_BOOTSTRAP_PASSWORD ?? 'vivace-demo'
});

// A conta de administracao nasce no primeiro acesso, quando o banco esta vazio
// de contas. A busca por conta seguinte e app_lookup_account, no banco.
const ensureBootstrapAdmin = async () => {
  if (await store.hasAnyAccount()) return false;
  await bootstrapAdmin();
  return true;
};

const publish = event => {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const [client, clientSession] of eventClients) {
    if (clientSession.role === 'patient' && event.patientId !== clientSession.userId) continue;
    client.write(payload);
  }
};

const api = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'OPTIONS') {
    json(request, response, 204);
    return;
  }

  if (pathname === '/api/auth/login' && request.method === 'POST') {
    try {
      const input = JSON.parse(await readBody(request));
      const identifier = typeof input.username === 'string' ? input.username.trim() : '';
      const password = typeof input.password === 'string' ? input.password : '';
      if (!identifier || !password) {
        json(request, response, 400, { error: 'Informe usuário e senha' });
        return;
      }
      const keys = loginKeys(request, identifier);
      const lockedFor = await store.loginLockoutRemaining(keys);
      if (lockedFor > 0) {
        // O mesmo scrypt que o caminho 401 gasta. Sem esta linha, o 429 saía em
        // poucos milissegundos e o tempo de resposta denunciava que a conta
        // existe e está bloqueada, desfazendo o que o burnScrypt existe para
        // impedir.
        await burnScrypt(password);
        const retryAfter = Math.ceil(lockedFor / 1000);
        console.log(`Login bloqueado por ${lockedFor}ms para ${identifier} (${clientAddress(request)})`);
        json(request, response, 429, {
          error: `Muitas tentativas de login. Tente novamente em ${humanizeWait(lockedFor)}.`
        }, { 'Retry-After': String(retryAfter) });
        return;
      }
      if (await ensureBootstrapAdmin()) {
        console.log('Conta de administrador inicial criada');
      }
      const account = await store.findAccount(identifier);
      if (!account) {
        await burnScrypt(password);
        await store.recordLoginFailure(keys, lockoutPolicy);
        json(request, response, 401, { error: 'Usuário ou senha inválidos' });
        return;
      }
      const stored = account.passwordHash;
      const hashed = typeof stored === 'string' && stored.startsWith('scrypt$');
      const valid = await verifyPassword(password, stored);
      if (!hashed) await burnScrypt(password);
      if (!valid) {
        await store.recordLoginFailure(keys, lockoutPolicy);
        json(request, response, 401, { error: 'Usuário ou senha inválidos' });
        return;
      }
      await store.clearLoginFailures(keys);
      // Senha antiga em texto plano vira scrypt no primeiro login valido.
      if (!hashed) await store.rehashAccount(account, password);
      const token = await createSession({ role: account.role, userId: account.userId, name: account.name });
      json(request, response, 200, {
        token,
        role: account.role,
        patientId: account.role === 'patient' ? account.userId : null,
        name: account.name
      });
    } catch (error) {
      console.error('Login API error:', error);
      json(request, response, 500, { error: 'Não foi possível autenticar' });
    }
    return;
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    await store.deleteSession(requestToken(request));
    json(request, response, 200, { loggedOut: true });
    return;
  }

  if (pathname === '/api/events' && request.method === 'GET') {
    const session = await authenticate(request);
    if (!session) {
      json(request, response, 401, { error: 'Authentication required' });
      return;
    }
    const origin = allowedOrigin(request);
    response.writeHead(200, {
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Vary': 'Origin'
    });
    response.write(': connected\n\n');
    eventClients.set(response, session);
    request.on('close', () => eventClients.delete(response));
    return;
  }

  if (pathname === '/api/messages' && request.method === 'POST') {
    const session = await authenticate(request);
    if (!session) {
      unauthorized(request, response);
      return;
    }
    try {
      const input = JSON.parse(await readBody(request));
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!input.patientId || !text || text.length > 2_000) {
        json(request, response, 400, { error: 'Invalid message' });
        return;
      }
      if (session.role === 'patient' && input.patientId !== session.userId) {
        forbidden(request, response);
        return;
      }
      const sender = session.role === 'patient' ? 'paciente' : 'equipe';
      const senderName = session.role === 'patient'
        ? session.name
        : typeof input.senderName === 'string' && input.senderName.trim() ? input.senderName.trim() : session.name;
      const message = await store.insertMessage(session, {
        patientId: input.patientId,
        text,
        sender,
        senderName,
        clientMessageId: input.clientMessageId
      });
      json(request, response, 201, { message });
      publish({ type: 'message.created', patientId: input.patientId, message });
    } catch (error) {
      console.error('Message API error:', error);
      json(request, response, error.statusCode ?? 500, { error: error.statusCode === 404 ? 'Patient not found' : 'Could not persist message' });
    }
    return;
  }

  if (pathname === '/api/checkins' && request.method === 'POST') {
    const session = await authenticate(request);
    if (!session) {
      unauthorized(request, response);
      return;
    }
    try {
      const input = JSON.parse(await readBody(request));
      const patientId = session.role === 'patient' ? session.userId : input.patientId;
      const payload = input.checkIn;
      const painLevel = Number(payload?.painLevel);
      const temperature = Number(payload?.temperature);
      if (!patientId || !payload || !Number.isFinite(painLevel) || painLevel < 0 || painLevel > 10
        || !Number.isFinite(temperature) || temperature < 25 || temperature > 45) {
        json(request, response, 400, { error: 'Invalid check-in' });
        return;
      }
      const checkIn = {
        id: typeof input.id === 'string' && input.id ? input.id : `chk-${randomUUID()}`,
        painLevel,
        temperature,
        mobilityScore: typeof payload.mobilityScore === 'string' ? payload.mobilityScore : 'repouso_absoluto',
        symptoms: Array.isArray(payload.symptoms) ? payload.symptoms.filter(item => typeof item === 'string').slice(0, 12) : [],
        notes: typeof payload.notes === 'string' ? payload.notes.slice(0, 1_000) : '',
        mood: typeof payload.mood === 'string' ? payload.mood : 'bem',
        dayLabel: typeof payload.dayLabel === 'string' ? payload.dayLabel : undefined,
        photoUploaded: Boolean(input.photo?.imageUrl)
      };
      const photo = typeof input.photo?.imageUrl === 'string' && input.photo.imageUrl.startsWith('data:image/')
        ? { imageUrl: input.photo.imageUrl, patientNotes: typeof input.photo.patientNotes === 'string' ? input.photo.patientNotes.slice(0, 1_000) : '', id: typeof input.photo.id === 'string' ? input.photo.id : undefined }
        : undefined;
      const savedPatient = await store.insertCheckIn(session, { patientId, checkIn, photo });
      json(request, response, 201, { patient: savedPatient });
      publish({ type: 'checkin.created', patientId, checkIn });
    } catch (error) {
      console.error('Check-in API error:', error);
      json(request, response, error.statusCode ?? 500, { error: error.statusCode === 404 ? 'Patient not found' : 'Could not save check-in' });
    }
    return;
  }

  if (pathname === '/api/medication-taken' && request.method === 'POST') {
    const session = await authenticate(request);
    if (!session) {
      unauthorized(request, response);
      return;
    }
    try {
      const input = JSON.parse(await readBody(request));
      const patientId = session.role === 'patient' ? session.userId : input.patientId;
      if (!patientId || typeof input.medicationId !== 'string' || typeof input.time !== 'string') {
        json(request, response, 400, { error: 'Invalid medication confirmation' });
        return;
      }
      const savedPatient = await store.toggleMedicationTaken(session, {
        patientId,
        medicationId: input.medicationId,
        time: input.time
      });
      json(request, response, 200, { patient: savedPatient });
      publish({ type: 'medication.updated', patientId });
    } catch (error) {
      console.error('Medication API error:', error);
      json(request, response, error.statusCode ?? 500, { error: error.statusCode === 404 ? 'Patient not found' : 'Could not save confirmation' });
    }
    return;
  }

  if (pathname !== '/api/state') {
    json(request, response, 404, { error: 'Not found' });
    return;
  }

  const session = await authenticate(request);
  if (!session) {
    unauthorized(request, response);
    return;
  }

  try {
    if (request.method === 'GET') {
      // O RLS ja filtrou: o que a sessao nao pode ver nao volta, e nao ha mais
      // sanitizePatient nem patientsForSession haciendo isso no JS. Nota
      // clinica tambem nao volta para papel de paciente, porque a policy nao
      // entrega a linha.
      const state = await store.readState(session);
      json(request, response, 200, state);
      return;
    }
    if (request.method === 'PUT') {
      if (session.role === 'patient') {
        forbidden(request, response);
        return;
      }
      const incoming = JSON.parse(await readBody(request));
      if (!Array.isArray(incoming.patients) || !Array.isArray(incoming.professionals)) {
        json(request, response, 400, { error: 'Invalid state' });
        return;
      }
      if (incoming.admins !== undefined && !Array.isArray(incoming.admins)) {
        json(request, response, 400, { error: 'Invalid state' });
        return;
      }
      await store.putState(session, incoming);
      json(request, response, 200, { saved: true });
      return;
    }
    json(request, response, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('API error:', error);
    if (!response.headersSent) json(request, response, 500, { error: 'Could not persist data' });
  }
});

api.listen(apiPort, '0.0.0.0', () => {
  console.log(`Vivace API: http://localhost:${apiPort}`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`Network API: http://${address.address}:${apiPort}`);
      }
    }
  }
  if (!angular) return;
  console.log(`Vivace frontend: http://localhost:${frontendPort}`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`Network frontend: http://${address.address}:${frontendPort}`);
      }
    }
  }
});

const angular = process.env.VIVACE_SKIP_FRONTEND === 'true'
  ? null
  : spawn(process.execPath, [
      join(root, 'node_modules', '@angular', 'cli', 'bin', 'ng.js'),
      'serve',
      '--port',
      String(frontendPort),
      '--host',
      '0.0.0.0',
      '--define',
      `VIVACE_API_PORT="${apiPort}"`
    ], {
      cwd: root,
      stdio: 'inherit'
    });

const shutdown = () => {
  angular?.kill();
  for (const client of eventClients.keys()) client.end();
  api.close(() => {
    void store.closeStore().finally(() => process.exit());
  });
};

angular?.on('exit', code => {
  api.close(() => process.exit(code ?? 0));
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
