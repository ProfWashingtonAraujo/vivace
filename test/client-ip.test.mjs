import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clientAddress } from '../lib/client-ip.mjs';

describe('clientAddress', () => {
  it('sem proxy confiavel, ignora X-Forwarded-For e usa o endereco do socket', () => {
    const ip = clientAddress({ forwardedFor: '1.2.3.4', remoteAddress: '10.0.0.9' }, 0);
    assert.equal(ip, '10.0.0.9');
  });

  it('com um proxy confiavel, usa a ultima entrada, a que o proxy acrescentou', () => {
    const ip = clientAddress({ forwardedFor: '6.6.6.6, 203.0.113.7', remoteAddress: '10.0.0.9' }, 1);
    assert.equal(ip, '203.0.113.7');
  });

  it('entradas que o cliente injeta no inicio da lista nao mudam o resultado', () => {
    const a = clientAddress({ forwardedFor: '1.1.1.1, 203.0.113.7', remoteAddress: '10.0.0.9' }, 1);
    const b = clientAddress({ forwardedFor: '2.2.2.2, 3.3.3.3, 203.0.113.7', remoteAddress: '10.0.0.9' }, 1);
    assert.equal(a, b);
  });

  it('com dois proxies confiaveis, usa a penultima entrada', () => {
    const ip = clientAddress({ forwardedFor: '6.6.6.6, 203.0.113.7, 172.16.0.1', remoteAddress: '10.0.0.9' }, 2);
    assert.equal(ip, '203.0.113.7');
  });

  it('lista mais curta que o numero de proxies cai no endereco do socket', () => {
    const ip = clientAddress({ forwardedFor: '203.0.113.7', remoteAddress: '10.0.0.9' }, 2);
    assert.equal(ip, '10.0.0.9');
  });

  it('sem o cabecalho, usa o endereco do socket', () => {
    assert.equal(clientAddress({ remoteAddress: '10.0.0.9' }, 1), '10.0.0.9');
  });

  it('entrada absurdamente longa nao vira chave de contador', () => {
    const ip = clientAddress({ forwardedFor: 'x'.repeat(500), remoteAddress: '10.0.0.9' }, 1);
    assert.equal(ip, '10.0.0.9');
  });

  it('sem nenhum endereco, devolve um valor fixo e nao undefined', () => {
    assert.equal(clientAddress({}, 0), 'desconhecido');
  });
});
