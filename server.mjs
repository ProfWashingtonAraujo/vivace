import { createServer } from 'node:http';
import { createHash, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as store from './db/store.mjs';
import { clientAddress as resolveClientAddress } from './lib/client-ip.mjs';
import { loginKeys as buildLoginKeys } from './lib/login-keys.mjs';
import { shouldDeliver } from './lib/event-audience.mjs';
import { resolveBootstrap } from './lib/bootstrap-config.mjs';
import { parseJson, readBody, safeHandler } from './lib/http.mjs';
import { parseImageUpload } from './lib/image-upload.mjs';
import { removesLastAdmin } from './lib/state-guards.mjs';
import { validateNote, validateReview } from './lib/staff-actions.mjs';
import { parseIfMatch, validateInstruction, validateMedication } from './lib/catalog.mjs';
import { validateCareTeam, validatePassword, validatePatient } from './lib/patient.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const apiPort = Number(process.env.VIVACE_API_PORT ?? 3001);
const frontendPort = Number(process.env.VIVACE_FRONTEND_PORT ?? 3000);
const sessionTtlMs = Number(process.env.VIVACE_SESSION_TTL_MS ?? 8 * 60 * 60 * 1000);
const loginMaxAttempts = Math.max(1, Number(process.env.VIVACE_LOGIN_MAX_ATTEMPTS ?? 5));
const loginWindowMs = Math.max(1, Number(process.env.VIVACE_LOGIN_WINDOW_MS ?? 15 * 60 * 1000));
const loginLockoutMs = Math.max(1, Number(process.env.VIVACE_LOGIN_LOCKOUT_MS ?? 15 * 60 * 1000));
// Quantos proxies de confiança ficam na frente da API (no Render, um). Com 0 o
// X-Forwarded-For é ignorado, que é o certo quando a API recebe conexões direto.
const trustProxyHops = Math.max(0, Number(process.env.VIVACE_TRUST_PROXY_HOPS ?? 0));
const maxIdentifierLength = 200;
const maxPasswordLength = 1_024;
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

// O token só vale no cabeçalho Authorization. Aceitar ?token= na URL o deixava em
// log de proxy, histórico e Referer; o stream de eventos agora também manda o
// cabeçalho (o front lê o SSE com fetch, não com EventSource).
const requestToken = request => bearerToken(request);

// Mesmo resumo que o store grava em sessions, para que o contador de requisições
// por sessão não vire um segundo lugar onde o token fica em claro. Não é
// autenticação: aqui só precisa separar uma sessão de outra. Truncado em 32
// caracteres porque só precisa ser único entre sessões, não ser um resumo fiel.
const tokenFingerprint = token => createHash('sha256').update(token).digest('hex').slice(0, 32);

const clientAddress = request => resolveClientAddress({
  forwardedFor: request.headers['x-forwarded-for'],
  remoteAddress: request.socket.remoteAddress
}, trustProxyHops);

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

// Comparação de origem por string inteira, com scheme, host E porta. A versão
// anterior aceitava a porta que quisesse, porque comparava só o hostname: em
// desenvolvimento isso é inofensivo, e o mesmo código em produção liberaria
// qualquer porta do domínio real. Um atacante que sirva a página em
// `http://localhost:9999` — ou em qualquer porta do seu domínio — passaria na
// verificação e leria a resposta da API.
//
// A lista é a fonte da verdade: o próprio frontend nas portas que ele atende, mais
// o que vier em VIVACE_ALLOWED_ORIGINS. Nada é derivado do cabeçalho Host do
// pedido, porque Host é controlado por quem faz a requisição.
const originAllowed = new Set([
  ...extraOrigins,
  `http://localhost:${frontendPort}`,
  `http://127.0.0.1:${frontendPort}`,
  // O acesso pela rede local é o caso de uso do celular no endereço da máquina,
  // e o IP muda conforme a rede. Aceitar o IP da própria máquina na porta do
  // frontend é o que faz o check-in no celular funcionar sem configurar origem a
  // cada mudança de rede. Só os endereços que esta máquina tem agora: a lista é
  // montada no boot, e mudar de rede exige reiniciar, que é o mesmo que já
  // acontecia com o resto do servidor.
  ...Object.values(networkInterfaces()).flatMap(addresses => addresses ?? [])
    .filter(address => address.family === 'IPv4' && !address.internal)
    .map(address => `http://${address.address}:${frontendPort}`)
]);

const allowedOrigin = request => {
  const origin = request.headers.origin;
  return origin && originAllowed.has(origin) ? origin : null;
};

// Respostas da API carregam dados clínicos: nada de cache (compartilhado ou do
// navegador), nada de o navegador adivinhar o tipo do conteúdo e nada de Referer.
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

const json = (request, response, status, value, extraHeaders = {}) => {
  const origin = allowedOrigin(request);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
    ...securityHeaders,
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

// Teto de corpo por rota. Antes eram 25 MB em todas, inclusive no login, e o
// JSON.parse de um corpo desse tamanho bloqueia o event loop. Só o PUT do estado
// inteiro e o check-in com foto precisam de corpo grande.
const bodyLimits = {
  login: 4 * 1024,
  message: 16 * 1024,
  patient: 1024 * 1024,
  medication: 4 * 1024,
  checkIn: 8 * 1024 * 1024,
  state: 25 * 1024 * 1024
};
const maxPhotoBytes = 6 * 1024 * 1024;
const maxShortField = 100;

// Falha na subida, e não no primeiro login: hospedado sem senha própria do
// administrador a API não sobe.
const bootstrapConfig = resolveBootstrap();

const shortText = (value, fallback) => (typeof value === 'string' && value && value.length <= maxShortField ? value : fallback);

const failureStatus = error => ([400, 403, 404, 409, 413, 428].includes(error.statusCode) ? error.statusCode : 500);
const failureMessage = (error, fallback) => error.publicMessage ?? ({
  400: 'Requisição inválida',
  403: 'Insufficient permissions',
  404: 'Patient not found',
  409: 'Alteração recusada: o estado enviado apagaria vários pacientes de uma vez. Recarregue a página.',
  413: 'Corpo da requisição grande demais',
  428: 'Informe a versão que você leu no cabeçalho If-Match'
}[failureStatus(error)] ?? fallback);

const bootstrapAdmin = async () => store.bootstrapAdmin({
  id: 'adm-1',
  name: 'Administrador',
  email: bootstrapConfig.email,
  password: bootstrapConfig.password
});

// A conta de administração nasce quando o banco ainda não tem nenhum admin. A
// criação é feita uma vez por processo: o sucesso fica memoizado, então depois da
// primeira vez um login não custa nada a mais. Antes isso rodava a cada login e
// abria uma conexão de dono do banco só para perguntar.
let adminBootstrapped = false;
const ensureBootstrapAdmin = async () => {
  if (adminBootstrapped) return false;
  const created = await bootstrapAdmin();
  adminBootstrapped = true;
  return created;
};

// O SSE não passa pelo RLS, então o filtro por equipe é refeito aqui. O público
// do paciente é consultado uma vez por evento, e só se houver profissional
// conectado. Se a consulta falhar, shouldDeliver decide sem público: só o dono do
// registro e o admin recebem.
const publish = async event => {
  const payload = `data: ${JSON.stringify(event)}

`;
  let audience = null;
  const needsAudience = event.patientId
    && [...eventClients.values()].some(session => session.role === 'professional');
  if (needsAudience) {
    try {
      audience = await store.patientAudience(event.patientId);
    } catch (error) {
      console.error('Falha ao consultar a equipe do paciente para o evento:', error);
    }
  }
  for (const [client, clientSession] of eventClients) {
    if (shouldDeliver(clientSession, event, audience)) client.write(payload);
  }
};

const publishSafely = event => {
  void publish(event).catch(error => console.error('Falha ao publicar evento:', error));
};

// ------------------------------------------------- limite de requisicoes
//
// O bloqueio do login nao protege o resto: um token valido, mesmo vazado, fazia
// GET /api/state e PUT /api/state sem limite nenhum, e o PUT reescreve o prontuario
// inteiro. O limite e por sessao E por IP.
//
// A janela e fixa, nao deslizante, e a contagem e um contador simples. Isso e
// suficiente para abuso e e o que nao custa escrita: a sessao mora no Postgres, mas
// o contador fica em memoria, entao o limite e por processo e nao sobrevive a um
// restart -- resetar o limite e o mesmo preco de reiniciar a API, que e o que se
// aceita aqui. Um limite distribuido de verdade exigiria uma escrita por requisicao,
// e é o caminho quente que a 011 acabou de nao tocar.
//
// A chave de sessao e o hash do token, nunca o token: o contador nao pode virar um
// segundo lugar onde a credencial fica em claro.

const rateWindowMs = Math.max(1, Number(process.env.VIVACE_RATE_WINDOW_MS ?? 60_000));
const rateSessionMax = Math.max(1, Number(process.env.VIVACE_RATE_SESSION_MAX ?? 120));
const rateIpMax = Math.max(1, Number(process.env.VIVACE_RATE_IP_MAX ?? 300));
const rateCounters = new Map();

const rateKey = (prefix, value) => `${prefix}:${value}`;

// Janela fixa: a contagem zera no primeiro REQUEST depois de uma janela inteira.
// Um contador deslizante daria limite mais justo no limite da rajada, ao preco de
// guardar o historico de cada chave.
const rateExceeded = (key, max) => {
  const now = Date.now();
  const counter = rateCounters.get(key);
  if (!counter || counter.resetAt <= now) {
    rateCounters.set(key, { count: 1, resetAt: now + rateWindowMs });
    return 0;
  }
  counter.count += 1;
  return counter.count > max ? counter.resetAt - now : 0;
};

// Substitui sweepLoginAttempts no lugar: um timer que apaga o que já passou da
// janela, em vez de varrer a estrutura a cada pedido.
const sweepRateCounters = () => {
  const now = Date.now();
  for (const [key, counter] of rateCounters) {
    if (counter.resetAt <= now) rateCounters.delete(key);
  }
};

setInterval(sweepRateCounters, rateWindowMs).unref();

// O limite por IP vale para TODA rota, inclusive o login. O bloqueio por tentativas
// do login só conta falhas: um flood de senhas erradas para de gastar scrypt depois
// de VIVACE_LOGIN_MAX_ATTEMPTS, mas um flood de senhas certas -- ou de requisições
// malformadas, que nem chegam a comparar senha -- continuaria comprando scrypt sem
// limite, e cada scrypt é ~100ms de CPU.
//
// O OPTIONS é a única exceção: é o preflight do CORS, que o navegador manda sozinho e
// que não deveria gastar cota de ninguém.
const rateLimitIp = (request, response) => {
  const retryAfter = rateExceeded(rateKey('ip', clientAddress(request)), rateIpMax);
  if (retryAfter <= 0) return false;
  console.log(`Rate limit de IP estourado (${clientAddress(request)}), ${rateIpMax} por ${rateWindowMs}ms`);
  json(request, response, 429, {
    error: `Muitas requisições. Tente novamente em ${humanizeWait(retryAfter)}.`
  }, { 'Retry-After': String(Math.ceil(retryAfter / 1000)) });
  return true;
};

// Autentica e cobra o limite por sessão, nessa ordem: um token inválido não gasta
// cota, e responder 401 antes de consultar o banco é o caminho mais barato de
// responder. Devolve null quando já respondeu, para o chamador só precisar do
// `return`.
//
// A chave do limite por sessão é o token apresentado, e não o userId: assim um token
// descartado e reapresentado recomeça a contagem, em vez de deburdenar a sessão que
// ele finje ser.
const authorize = async (request, response) => {
  const token = requestToken(request);
  const session = token ? await store.findSession(token) : null;
  if (!session) {
    unauthorized(request, response);
    return null;
  }
  const retryAfter = rateExceeded(rateKey('sess', tokenFingerprint(token)), rateSessionMax);
  if (retryAfter > 0) {
    console.log(`Rate limit de sessão estourado para ${session.userId} (${session.role}), ${rateSessionMax} por ${rateWindowMs}ms`);
    json(request, response, 429, {
      error: `Muitas requisições. Tente novamente em ${humanizeWait(retryAfter)}.`
    }, { 'Retry-After': String(Math.ceil(retryAfter / 1000)) });
    return null;
  }
  return session;
};

const handleRequest = async (request, response) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'OPTIONS') {
    json(request, response, 204);
    return;
  }

  // Antes de qualquer trabalho, inclusive o scrypt do login. Um 429 aqui custa uma
  // subtração e uma comparação.
  if (rateLimitIp(request, response)) return;

  if (pathname === '/api/auth/login' && request.method === 'POST') {
    try {
      const input = parseJson(await readBody(request, bodyLimits.login));
      const identifier = typeof input.username === 'string' ? input.username.trim() : '';
      const password = typeof input.password === 'string' ? input.password : '';
      if (!identifier || !password) {
        json(request, response, 400, { error: 'Informe usuário e senha' });
        return;
      }
      if (identifier.length > maxIdentifierLength || password.length > maxPasswordLength) {
        json(request, response, 400, { error: 'Usuário ou senha inválidos' });
        return;
      }
      if (await ensureBootstrapAdmin()) {
        console.log('Conta de administrador inicial criada');
      }
      // A conta é resolvida ANTES do bloqueio: a chave de conta usa quem ela é, e
      // não o texto digitado, para que variações do identificador (prefixo de
      // e-mail) não ganhem tentativas novas. Resolver não gasta scrypt.
      const account = await store.findAccount(identifier);
      const keys = buildLoginKeys({ ip: clientAddress(request), account, identifier: normalize(identifier) });
      const lockedFor = await store.loginLockoutRemaining(keys);
      if (lockedFor > 0) {
        // O mesmo scrypt que o caminho 401 gasta. Sem esta linha, o 429 saía em
        // poucos milissegundos e o tempo de resposta denunciava que a conta
        // existe e está bloqueada, desfazendo o que o burnScrypt existe para
        // impedir.
        await burnScrypt(password);
        const retryAfter = Math.ceil(lockedFor / 1000);
        console.log(`Login bloqueado por ${lockedFor}ms (${clientAddress(request)})`);
        json(request, response, 429, {
          error: `Muitas tentativas de login. Tente novamente em ${humanizeWait(lockedFor)}.`
        }, { 'Retry-After': String(retryAfter) });
        return;
      }
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
      json(request, response, failureStatus(error), { error: failureMessage(error, 'Não foi possível autenticar') });
    }
    return;
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    await store.deleteSession(requestToken(request));
    json(request, response, 200, { loggedOut: true });
    return;
  }

  if (pathname === '/api/events' && request.method === 'GET') {
    // Entra no mesmo limite das outras rotas. A conexão é longa, mas conta como
    // uma requisição, e é isso que limita o número de streams abertos.
    const session = await authorize(request, response);
    if (!session) return;
    const origin = allowedOrigin(request);
    response.writeHead(200, {
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
      ...securityHeaders,
      'Cache-Control': 'no-store',
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
    const session = await authorize(request, response);
    if (!session) return;
    try {
      const input = parseJson(await readBody(request, bodyLimits.message));
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
      // O nome de quem enviou é o da sessão, para os dois lados. O cliente nunca escolhe
      // com que nome uma mensagem aparece para a outra parte.
      const senderName = session.name;
      const message = await store.insertMessage(session, {
        patientId: input.patientId,
        text,
        sender,
        senderName,
        clientMessageId: shortText(input.clientMessageId, undefined)
      });
      json(request, response, 201, { message });
      publishSafely({ type: 'message.created', patientId: input.patientId, message });
    } catch (error) {
      console.error('Message API error:', error);
      json(request, response, failureStatus(error), { error: failureMessage(error, 'Could not persist message') });
    }
    return;
  }

  if (pathname === '/api/checkins' && request.method === 'POST') {
    const session = await authorize(request, response);
    if (!session) return;
    try {
      const input = parseJson(await readBody(request, bodyLimits.checkIn));
      const patientId = session.role === 'patient' ? session.userId : input.patientId;
      const payload = input.checkIn;
      const painLevel = Number(payload?.painLevel);
      const temperature = Number(payload?.temperature);
      if (!patientId || !payload || !Number.isFinite(painLevel) || painLevel < 0 || painLevel > 10
        || !Number.isFinite(temperature) || temperature < 25 || temperature > 45) {
        json(request, response, 400, { error: 'Invalid check-in' });
        return;
      }
      // Foto enviada tem que ser jpeg, png ou webp de verdade e caber no teto.
      // Antes bastava o prefixo `data:image/`, e SVG ou texto entravam como imagem.
      const sentImage = input.photo?.imageUrl;
      const upload = sentImage ? parseImageUpload(sentImage, maxPhotoBytes) : null;
      if (sentImage && !upload) {
        json(request, response, 400, { error: 'Foto inválida: envie JPEG, PNG ou WebP de até 6 MB' });
        return;
      }
      const checkIn = {
        id: shortText(input.id, `chk-${randomUUID()}`),
        painLevel,
        temperature,
        mobilityScore: shortText(payload.mobilityScore, 'repouso_absoluto'),
        symptoms: Array.isArray(payload.symptoms)
          ? payload.symptoms.filter(item => typeof item === 'string' && item.length <= maxShortField).slice(0, 12)
          : [],
        notes: typeof payload.notes === 'string' ? payload.notes.slice(0, 1_000) : '',
        mood: shortText(payload.mood, 'bem'),
        dayLabel: shortText(payload.dayLabel, undefined),
        photoUploaded: Boolean(upload)
      };
      const photo = upload
        ? { imageUrl: sentImage, patientNotes: typeof input.photo.patientNotes === 'string' ? input.photo.patientNotes.slice(0, 1_000) : '', id: shortText(input.photo.id, undefined) }
        : undefined;
      const savedPatient = await store.insertCheckIn(session, { patientId, checkIn, photo });
      json(request, response, 201, { patient: savedPatient });
      publishSafely({ type: 'checkin.created', patientId, checkIn });
    } catch (error) {
      console.error('Check-in API error:', error);
      json(request, response, failureStatus(error), { error: failureMessage(error, 'Could not save check-in') });
    }
    return;
  }

  if (pathname === '/api/medication-taken' && request.method === 'POST') {
    const session = await authorize(request, response);
    if (!session) return;
    try {
      const input = parseJson(await readBody(request, bodyLimits.medication));
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
      publishSafely({ type: 'medication.updated', patientId });
    } catch (error) {
      console.error('Medication API error:', error);
      json(request, response, failureStatus(error), { error: failureMessage(error, 'Could not save confirmation') });
    }
    return;
  }

  // Identificador de paciente ou de foto vindo da URL: decodifica e limita o tamanho.
  const pathId = value => {
    let decoded;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return null;
    }
    return decoded && decoded.length <= maxShortField ? decoded : null;
  };

  // Cadastro de paciente (fase 2, área 3b). Criar é POST na coleção; editar e apagar exigem a
  // versão lida em If-Match (428 sem ela, 409 com o item atual se ela mudou). A senha e a
  // equipe têm chamada própria, e a equipe só o admin define.
  const patientRoute = (() => {
    const collection = pathname === '/api/patients';
    const item = /^\/api\/patients\/([^/]+)$/.exec(pathname);
    const password = /^\/api\/patients\/([^/]+)\/password$/.exec(pathname);
    const team = /^\/api\/patients\/([^/]+)\/care-team$/.exec(pathname);
    if (collection && request.method === 'POST') return { action: 'create' };
    if (item && request.method === 'PATCH') return { action: 'update', raw: item[1] };
    if (item && request.method === 'DELETE') return { action: 'delete', raw: item[1] };
    if (password && request.method === 'PUT') return { action: 'password', raw: password[1] };
    if (team && request.method === 'PUT') return { action: 'team', raw: team[1] };
    return null;
  })();
  if (patientRoute) {
    const session = await authorize(request, response);
    if (!session) return;
    if (session.role === 'patient') {
      forbidden(request, response);
      return;
    }
    try {
      const patientId = patientRoute.raw === undefined ? undefined : pathId(patientRoute.raw);
      if (patientRoute.raw !== undefined && !patientId) {
        json(request, response, 404, { error: 'Patient not found' });
        return;
      }
      const invalid = () => json(request, response, 400, { error: 'Invalid patient data' });

      if (patientRoute.action === 'create') {
        const raw = parseJson(await readBody(request, bodyLimits.patient));
        const input = validatePatient(raw);
        // Só o admin informa a equipe: o profissional que cria entra nela pelo gatilho do banco.
        const team = session.role === 'admin' && raw?.professionalIds !== undefined ? validateCareTeam(raw) : { ok: true, professionalIds: [] };
        if (!input.ok || !team.ok) return invalid();
        const { patient, created } = await store.createPatient(session, {
          values: input.values, password: input.password, clientId: input.clientId, professionalIds: team.professionalIds
        });
        json(request, response, created ? 201 : 200, { patient });
        if (created) publishSafely({ type: 'patient.changed', patientId: patient.id, change: 'created' });
        return;
      }

      if (patientRoute.action === 'password') {
        const input = validatePassword(parseJson(await readBody(request, bodyLimits.message)));
        if (!input.ok) return invalid();
        await store.setPatientPassword(session, { patientId, password: input.password });
        json(request, response, 200, { id: patientId });
        return;
      }

      if (patientRoute.action === 'team') {
        if (session.role !== 'admin') {
          forbidden(request, response);
          return;
        }
        const input = validateCareTeam(parseJson(await readBody(request, bodyLimits.message)));
        if (!input.ok) return invalid();
        json(request, response, 200, await store.setCareTeam(session, { patientId, professionalIds: input.professionalIds }));
        return;
      }

      const precondition = parseIfMatch(request.headers['if-match']);
      if (!precondition.ok) {
        const missing = precondition.reason === 'missing';
        json(request, response, missing ? 428 : 400, { error: missing ? failureMessage({ statusCode: 428 }, '') : 'If-Match inválido' });
        return;
      }
      if (patientRoute.action === 'update') {
        const input = validatePatient(parseJson(await readBody(request, bodyLimits.patient)), { partial: true });
        if (!input.ok) return invalid();
        const { patient, changed } = await store.updatePatient(session, { patientId, values: input.values, version: precondition.version });
        json(request, response, 200, { patient });
        if (changed) publishSafely({ type: 'patient.changed', patientId, change: 'updated' });
        return;
      }
      await store.deletePatient(session, { patientId, version: precondition.version });
      json(request, response, 200, { deleted: true, id: patientId });
    } catch (error) {
      console.error('Patient API error:', error);
      json(request, response, failureStatus(error), {
        error: failureMessage(error, 'Could not save patient'),
        ...(error.current ? { current: error.current } : {})
      });
    }
    return;
  }

  // Medicações e instruções (fase 2, área 2). Criar é POST na coleção; editar e apagar são
  // PATCH e DELETE no item e exigem a versão lida em If-Match. Uma versão que mudou
  // responde 409 com o item atual, e a falta do cabeçalho responde 428.
  const catalog = {
    medications: {
      entity: 'medication', event: 'medication.changed', idKey: 'medicationId', label: 'Medication',
      validate: validateMedication,
      create: store.createMedication, update: store.updateMedication, remove: store.deleteMedication
    },
    instructions: {
      entity: 'instruction', event: 'instruction.changed', idKey: 'instructionId', label: 'Instruction',
      validate: validateInstruction,
      create: store.createInstruction, update: store.updateInstruction, remove: store.deleteInstruction
    }
  };
  const catalogRoute = /^\/api\/patients\/([^/]+)\/(medications|instructions)(?:\/([^/]+))?$/.exec(pathname);
  const catalogMethods = catalogRoute?.[3] === undefined ? ['POST'] : ['PATCH', 'DELETE'];
  if (catalogRoute && catalogMethods.includes(request.method)) {
    const session = await authorize(request, response);
    if (!session) return;
    if (session.role === 'patient') {
      forbidden(request, response);
      return;
    }
    const kind = catalog[catalogRoute[2]];
    try {
      const patientId = pathId(catalogRoute[1]);
      const itemId = catalogRoute[3] === undefined ? undefined : pathId(catalogRoute[3]);
      if (!patientId || (catalogRoute[3] !== undefined && !itemId)) {
        json(request, response, 404, { error: `${kind.label} not found` });
        return;
      }

      if (request.method === 'POST') {
        const input = kind.validate(parseJson(await readBody(request, bodyLimits.message)));
        if (!input.ok) {
          json(request, response, 400, { error: `Invalid ${kind.entity}` });
          return;
        }
        const { [kind.entity]: item, created } = await kind.create(session, { patientId, values: input.values, clientId: input.clientId });
        json(request, response, created ? 201 : 200, { [kind.entity]: item });
        if (created) publishSafely({ type: kind.event, patientId, [kind.idKey]: item.id, change: 'created' });
        return;
      }

      const precondition = parseIfMatch(request.headers['if-match']);
      if (!precondition.ok) {
        const missing = precondition.reason === 'missing';
        json(request, response, missing ? 428 : 400, { error: missing ? failureMessage({ statusCode: 428 }, '') : 'If-Match inválido' });
        return;
      }

      if (request.method === 'PATCH') {
        const input = kind.validate(parseJson(await readBody(request, bodyLimits.message)), { partial: true });
        if (!input.ok) {
          json(request, response, 400, { error: `Invalid ${kind.entity}` });
          return;
        }
        const { [kind.entity]: item, changed } = await kind.update(session, { patientId, [kind.idKey]: itemId, values: input.values, version: precondition.version });
        json(request, response, 200, { [kind.entity]: item });
        if (changed) publishSafely({ type: kind.event, patientId, [kind.idKey]: itemId, change: 'updated' });
        return;
      }

      await kind.remove(session, { patientId, [kind.idKey]: itemId, version: precondition.version });
      json(request, response, 200, { deleted: true, id: itemId });
      publishSafely({ type: kind.event, patientId, [kind.idKey]: itemId, change: 'deleted' });
    } catch (error) {
      console.error('Catalog API error:', error);
      json(request, response, failureStatus(error), {
        error: failureMessage(error, `Could not save ${kind.entity}`),
        ...(error.current ? { current: error.current } : {})
      });
    }
    return;
  }

  const noteRoute = /^\/api\/patients\/([^/]+)\/clinical-notes$/.exec(pathname);
  if (noteRoute && request.method === 'POST') {
    const session = await authorize(request, response);
    if (!session) return;
    if (session.role === 'patient') {
      forbidden(request, response);
      return;
    }
    try {
      const patientId = pathId(noteRoute[1]);
      if (!patientId) {
        json(request, response, 404, { error: 'Patient not found' });
        return;
      }
      const input = validateNote(parseJson(await readBody(request, bodyLimits.message)));
      if (!input.ok) {
        json(request, response, 400, { error: 'Invalid note' });
        return;
      }
      const { note, created } = await store.addClinicalNote(session, { patientId, text: input.text, clientId: input.clientId });
      json(request, response, created ? 201 : 200, { note });
      // Só a equipe recebe, e sem o texto: até a existência de uma nota é dela.
      if (created) publishSafely({ type: 'clinical-note.created', patientId, noteId: note.id, staffOnly: true });
    } catch (error) {
      console.error('Clinical note API error:', error);
      json(request, response, failureStatus(error), { error: failureMessage(error, 'Could not save note') });
    }
    return;
  }

  const reviewRoute = /^\/api\/patients\/([^/]+)\/wound-photos\/([^/]+)\/review$/.exec(pathname);
  if (reviewRoute && request.method === 'PUT') {
    const session = await authorize(request, response);
    if (!session) return;
    if (session.role === 'patient') {
      forbidden(request, response);
      return;
    }
    try {
      const patientId = pathId(reviewRoute[1]);
      const photoId = pathId(reviewRoute[2]);
      if (!patientId || !photoId) {
        json(request, response, 404, { error: 'Photo not found' });
        return;
      }
      const input = validateReview(parseJson(await readBody(request, bodyLimits.message)));
      if (!input.ok) {
        json(request, response, 400, { error: 'Invalid review' });
        return;
      }
      const result = await store.reviewWoundPhoto(session, { patientId, photoId, status: input.status, feedback: input.feedback });
      json(request, response, 200, result);
      // O paciente dono também recebe (a avaliação é dele), mas o comentário não vai no aviso.
      publishSafely({ type: 'wound-photo.reviewed', patientId, photoId, reviewStatus: input.status });
    } catch (error) {
      console.error('Photo review API error:', error);
      json(request, response, failureStatus(error), { error: failureMessage(error, 'Could not save review') });
    }
    return;
  }

  if (pathname !== '/api/state') {
    json(request, response, 404, { error: 'Not found' });
    return;
  }

  const session = await authorize(request, response);
  if (!session) return;

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
      const incoming = parseJson(await readBody(request, bodyLimits.state));
      if (!Array.isArray(incoming.patients) || !Array.isArray(incoming.professionals)) {
        json(request, response, 400, { error: 'Invalid state' });
        return;
      }
      if (incoming.admins !== undefined && !Array.isArray(incoming.admins)) {
        json(request, response, 400, { error: 'Invalid state' });
        return;
      }
      if (removesLastAdmin(session, incoming)) {
        json(request, response, 400, { error: 'É preciso manter pelo menos um administrador' });
        return;
      }
      await store.putState(session, incoming);
      json(request, response, 200, { saved: true });
      return;
    }
    json(request, response, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('API error:', error);
    if (!response.headersSent) json(request, response, failureStatus(error), { error: failureMessage(error, 'Could not persist data') });
  }
};

// Qualquer erro que escape de uma rota (consulta de sessão, banco fora do ar...)
// responde 500 em vez de derrubar o processo.
const api = createServer(safeHandler(handleRequest, (error, request, response) => {
  console.error('Erro não tratado na requisição:', error);
  if (response.headersSent) {
    response.end();
    return;
  }
  json(request, response, failureStatus(error), { error: failureMessage(error, 'Erro interno') });
}));

// Tenta já na subida, para o primeiro login não pagar o scrypt do hash. Se o banco
// ainda não responde, o login tenta de novo (adminBootstrapped continua false).
void ensureBootstrapAdmin()
  .then(created => { if (created) console.log('Conta de administrador inicial criada'); })
  .catch(error => console.error('Não foi possível garantir o administrador inicial:', error.message));

process.on('unhandledRejection', reason => console.error('Rejeição não tratada:', reason));

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
