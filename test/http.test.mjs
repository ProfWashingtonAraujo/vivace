import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { parseJson, readBody, safeHandler } from '../lib/http.mjs';

let server;
let base;

before(async () => {
  server = createServer(safeHandler(async (request, response) => {
    if (request.url === '/limited') {
      try {
        const text = await readBody(request, 10);
        response.writeHead(200).end(text);
      } catch (error) {
        response.writeHead(error.statusCode ?? 500, { Connection: 'close' }).end();
      }
      return;
    }
    if (request.url === '/json') {
      try {
        const value = parseJson(await readBody(request, 1_000));
        response.writeHead(200).end(JSON.stringify(value));
      } catch (error) {
        response.writeHead(error.statusCode ?? 500).end();
      }
      return;
    }
    if (request.url === '/boom') throw new Error('falha de banco simulada');
    response.writeHead(404).end();
  }, (error, request, response) => {
    response.writeHead(500).end('erro tratado');
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise(resolve => {
  server.closeAllConnections?.();
  server.close(resolve);
}));

describe('readBody', () => {
  it('le o corpo dentro do limite', async () => {
    const response = await fetch(`${base}/limited`, { method: 'POST', body: 'abc' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'abc');
  });

  it('corpo acima do limite (Content-Length) vira 413, nao queda de conexao', async () => {
    const response = await fetch(`${base}/limited`, { method: 'POST', body: 'x'.repeat(1_000) });
    assert.equal(response.status, 413);
  });

  it('corpo acima do limite sem Content-Length (chunked) tambem vira 413', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(`${base}/limited`, { method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, res => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.write('x'.repeat(8));
      req.write('x'.repeat(8));
      req.end();
    });
    assert.equal(status, 413);
  });
});

describe('parseJson', () => {
  it('JSON invalido vira 400, nao 500', async () => {
    const response = await fetch(`${base}/json`, { method: 'POST', body: '{nao e json' });
    assert.equal(response.status, 400);
  });

  it('corpo vazio vira 400', async () => {
    const response = await fetch(`${base}/json`, { method: 'POST', body: '' });
    assert.equal(response.status, 400);
  });

  it('JSON valido passa', async () => {
    const response = await fetch(`${base}/json`, { method: 'POST', body: '{"a":1}' });
    assert.deepEqual(await response.json(), { a: 1 });
  });
});

describe('safeHandler', () => {
  it('erro dentro do handler assincrono vai para o tratador e o servidor continua de pe', async () => {
    const first = await fetch(`${base}/boom`);
    assert.equal(first.status, 500);
    assert.equal(await first.text(), 'erro tratado');
    const second = await fetch(`${base}/json`, { method: 'POST', body: '{"ok":true}' });
    assert.equal(second.status, 200);
  });
});
