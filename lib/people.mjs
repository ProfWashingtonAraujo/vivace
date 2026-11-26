// Validação de profissionais, administradores e status do paciente (fase 2, áreas 4 e 5).
// Devolve só os campos que o servidor aceita do cliente: id, versão e posição são do servidor,
// e a senha viaja à parte.
import { EMAIL, validAvatar, validatePassword } from './patient.mjs';

const MAX_NAME = 120;
const MAX_EMAIL = 120;
const MAX_ROLE = 60;
const MAX_CRM = 40;
const MAX_SPECIALTY = 60;
const MAX_CLIENT_ID = 100;

const asObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const has = (body, key) => body[key] !== undefined;

const optionalText = (body, key, max) => {
  if (!has(body, key)) return undefined;
  if (typeof body[key] !== 'string') return null;
  const value = body[key].trim();
  return value.length <= max ? value : null;
};

const clientIdOf = body =>
  typeof body.clientId === 'string' && body.clientId && body.clientId.length <= MAX_CLIENT_ID ? body.clientId : undefined;

// Nome e e-mail são comuns a profissional e administrador.
const readIdentity = (body, values) => {
  const name = optionalText(body, 'name', MAX_NAME);
  if (name === null || name === '') return false;
  if (name !== undefined) values.name = name;
  if (has(body, 'email')) {
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!EMAIL.test(email) || email.length > MAX_EMAIL) return false;
    values.email = email;
  }
  return true;
};

const finishCreate = (body, values, partial) => {
  const clientId = clientIdOf(body);
  if (partial) return { ok: true, values, password: undefined, clientId };
  const password = validatePassword({ password: body.password });
  if (!values.name || !values.email || !password.ok) return { ok: false };
  return { ok: true, values, password: password.password, clientId };
};

export const validateProfessional = (input, { partial = false } = {}) => {
  const body = asObject(input);
  const values = {};
  if (!readIdentity(body, values)) return { ok: false };
  for (const [key, max] of [['role', MAX_ROLE], ['crmCoren', MAX_CRM], ['specialty', MAX_SPECIALTY]]) {
    const value = optionalText(body, key, max);
    if (value === null) return { ok: false };
    if (value !== undefined) values[key] = value;
  }
  if (has(body, 'avatar')) {
    if (!validAvatar(body.avatar)) return { ok: false };
    values.avatar = body.avatar;
  }
  if (!partial) {
    values.role ??= '';
    values.crmCoren ??= '';
    values.specialty ??= '';
    values.avatar ??= '';
  }
  return finishCreate(body, values, partial);
};

export const validateAdmin = (input, { partial = false } = {}) => {
  const body = asObject(input);
  const values = {};
  if (!readIdentity(body, values)) return { ok: false };
  if (has(body, 'isSuper')) {
    if (typeof body.isSuper !== 'boolean') return { ok: false };
    values.isSuper = body.isSuper;
  }
  if (!partial) values.isSuper ??= false;
  return finishCreate(body, values, partial);
};

export const PATIENT_STATUSES = ['estavel', 'atencao', 'critico'];

export const validateStatus = input => {
  const status = asObject(input).status;
  return typeof status === 'string' && PATIENT_STATUSES.includes(status) ? { ok: true, status } : { ok: false };
};
