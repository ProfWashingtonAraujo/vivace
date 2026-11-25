import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { cspAllowsApi, headerValue } from '../scripts/vercel-headers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const realConfig = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));

const configWith = csp => ({
  headers: [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: csp }] }]
});

describe('cspAllowsApi', () => {
  it('aceita quando connect-src lista a origem da API', () => {
    const config = configWith("default-src 'self'; connect-src 'self' https://api.exemplo.com");
    assert.equal(cspAllowsApi(config, 'https://api.exemplo.com'), true);
  });

  it('ignora barra final e caminho na URL da API', () => {
    const config = configWith("connect-src 'self' https://api.exemplo.com");
    assert.equal(cspAllowsApi(config, 'https://api.exemplo.com/'), true);
    assert.equal(cspAllowsApi(config, 'https://api.exemplo.com/v1'), true);
  });

  it('recusa quando a API nao esta em connect-src', () => {
    const config = configWith("connect-src 'self' https://outra.exemplo.com");
    assert.equal(cspAllowsApi(config, 'https://api.exemplo.com'), false);
  });

  it('recusa quando so default-src existe e nao cobre a API', () => {
    assert.equal(cspAllowsApi(configWith("default-src 'self'"), 'https://api.exemplo.com'), false);
  });

  it('recusa quando nao ha CSP', () => {
    assert.equal(cspAllowsApi({}, 'https://api.exemplo.com'), false);
  });

  it('nao confunde origens que so compartilham o prefixo', () => {
    const config = configWith("connect-src 'self' https://api.exemplo.com.atacante.net");
    assert.equal(cspAllowsApi(config, 'https://api.exemplo.com'), false);
  });
});

describe('vercel.json', () => {
  it('libera a API de producao em connect-src', () => {
    assert.equal(cspAllowsApi(realConfig, 'https://vivace-api-94bq.onrender.com'), true);
  });

  it('proibe ser embutido em frame e fixa o tipo do conteudo', () => {
    const csp = headerValue(realConfig, 'Content-Security-Policy');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(headerValue(realConfig, 'X-Content-Type-Options'), 'nosniff');
    assert.equal(headerValue(realConfig, 'X-Frame-Options'), 'DENY');
    assert.equal(headerValue(realConfig, 'Referrer-Policy'), 'no-referrer');
  });

  it('a CSP nao libera script inline nem eval', () => {
    const csp = headerValue(realConfig, 'Content-Security-Policy');
    const scriptSrc = csp.split(';').map(part => part.trim()).find(part => part.startsWith('script-src'));
    assert.ok(scriptSrc, 'script-src ausente');
    assert.ok(!scriptSrc.includes("'unsafe-inline'"));
    assert.ok(!scriptSrc.includes("'unsafe-eval'"));
  });
});
