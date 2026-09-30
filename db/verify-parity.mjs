// Gate de paridade da migracao: reidrata o agregado do banco e compara com o
// JSON de origem, campo a campo. Divergencia sai com o caminho e os dois
// valores, para nao ser algo do tipo "os dados parecem iguais".

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { readAggregate } from './aggregate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = process.env.VIVACE_IMPORT_FILE ?? join(root, '.data', 'vivace-state.json');
const connectionString = process.env.MIGRATION_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://vivace:vivace@127.0.0.1:55432/vivace';
const maxReported = 25;

// O hash de senha nunca volta na API (server.mjs remove antes de responder), e
// no banco vira password_hash. Nao e divergencia: e proposital.
const stripPasswords = patient => {
  const { password, ...rest } = patient;
  return rest;
};

// O JSON de origem e antigo e misto: alguns check-ins nao tem `photoUploaded` e
// algumas instrucoes nao tem `important`, enquanto outros tem. A API passa a
// devolver a chave sempre, com o valor do banco. Ausente e default sao
// equivalentes para o frontend (ambos falsy), entao o gate preenche o default
// na colecao correspondente e conta quantas normalizacoes fez, em vez de
// esconder isso. Aplicar por colecao, e nao globalmente, para nao criar chaves
// onde o tipo do dominio nao as tem.
const collectionDefaults = {
  woundPhotos: { patientNotes: '', reviewedBy: '', reviewedAt: '', reviewFeedback: '' },
  checkIns: { photoUploaded: false, notes: '' },
  instructions: { important: false }
};

let normalizedCount = 0;

const withDefaults = (items, defaults) => (items ?? []).map(item => {
  const result = { ...item };
  for (const [key, value] of Object.entries(defaults)) {
    if (result[key] === undefined) {
      normalizedCount += 1;
      result[key] = value;
    }
  }
  return result;
});

const applyDefaults = patient => {
  const result = { ...patient };
  for (const [collection, defaults] of Object.entries(collectionDefaults)) {
    result[collection] = withDefaults(patient[collection], defaults);
  }
  return result;
};

const preview = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 90 ? `${text.slice(0, 90)}... (${text.length} chars)` : text;
};

const differences = [];

const compare = (expected, actual, path) => {
  if (differences.length >= maxReported) return;
  if (expected === actual) return;
  const bothNumbers = typeof expected === 'number' && typeof actual === 'number';
  if (bothNumbers && Number.isFinite(expected) && Number.isFinite(actual) && expected === actual) return;

  const expectedIsObject = expected && typeof expected === 'object';
  const actualIsObject = actual && typeof actual === 'object';
  if (expectedIsObject !== actualIsObject) {
    differences.push(`${path}: tipo ${expected === null ? 'null' : typeof expected} no JSON, ${actual === null ? 'null' : typeof actual} no banco`);
    return;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      differences.push(`${path}: JSON tem ${Array.isArray(expected) ? 'array' : typeof expected}, banco tem ${Array.isArray(actual) ? 'array' : typeof actual}`);
      return;
    }
    if (expected.length !== actual.length) {
      differences.push(`${path}: JSON tem ${expected.length} item(ns), banco tem ${actual.length}`);
      return;
    }
    expected.forEach((item, index) => compare(item, actual[index], `${path}[${index}]`));
    return;
  }
  if (expectedIsObject) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual ?? {})])) {
      compare(expected[key], actual?.[key], `${path}.${key}`);
      if (differences.length >= maxReported) return;
    }
    return;
  }
  differences.push(`${path}: JSON=${preview(expected)} banco=${preview(actual)}`);
};

const main = async () => {
  const source = JSON.parse(await readFile(stateFile, 'utf8'));
  const client = new pg.Client({ connectionString });
  await client.connect();
  let actual;
  try {
    actual = await readAggregate(client);
  } finally {
    await client.end();
  }

  const expected = {
    patients: (source.patients ?? []).map(patient => applyDefaults(stripPasswords(patient))),
    professionals: (source.professionals ?? []).map(({ password, ...rest }) => rest),
    admins: (source.admins ?? []).map(({ password, ...rest }) => rest)
  };

  compare(expected, actual, 'estado');

  const counts = (source.patients ?? []).map(patient =>
    `${patient.id} timeline=${patient.timeline?.length ?? 0} fotos=${patient.woundPhotos?.length ?? 0} ` +
    `meds=${patient.medications?.length ?? 0} checkins=${patient.checkIns?.length ?? 0} ` +
    `msgs=${patient.messages?.length ?? 0} instr=${patient.instructions?.length ?? 0} ` +
    `notas=${patient.clinicalNotes?.length ?? 0}`
  );

  console.log('contagens no JSON de origem:');
  for (const line of counts) console.log(`  ${line}`);
  console.log(`\nprofissionais=${expected.professionals.length} admins=${expected.admins.length} ` +
    `pacientes=${expected.patients.length} (reatrados do banco: ${actual.patients.length})`);
  console.log(`normalizacoes de campos opcionais ausentes no JSON: ${normalizedCount} ` +
    '(a API passa a devolver a chave sempre)');

  if (differences.length) {
    console.error(`\nFALHA: ${differences.length} divergencia(s) entre o JSON e o banco:`);
    for (const line of differences) console.error(`  ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nparidade OK: o agregado reidratado bate com o JSON de origem');
};

await main();
