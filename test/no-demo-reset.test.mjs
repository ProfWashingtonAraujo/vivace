// "Restaurar dados de demonstração" gravava os dados de exemplo do bundle por cima
// do prontuário real de TODOS os aparelhos conectados, com um único clique e um
// confirm(). Em produção isso apaga o que a equipe e os pacientes registraram.
// Esta verificação garante que o botão e o método que o sustenta não voltem.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appDirectory = join(root, 'src', 'app');
const sources = readdirSync(appDirectory)
  .filter(name => /\.(ts|html)$/.test(name))
  .map(name => ({ name, text: readFileSync(join(appDirectory, name), 'utf8') }));

describe('restaurar dados de demonstracao foi removido', () => {
  it('nenhum componente ou template oferece o botao ou chama o reset', () => {
    for (const { name, text } of sources) {
      assert.ok(!/resetDemo/.test(text), `${name} ainda referencia resetDemo`);
      assert.ok(!/resetToDefaults/.test(text), `${name} ainda referencia resetToDefaults`);
      assert.ok(!/Restaurar (os )?dados de demonstra/i.test(text), `${name} ainda fala em restaurar demonstracao`);
    }
  });
});
