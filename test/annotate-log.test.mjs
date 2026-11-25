import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { serverErrorBlocks } from '../scripts/annotate-log.mjs';

const log = `Vivace API: http://localhost:3194
API error: error: column "x" does not exist
    at Parser.parseErrorMessage (/app/node_modules/pg-protocol/dist/parser.js:283:98)
    at Parser.handlePacket (/app/node_modules/pg-protocol/dist/parser.js:122:29) {
  length: 105,
  severity: 'ERROR',
  code: '42703'
}
GET /algo
Message API error: Error: Patient not found
    at notFound (/app/db/store.mjs:60:9)
API error: error: column "x" does not exist
    at Parser.parseErrorMessage (/app/node_modules/pg-protocol/dist/parser.js:283:98)
Login API error: error: boom
    at x`;

describe('serverErrorBlocks', () => {
  it('extrai cada erro do servidor com as linhas seguintes', () => {
    const blocks = serverErrorBlocks(log);
    assert.ok(blocks[0].startsWith('API error: error: column "x" does not exist'));
    assert.ok(blocks[0].includes('code: \'42703\''));
  });

  it('nao repete o mesmo erro', () => {
    const blocks = serverErrorBlocks(log);
    const repeated = blocks.filter(block => block.startsWith('API error: error: column "x"'));
    assert.equal(repeated.length, 1);
  });

  it('pega os erros de varias rotas', () => {
    const blocks = serverErrorBlocks(log);
    assert.ok(blocks.some(block => block.startsWith('Message API error:')));
    assert.ok(blocks.some(block => block.startsWith('Login API error:')));
  });

  it('ignora linhas que nao sao erro', () => {
    const blocks = serverErrorBlocks(log);
    assert.ok(!blocks.some(block => block.startsWith('Vivace API:')));
    assert.ok(!blocks.some(block => block.startsWith('GET /algo')));
  });

  it('log vazio ou ausente nao quebra', () => {
    assert.deepEqual(serverErrorBlocks(''), []);
    assert.deepEqual(serverErrorBlocks(undefined), []);
  });

  it('limita o tamanho de cada bloco', () => {
    const huge = `API error: ${'x'.repeat(5000)}`;
    assert.ok(serverErrorBlocks(huge)[0].length <= 900);
  });
});
