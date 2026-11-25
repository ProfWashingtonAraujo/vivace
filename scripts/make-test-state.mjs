// Gera o arquivo de estado para os testes de banco (api e RLS) na CI.
//
//   node scripts/make-test-state.mjs <arquivo-de-saida> [--force]
//
// O import dos testes lê o arquivo apontado por VIVACE_IMPORT_FILE e espera um
// administrador, `admin@vivace.med.br` com a senha de demonstração. O seed do
// repositório (db/seed/demo-state.json) não traz administrador, porque em produção
// ele nasce pelo bootstrap (app_bootstrap_admin). Aqui o seed ganha um, só para a
// base de teste.
//
// O caminho de saída é obrigatório de propósito: o padrão do import,
// .data/vivace-state.json, é o arquivo de dados de desenvolvimento de quem clona o
// projeto, e este script nunca escolhe um destino por conta própria nem sobrescreve
// um arquivo que já existe sem --force.
import { randomUUID, scrypt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = (salt, password) => new Promise((resolveHash, reject) => {
  scrypt(password, salt, 64, (error, key) => (error ? reject(error) : resolveHash(`scrypt$${salt}$${key.toString('hex')}`)));
});

export const withTestAdmin = async (state, { password = 'vivace-demo' } = {}) => {
  if (Array.isArray(state.admins) && state.admins.length) return { ...state };
  const salt = randomUUID().replace(/-/g, '').slice(0, 16);
  return {
    ...state,
    admins: [{ id: 'adm-1', name: 'Administrador', email: 'admin@vivace.med.br', password: await hash(salt, password) }]
  };
};

export const writeTestState = async (target, state, { force = false } = {}) => {
  if (typeof target !== 'string' || !target.trim()) {
    throw new Error('informe o caminho do arquivo de saida');
  }
  const file = resolve(target);
  if (existsSync(file) && !force) {
    throw new Error(`${file} ja existe; use --force para sobrescrever`);
  }
  const prepared = await withTestAdmin(state);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(prepared));
  return file;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const target = args.find(argument => !argument.startsWith('--'));
  try {
    const seed = JSON.parse(readFileSync(join(root, 'db', 'seed', 'demo-state.json'), 'utf8'));
    console.log(`estado de teste gravado em ${await writeTestState(target, seed, { force })}`);
  } catch (error) {
    console.error(`make-test-state: ${error.message}`);
    process.exitCode = 1;
  }
}
