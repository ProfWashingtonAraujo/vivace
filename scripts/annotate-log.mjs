// Lê os logs dos servidores de teste e publica os erros como anotações do GitHub
// Actions. O log do job só abre com login; as anotações são públicas.
//
//   node scripts/annotate-log.mjs <log> [<log> ...]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Linhas que o servidor escreve com console.error, como "API error: ..." ou
// "Login API error: ...". Cada uma vem seguida do restante da mensagem e da pilha.
const ERROR_LINE = /^(?:[A-Za-z-]+ )?API error:/;
const CONTEXT_LINES = 7;
const MAX_BLOCK_LENGTH = 800;

export const serverErrorBlocks = text => {
  const lines = typeof text === 'string' ? text.split(/\r?\n/) : [];
  const seen = new Set();
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!ERROR_LINE.test(lines[index])) continue;
    if (seen.has(lines[index])) continue;
    seen.add(lines[index]);
    blocks.push(lines.slice(index, index + 1 + CONTEXT_LINES).join('\n').slice(0, MAX_BLOCK_LENGTH));
  }
  return blocks;
};

const escapeData = value => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  const all = [];
  for (const file of files) {
    try {
      for (const block of serverErrorBlocks(readFileSync(file, 'utf8'))) {
        if (!all.includes(block)) all.push(block);
      }
    } catch {
      // arquivo ausente: o servidor daquela porta nao chegou a subir
    }
  }
  // O GitHub mostra no máximo 10 anotações de erro por passo.
  for (const block of all.slice(0, 9)) console.log(`::error title=Erro do servidor de teste::${escapeData(block)}`);
  console.log(`::notice title=Erros do servidor::${all.length} erro(s) distintos; ${Math.min(9, all.length)} mostrados`);
}
