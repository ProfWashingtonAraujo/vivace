import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSseParser } from '../src/app/sse-parser.ts';

const collect = () => {
  const received = [];
  const parser = createSseParser(data => received.push(data));
  return { received, push: chunk => parser.push(chunk) };
};

describe('createSseParser', () => {
  it('entrega o conteudo de um evento completo', () => {
    const { received, push } = collect();
    push('data: {"a":1}\n\n');
    assert.deepEqual(received, ['{"a":1}']);
  });

  it('junta um evento partido em varios pedacos de rede', () => {
    const { received, push } = collect();
    push('data: {"a"');
    push(':1}\n');
    assert.deepEqual(received, []);
    push('\n');
    assert.deepEqual(received, ['{"a":1}']);
  });

  it('entrega varios eventos que chegam no mesmo pedaco', () => {
    const { received, push } = collect();
    push('data: um\n\ndata: dois\n\ndata: tr');
    push('es\n\n');
    assert.deepEqual(received, ['um', 'dois', 'tres']);
  });

  it('ignora comentarios, como o ": connected" inicial', () => {
    const { received, push } = collect();
    push(': connected\n\ndata: x\n\n');
    assert.deepEqual(received, ['x']);
  });

  it('junta linhas data: de um mesmo evento com quebra de linha', () => {
    const { received, push } = collect();
    push('data: linha1\ndata: linha2\n\n');
    assert.deepEqual(received, ['linha1\nlinha2']);
  });

  it('aceita CRLF como separador', () => {
    const { received, push } = collect();
    push('data: x\r\n\r\n');
    assert.deepEqual(received, ['x']);
  });

  it('ignora campos que nao sao data, como id e event', () => {
    const { received, push } = collect();
    push('id: 7\nevent: message\ndata: y\n\n');
    assert.deepEqual(received, ['y']);
  });

  it('aceita "data:" sem espaco depois dos dois pontos', () => {
    const { received, push } = collect();
    push('data:z\n\n');
    assert.deepEqual(received, ['z']);
  });

  it('um bloco sem data nao entrega nada', () => {
    const { received, push } = collect();
    push(': keep-alive\n\n');
    assert.deepEqual(received, []);
  });

  it('descarta o que passar do tamanho maximo em vez de acumular sem fim', () => {
    const received = [];
    const parser = createSseParser(data => received.push(data), { maxBufferChars: 100 });
    parser.push('data: ' + 'x'.repeat(500));
    parser.push('\n\ndata: ok\n\n');
    assert.deepEqual(received, ['ok']);
  });
});
