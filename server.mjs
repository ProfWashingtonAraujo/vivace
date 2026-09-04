import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dataDirectory = join(root, '.data');
const dataFile = join(dataDirectory, 'vivace-state.json');
const apiPort = 3001;
let writeQueue = Promise.resolve();

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

const api = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    json(response, 204);
    return;
  }
  if (request.url !== '/api/state') {
    json(response, 404, { error: 'Not found' });
    return;
  }

  try {
    if (request.method === 'GET') {
      try {
        json(response, 200, JSON.parse(await readFile(dataFile, 'utf8')));
      } catch (error) {
        if (error.code === 'ENOENT') json(response, 204);
        else throw error;
      }
      return;
    }
    if (request.method === 'PUT') {
      const state = JSON.parse(await readBody(request));
      if (!Array.isArray(state.patients) || !Array.isArray(state.professionals)) {
        json(response, 400, { error: 'Invalid state' });
        return;
      }
      writeQueue = writeQueue.catch(() => undefined).then(async () => {
        await mkdir(dataDirectory, { recursive: true });
        const temporaryFile = `${dataFile}.tmp`;
        await writeFile(temporaryFile, JSON.stringify(state), 'utf8');
        await rename(temporaryFile, dataFile);
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

const angularCli = join(root, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
const angular = spawn(process.execPath, [angularCli, 'serve', '--port', '3000', '--host', '0.0.0.0'], {
  cwd: root,
  stdio: 'inherit'
});

const shutdown = () => {
  angular.kill();
  api.close(() => process.exit());
};

angular.on('exit', code => {
  api.close(() => process.exit(code ?? 0));
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
