import { createServer } from 'node:http';
import { randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.VIVACE_DATA_DIRECTORY
  ? resolve(process.env.VIVACE_DATA_DIRECTORY)
  : join(root, '.data');
const dataFile = join(dataDirectory, 'vivace-state.json');
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
let writeQueue = Promise.resolve();
const eventClients = new Map();
const sessions = new Map();
const loginAttempts = new Map();

const scrypt = (password, salt) => new Promise((resolve, reject) => {
  scryptCallback(password, salt, 64, (error, key) => (error ? reject(error) : resolve(key)));
});

const normalize = value => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const hashPassword = async password => {
  const salt = randomUUID().replace(/-/g, '').slice(0, 16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt}$${key.toString('hex')}`;
};

const verifyPassword = async (password, stored) => {
  if (typeof stored !== 'string' || !stored) return false;
  if (!stored.startsWith('scrypt$')) return normalize(password) === normalize(stored);
  const [, salt, expected] = stored.split('$');
  if (!salt || !expected) return false;
  const key = await scrypt(password, salt);
  const expectedKey = Buffer.from(expected, 'hex');
  return key.length === expectedKey.length && timingSafeEqual(key, expectedKey);
};

const isHashed = value => typeof value === 'string' && value.startsWith('scrypt$');

const decoySalt = 'vivace-login-decoy';

// Gasta o mesmo tempo de scrypt quando não há hash para comparar, para que o
// tempo de resposta não revele se o usuário existe.
const burnScrypt = async password => {
  await scrypt(password, decoySalt);
};

const createSession = (account) => {
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  sessions.set(token, { ...account, expiresAt: Date.now() + sessionTtlMs });
  return token;
};

const bearerToken = request => {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

const authenticate = request => {
  const token = bearerToken(request);
  const session = token ? sessions.get(token) : undefined;
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + sessionTtlMs;
  return session;
};

const sessionTokenFromUrl = url => new URL(url, 'http://localhost').searchParams.get('token') ?? '';

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

const loginLockoutRemaining = (request, identifier) => {
  const now = Date.now();
  let remaining = 0;
  for (const key of loginKeys(request, identifier)) {
    const record = loginAttempts.get(key);
    if (!record) continue;
    if (record.lockedUntil > now) {
      remaining = Math.max(remaining, record.lockedUntil - now);
      continue;
    }
    if (record.firstAttempt + loginWindowMs <= now) loginAttempts.delete(key);
  }
  return remaining;
};

const recordLoginFailure = (request, identifier) => {
  const now = Date.now();
  for (const key of loginKeys(request, identifier)) {
    const record = loginAttempts.get(key);
    const entry = record && record.firstAttempt + loginWindowMs > now
      ? record
      : { failures: 0, firstAttempt: now, lockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= loginMaxAttempts) entry.lockedUntil = now + loginLockoutMs;
    loginAttempts.set(key, entry);
  }
};

const clearLoginFailures = (request, identifier) => {
  for (const key of loginKeys(request, identifier)) loginAttempts.delete(key);
};

const humanizeWait = milliseconds => {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return `${seconds} segundo${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minuto${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hora${hours === 1 ? '' : 's'}`;
};

const sweepLoginAttempts = () => {
  const now = Date.now();
  for (const [key, record] of loginAttempts) {
    if (record.lockedUntil <= now && record.firstAttempt + loginWindowMs <= now) loginAttempts.delete(key);
  }
};

setInterval(sweepLoginAttempts, loginWindowMs).unref();

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

const readState = async () => {
  try {
    return JSON.parse(await readFile(dataFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const persistState = async state => {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryFile = `${dataFile}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(state), 'utf8');
  await rename(temporaryFile, dataFile);
};

const mergeMessages = (current = [], incoming = []) => {
  const messages = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) if (!messages.has(message.id)) messages.set(message.id, message);
  return [...messages.values()];
};

const bootstrapAdmin = async () => ({
  id: 'adm-1',
  name: 'Administrador',
  email: process.env.VIVACE_BOOTSTRAP_EMAIL ?? 'admin@vivace.med.br',
  password: await hashPassword(process.env.VIVACE_BOOTSTRAP_PASSWORD ?? 'vivace-demo')
});

const bootstrapState = async () => ({
  patients: [],
  professionals: [],
  admins: [await bootstrapAdmin()]
});

const ensureBootstrapAdmin = async state => {
  if (state.admins?.length) return false;
  state.admins = [await bootstrapAdmin()];
  await persistState(state);
  return true;
};

const findAccount = (state, identifier) => {
  const wanted = normalize(identifier);
  if (!wanted) return null;
  for (const admin of state.admins ?? []) {
    if ([admin.name, admin.email].some(value => normalize(value) === wanted)) {
      return { role: 'admin', userId: admin.id, name: admin.name, password: admin.password };
    }
  }
  for (const professional of state.professionals ?? []) {
    if ([professional.name, professional.email].some(value => normalize(value) === wanted)) {
      return { role: 'professional', userId: professional.id, name: professional.name, password: professional.password };
    }
  }
  for (const patient of state.patients ?? []) {
    const matches = [patient.name, patient.email].some(value => normalize(value) === wanted)
      || (wanted.length >= 3 && normalize(patient.email).startsWith(wanted));
    if (matches) return { role: 'patient', userId: patient.id, name: patient.name, password: patient.password };
  }
  return null;
};

const storeAccountPassword = async (state, account, password) => {
  const hashed = await hashPassword(password);
  const collections = [
    [state.admins, account.userId],
    [state.professionals, account.userId],
    [state.patients, account.userId]
  ];
  for (const [collection, userId] of collections) {
    const record = collection?.find(item => item.id === userId);
    if (record) {
      record.password = hashed;
      return;
    }
  }
};

const sanitizeProfessional = professional => {
  const { password, ...rest } = professional;
  return rest;
};

const sanitizePatient = (patient, { full }) => {
  const { password, clinicalNotes, ...rest } = patient;
  return full ? { ...rest, clinicalNotes } : rest;
};

const canonicalSurgeon = professional => `${professional.name} (${professional.crmCoren})`;

const findProfessional = (state, userId) => (state?.professionals ?? []).find(item => item.id === userId);

const isAssignedTo = (professional, patient) => {
  if (!professional || !patient) return false;
  const surgeon = normalize(patient.surgeon);
  if (!surgeon) return false;
  const coren = normalize(professional.crmCoren);
  if (coren && surgeon.includes(coren)) return true;
  const name = normalize(professional.name);
  return name.length >= 3 && surgeon.startsWith(name);
};

const canAccessPatient = (session, state, patient) => {
  if (!session || !patient) return false;
  if (session.role === 'admin') return true;
  if (session.role === 'patient') return patient.id === session.userId;
  const professionals = state?.professionals ?? [];
  const professional = professionals.find(item => item.id === session.userId);
  if (!professional) return false;
  if (isAssignedTo(professional, patient)) return true;
  return professionals.every(item => !isAssignedTo(item, patient));
};

const patientsForSession = (session, state) => (state?.patients ?? []).filter(patient => canAccessPatient(session, state, patient));

const rejectForeignPatients = (session, state, patients) => {
  const currentPatients = state?.patients ?? [];
  const forbidden = currentPatients.filter(patient => !canAccessPatient(session, state, patient));
  const forbiddenIds = new Set(forbidden.map(patient => patient.id));
  if (patients.some(patient => forbiddenIds.has(patient.id))) return false;
  const professional = findProfessional(state, session.userId);
  const scoped = patients.map(patient => {
    const stored = currentPatients.find(item => item.id === patient.id);
    if (!stored) return { ...patient, surgeon: canonicalSurgeon(professional) };
    return normalize(patient.surgeon) === normalize(canonicalSurgeon(professional))
      ? patient
      : { ...patient, surgeon: stored.surgeon };
  });
  return [...scoped, ...forbidden];
};

const patientTimestamp = date => new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Sao_Paulo'
}).format(date);

const patientDayLabel = patient => `D+${patient.postOpDay}`;

const severityFor = checkIn => checkIn.painLevel >= 7 || checkIn.temperature >= 37.8
  ? 'critico'
  : checkIn.painLevel >= 4 || checkIn.temperature >= 37.3
    ? 'atencao'
    : 'estavel';

const adherenceFor = medications => {
  const slots = medications.flatMap(medication => medication.times.map(time => medication.takenToday[time]));
  return slots.length ? Math.round(slots.filter(Boolean).length / slots.length * 100) : 100;
};

const applyCheckIn = (patient, checkIn, photo, now) => {
  const dayLabel = typeof checkIn.dayLabel === 'string' && checkIn.dayLabel ? checkIn.dayLabel : patientDayLabel(patient);
  const time = patientTimestamp(now);
  const record = {
    ...checkIn,
    id: checkIn.id,
    date: new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(now),
    dayLabel
  };
  patient.checkIns = [record, ...(patient.checkIns ?? [])];
  patient.currentPain = checkIn.painLevel;
  patient.currentTemp = checkIn.temperature;
  patient.lastCheckInTime = `Hoje às ${time}`;
  patient.status = severityFor(checkIn);
  const timeline = patient.timeline ?? [];
  patient.timeline = [...timeline, {
    id: `tl-${checkIn.id}`,
    date: `${record.date} ${time}`,
    dayLabel,
    title: `Check-in Diário (${dayLabel})`,
    description: `Dor ${checkIn.painLevel}/10, Temp ${checkIn.temperature}°C. ${checkIn.notes ?? ''}`.trim(),
    author: `${patient.name} (Paciente)`,
    type: 'checkin'
  }];
  if (photo?.imageUrl) {
    const photoId = photo.id || `wp-${checkIn.id}`;
    patient.woundPhotos = [{
      id: photoId,
      date: record.date,
      dayLabel,
      imageUrl: photo.imageUrl,
      patientNotes: photo.patientNotes,
      reviewStatus: 'pendente'
    }, ...(patient.woundPhotos ?? [])];
    patient.woundReviewPending = true;
    patient.timeline = [...patient.timeline, {
      id: `tl-${photoId}`,
      date: `${record.date} ${time}`,
      dayLabel,
      title: 'Nova Foto da Ferida Cirúrgica Enviada',
      description: photo.patientNotes || 'Registro fotográfico enviado para avaliação.',
      author: `${patient.name} (Paciente)`,
      type: 'curativo'
    }];
  }
};

const applyMedicationTaken = (patient, medicationId, time) => {
  const medications = (patient.medications ?? []).map(medication => {
    if (medication.id !== medicationId) return medication;
    if (!medication.times.includes(time)) return medication;
    return {
      ...medication,
      takenToday: { ...medication.takenToday, [time]: !medication.takenToday[time] }
    };
  });
  patient.medications = medications;
  patient.medicationAdherencePercent = adherenceFor(medications);
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
      const lockedFor = loginLockoutRemaining(request, identifier);
      if (lockedFor > 0) {
        const retryAfter = Math.ceil(lockedFor / 1000);
        console.log(`Login bloqueado por ${lockedFor}ms para ${identifier} (${clientAddress(request)})`);
        json(request, response, 429, {
          error: `Muitas tentativas de login. Tente novamente em ${humanizeWait(lockedFor)}.`
        }, { 'Retry-After': String(retryAfter) });
        return;
      }
      const storedState = await readState();
      let state = storedState;
      if (!state) {
        state = await bootstrapState();
      } else if (await ensureBootstrapAdmin(state)) {
        console.log('Conta de administrador inicial criada em', dataFile);
      }
      const account = findAccount(state, identifier);
      if (!account) {
        await burnScrypt(password);
        recordLoginFailure(request, identifier);
        json(request, response, 401, { error: 'Usuário ou senha inválidos' });
        return;
      }
      const hashed = isHashed(account.password);
      const valid = await verifyPassword(password, account.password);
      if (!hashed) await burnScrypt(password);
      if (!valid) {
        recordLoginFailure(request, identifier);
        json(request, response, 401, { error: 'Usuário ou senha inválidos' });
        return;
      }
      clearLoginFailures(request, identifier);
      if (!isHashed(account.password) || account.role === 'admin') {
        writeQueue = writeQueue.catch(() => undefined).then(async () => {
          const current = await readState();
          if (!current) return;
          if (!isHashed(account.password)) await storeAccountPassword(current, account, password);
          if (account.role === 'admin') {
            for (const collection of [current.patients, current.professionals, current.admins]) {
              for (const record of collection ?? []) {
                if (record.password && !isHashed(record.password)) {
                  record.password = await hashPassword(record.password);
                }
              }
            }
          }
          await persistState(current);
        });
        await writeQueue.catch(() => undefined);
      }
      const token = createSession({ role: account.role, userId: account.userId, name: account.name });
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
    const token = bearerToken(request) || sessionTokenFromUrl(request.url);
    if (token) sessions.delete(token);
    json(request, response, 200, { loggedOut: true });
    return;
  }

  if (pathname === '/api/events' && request.method === 'GET') {
    const session = authenticate(request) ?? (() => {
      const token = sessionTokenFromUrl(request.url);
      const stored = token ? sessions.get(token) : undefined;
      return stored && stored.expiresAt > Date.now() ? stored : null;
    })();
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
    const session = authenticate(request);
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
      const state = await readState();
      const targetPatient = (state?.patients ?? []).find(patient => patient.id === input.patientId);
      if (!targetPatient) {
        json(request, response, 404, { error: 'Patient not found' });
        return;
      }
      if (!canAccessPatient(session, state, targetPatient)) {
        forbidden(request, response);
        return;
      }
      const sender = session.role === 'patient' ? 'paciente' : 'equipe';
      const senderName = session.role === 'patient'
        ? session.name
        : typeof input.senderName === 'string' && input.senderName.trim() ? input.senderName.trim() : session.name;
      let savedMessage;
      writeQueue = writeQueue.catch(() => undefined).then(async () => {
        const state = await readState();
        const patient = state?.patients?.find(item => item.id === input.patientId);
        if (!patient) throw Object.assign(new Error('Patient not found'), { statusCode: 404 });
        const messageId = typeof input.clientMessageId === 'string' && input.clientMessageId
          ? input.clientMessageId
          : `msg-${randomUUID()}`;
        savedMessage = patient.messages.find(message => message.id === messageId);
        if (savedMessage) return;
        savedMessage = {
          id: messageId,
          sender,
          senderName,
          timestamp: new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
          text,
          isRead: false
        };
        patient.messages.push(savedMessage);
        await persistState(state);
      });
      await writeQueue;
      json(request, response, 201, { message: savedMessage });
      publish({ type: 'message.created', patientId: input.patientId, message: savedMessage });
    } catch (error) {
      console.error('Message API error:', error);
      json(request, response, error.statusCode ?? 500, { error: error.statusCode === 404 ? 'Patient not found' : 'Could not persist message' });
    }
    return;
  }

  if (pathname === '/api/checkins' && request.method === 'POST') {
    const session = authenticate(request);
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
      const state = await readState();
      const targetPatient = (state?.patients ?? []).find(patient => patient.id === patientId);
      if (!targetPatient) {
        json(request, response, 404, { error: 'Patient not found' });
        return;
      }
      if (!canAccessPatient(session, state, targetPatient)) {
        forbidden(request, response);
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
      let savedPatient;
      writeQueue = writeQueue.catch(() => undefined).then(async () => {
        const state = await readState();
        const patient = state?.patients?.find(item => item.id === patientId);
        if (!patient) throw Object.assign(new Error('Patient not found'), { statusCode: 404 });
        const existing = (patient.checkIns ?? []).find(item => item.id === checkIn.id);
        if (existing) {
          savedPatient = patient;
          return;
        }
        applyCheckIn(patient, checkIn, photo, new Date());
        await persistState(state);
        savedPatient = patient;
      });
      await writeQueue;
      json(request, response, 201, { patient: sanitizePatient(savedPatient, { full: true }) });
      publish({ type: 'checkin.created', patientId, checkIn });
    } catch (error) {
      console.error('Check-in API error:', error);
      json(request, response, error.statusCode ?? 500, { error: error.statusCode === 404 ? 'Patient not found' : 'Could not save check-in' });
    }
    return;
  }

  if (pathname === '/api/medication-taken' && request.method === 'POST') {
    const session = authenticate(request);
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
      const state = await readState();
      const targetPatient = (state?.patients ?? []).find(patient => patient.id === patientId);
      if (!targetPatient) {
        json(request, response, 404, { error: 'Patient not found' });
        return;
      }
      if (!canAccessPatient(session, state, targetPatient)) {
        forbidden(request, response);
        return;
      }
      let savedPatient;
      writeQueue = writeQueue.catch(() => undefined).then(async () => {
        const state = await readState();
        const patient = state?.patients?.find(item => item.id === patientId);
        if (!patient) throw Object.assign(new Error('Patient not found'), { statusCode: 404 });
        applyMedicationTaken(patient, input.medicationId, input.time);
        await persistState(state);
        savedPatient = patient;
      });
      await writeQueue;
      json(request, response, 200, { patient: sanitizePatient(savedPatient, { full: true }) });
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

  const session = authenticate(request);
  if (!session) {
    unauthorized(request, response);
    return;
  }

  try {
    if (request.method === 'GET') {
      const state = await readState();
      if (!state) {
        json(request, response, 204);
        return;
      }
      const professionals = (state.professionals ?? []).map(sanitizeProfessional);
      const admins = (state.admins ?? []).map(admin => {
        const { password, ...rest } = admin;
        return rest;
      });
      const patients = patientsForSession(session, state)
        .map(patient => sanitizePatient(patient, { full: session.role !== 'patient' }));
      json(request, response, 200, {
        patients,
        professionals: session.role === 'patient' ? [] : professionals,
        admins: session.role === 'admin' ? admins : []
      });
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
      const currentState = await readState();
      if (session.role !== 'admin') {
        if (!findProfessional(currentState, session.userId)) {
          forbidden(request, response);
          return;
        }
        const scopedPatients = rejectForeignPatients(session, currentState, incoming.patients);
        if (!scopedPatients) {
          forbidden(request, response);
          return;
        }
        incoming.patients = scopedPatients;
        incoming.professionals = currentState?.professionals ?? [];
        incoming.admins = currentState?.admins ?? [];
      }
      const collections = [
        ['admins', incoming.admins],
        ['professionals', incoming.professionals],
        ['patients', incoming.patients]
      ];
      const incomingPasswords = new Map();
      for (const [key, collection] of collections) {
        for (const record of collection ?? []) {
          if (typeof record.password === 'string' && !isHashed(record.password)) {
            incomingPasswords.set(`${key}:${record.id}`, record.password);
          }
          delete record.password;
        }
      }
      writeQueue = writeQueue.catch(() => undefined).then(async () => {
        const current = await readState();
        for (const [key, collection] of collections) {
          for (const record of collection ?? []) {
            const stored = current?.[key]?.find(item => item.id === record.id)?.password;
            const plain = incomingPasswords.get(`${key}:${record.id}`);
            const password = stored ?? (plain ? await hashPassword(plain) : undefined);
            if (password) record.password = password;
          }
        }
        if (current?.patients) {
          for (const patient of incoming.patients) {
            const currentPatient = current.patients.find(item => item.id === patient.id);
            if (currentPatient) patient.messages = mergeMessages(currentPatient.messages, patient.messages);
          }
        }
        await persistState(incoming);
      });
      await writeQueue;
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
  sessions.clear();
  for (const client of eventClients.keys()) client.end();
  api.close(() => process.exit());
};

angular?.on('exit', code => {
  api.close(() => process.exit(code ?? 0));
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
