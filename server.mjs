import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
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
let writeQueue = Promise.resolve();
const eventClients = new Set();

const json = (response, status, value) => {
  response.writeHead(status, {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(value === undefined ? undefined : JSON.stringify(value));
};

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

const publish = event => {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of eventClients) client.write(payload);
};

const api = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    json(response, 204);
    return;
  }
  if (request.url === '/api/events' && request.method === 'GET') {
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8'
    });
    response.write(': connected\n\n');
    eventClients.add(response);
    request.on('close', () => eventClients.delete(response));
    return;
  }
  if (request.url === '/api/messages' && request.method === 'POST') {
    try {
      const input = JSON.parse(await readBody(request));
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!input.patientId || !text || text.length > 2_000 || !['paciente', 'equipe'].includes(input.sender)) {
        json(response, 400, { error: 'Invalid message' });
        return;
      }
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
          sender: input.sender,
          senderName: typeof input.senderName === 'string' && input.senderName.trim() ? input.senderName.trim() : input.sender,
          timestamp: new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
          text,
          isRead: false
        };
        patient.messages.push(savedMessage);
        await persistState(state);
      });
      await writeQueue;
      json(response, 201, { message: savedMessage });
      publish({ type: 'message.created', patientId: input.patientId, message: savedMessage });
    } catch (error) {
      console.error('Message API error:', error);
      json(response, error.statusCode ?? 500, { error: error.statusCode === 404 ? 'Patient not found' : 'Could not persist message' });
    }
    return;
  }
  if (request.url !== '/api/state') {
    json(response, 404, { error: 'Not found' });
    return;
  }

  try {
    if (request.method === 'GET') {
      const state = await readState();
      json(response, state ? 200 : 204, state ?? undefined);
      return;
    }
    if (request.method === 'PUT') {
      const state = JSON.parse(await readBody(request));
      if (!Array.isArray(state.patients) || !Array.isArray(state.professionals)) {
        json(response, 400, { error: 'Invalid state' });
        return;
      }
      writeQueue = writeQueue.catch(() => undefined).then(async () => {
        const current = await readState();
        if (current?.patients) {
          for (const patient of state.patients) {
            const currentPatient = current.patients.find(item => item.id === patient.id);
            if (currentPatient) patient.messages = mergeMessages(currentPatient.messages, patient.messages);
          }
        }
        await persistState(state);
      });
      await writeQueue;
      json(response, 200, { saved: true });
      return;
    }
    json(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('API error:', error);
    if (!response.headersSent) json(response, 500, { error: 'Could not persist data' });
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
});

const angular = process.env.VIVACE_SKIP_FRONTEND === 'true'
  ? null
  : spawn(process.execPath, [join(root, 'node_modules', '@angular', 'cli', 'bin', 'ng.js'), 'serve', '--port', '3000', '--host', '0.0.0.0'], {
      cwd: root,
      stdio: 'inherit'
    });

const shutdown = () => {
  angular?.kill();
  for (const client of eventClients) client.end();
  api.close(() => process.exit());
};

angular?.on('exit', code => {
  api.close(() => process.exit(code ?? 0));
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
