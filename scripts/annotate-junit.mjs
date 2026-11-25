// Transforma as falhas de um relatório JUnit (node --test --test-reporter=junit) em
// anotações do GitHub Actions (::error ...).
//
// Por que existe: o log de um job só é legível com login, mesmo em repositório
// público, mas as anotações são públicas e aparecem na página da execução e na API.
// Assim uma falha de teste na CI pode ser lida sem abrir o log.
//
//   node scripts/annotate-junit.mjs <relatorio.xml>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const unescapeXml = value => String(value ?? '')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

const attribute = (attributes, name) => {
  const match = new RegExp(`${name}="([^"]*)"`).exec(attributes);
  return match ? unescapeXml(match[1]) : undefined;
};

// <testcase name="..."> ... <failure message="..."> ... </testcase>, ou <error .../>.
export const failuresFromJunit = xml => {
  const failures = [];
  const text = typeof xml === 'string' ? xml : '';
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const body = match[2] ?? '';
    const problem = /<(failure|error)\b([^>]*?)(?:\/>|>)/.exec(body);
    if (!problem) continue;
    failures.push({
      name: attribute(match[1], 'name') ?? '(sem nome)',
      message: attribute(problem[2], 'message') ?? '(sem mensagem)'
    });
  }
  return failures;
};

const MAX_MESSAGE_LENGTH = 600;

// Escapes exigidos por comandos de workflow: %, CR e LF.
const escapeData = value => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = value => escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');

export const annotationLines = (failures, { limit = 10 } = {}) => {
  if (!failures.length) return [];
  const lines = failures.slice(0, limit).map(failure =>
    `::error title=${escapeProperty(failure.name.slice(0, 120))}::${escapeData(failure.message.slice(0, MAX_MESSAGE_LENGTH))}`);
  lines.push(`::notice title=Resumo dos testes::${failures.length} teste(s) falharam; ${Math.min(limit, failures.length)} mostrados`);
  return lines;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('annotate-junit: informe o relatorio .xml');
    process.exitCode = 1;
  } else {
    let xml = '';
    try {
      xml = readFileSync(file, 'utf8');
    } catch (error) {
      console.error(`annotate-junit: nao consegui ler ${file}: ${error.message}`);
    }
    for (const line of annotationLines(failuresFromJunit(xml))) console.log(line);
  }
}
