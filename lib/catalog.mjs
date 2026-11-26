// Validação de medicações e instruções (fase 2, área 2) e leitura do cabeçalho If-Match.
//
// Cada validador devolve só os campos que o servidor aceita do cliente. `id`, `version`
// e `takenToday` nunca passam por aqui: o id e a versão são decididos no servidor, e
// as doses tomadas são do paciente. Em modo parcial (editar) só voltam os campos que
// vieram, e um campo presente e inválido recusa a edição inteira.
const MAX_SHORT = 100;
const MAX_PURPOSE = 200;
const MAX_MEDICATION_INSTRUCTIONS = 500;
const MAX_TITLE = 120;
const MAX_CONTENT = 2_000;
const MAX_ICON = 50;
const MAX_TIMES = 12;
const MAX_INT = 2_147_483_647; // coluna integer do Postgres

const asObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const has = (body, key) => body[key] !== undefined;

// If-Match: a versão que o cliente leu. Aceita `3`, `"3"` e `W/"3"`. Ausente ou vazio é
// "faltando" (a chamada exige a precondição, 428); qualquer outra coisa que não seja um
// inteiro positivo é "inválido" (400), inclusive o curinga `*`.
export const parseIfMatch = header => {
  const raw = typeof header === 'string' ? header.trim() : '';
  if (!raw) return { ok: false, reason: 'missing' };
  const match = /^(?:W\/)?"?(\d+)"?$/.exec(raw);
  const version = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(version) || version < 1 || version > MAX_INT) return { ok: false, reason: 'invalid' };
  return { ok: true, version };
};

const clientIdOf = body =>
  typeof body.clientId === 'string' && body.clientId && body.clientId.length <= MAX_SHORT ? body.clientId : undefined;

// Texto curto opcional: devolve undefined se ausente, null se inválido.
const optionalText = (body, key, max) => {
  if (!has(body, key)) return undefined;
  if (typeof body[key] !== 'string') return null;
  const value = body[key].trim();
  return value.length <= max ? value : null;
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const validTimes = value =>
  Array.isArray(value)
  && value.length >= 1
  && value.length <= MAX_TIMES
  && value.every(time => typeof time === 'string' && TIME.test(time))
  && new Set(value).size === value.length;

export const validateMedication = (input, { partial = false } = {}) => {
  const body = asObject(input);
  const values = {};
  const fields = [['name', MAX_SHORT], ['dose', MAX_SHORT], ['frequency', MAX_SHORT], ['purpose', MAX_PURPOSE], ['instructions', MAX_MEDICATION_INSTRUCTIONS]];
  for (const [key, max] of fields) {
    const value = optionalText(body, key, max);
    if (value === null) return { ok: false };
    if (value !== undefined) values[key] = value;
  }
  if (values.name === '') return { ok: false };
  if (has(body, 'times')) {
    if (!validTimes(body.times)) return { ok: false };
    values.times = [...body.times];
  }
  if (!partial) {
    if (!values.name || !values.times) return { ok: false };
    for (const key of ['dose', 'frequency', 'purpose', 'instructions']) values[key] ??= '';
  }
  return { ok: true, values, clientId: clientIdOf(body) };
};

export const INSTRUCTION_CATEGORIES = ['curativo', 'alimentacao', 'atividade', 'higiene', 'alerta', 'medicacao'];

export const validateInstruction = (input, { partial = false } = {}) => {
  const body = asObject(input);
  const values = {};
  if (has(body, 'category')) {
    if (typeof body.category !== 'string' || !INSTRUCTION_CATEGORIES.includes(body.category)) return { ok: false };
    values.category = body.category;
  }
  const title = optionalText(body, 'title', MAX_TITLE);
  if (title === null || title === '') return { ok: false };
  if (title !== undefined) values.title = title;
  const content = optionalText(body, 'content', MAX_CONTENT);
  if (content === null) return { ok: false };
  if (content !== undefined) values.content = content;
  const iconName = optionalText(body, 'iconName', MAX_ICON);
  if (iconName === null) return { ok: false };
  if (iconName !== undefined) values.iconName = iconName;
  if (has(body, 'important')) {
    if (typeof body.important !== 'boolean') return { ok: false };
    values.important = body.important;
  }
  if (!partial) {
    if (!values.category || !values.title) return { ok: false };
    values.content ??= '';
    values.important ??= false;
  }
  return { ok: true, values, clientId: clientIdOf(body) };
};
