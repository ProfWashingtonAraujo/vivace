// Validação do cadastro de paciente (fase 2, área 3b). Devolve só os campos do cadastro
// que o servidor aceita do cliente: id, versão, status, sinais (dor, temperatura...) e
// dia de pós-operatório são do servidor, e a senha viaja à parte (nunca fica em `values`).
import { parseImageUpload } from './image-upload.mjs';

const MAX_NAME = 120;
const MAX_EMAIL = 120;
const MAX_SHORT = 30;
const MAX_CPF = 20;
const MAX_TEXT = 120;
const MAX_AVATAR_URL = 500;
const MAX_AVATAR_BYTES = 512 * 1024;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
const MAX_CLIENT_ID = 100;
const MAX_TEAM = 20;

const asObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const has = (body, key) => body[key] !== undefined;

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Texto opcional: undefined se ausente, null se inválido.
const optionalText = (body, key, max) => {
  if (!has(body, key)) return undefined;
  if (typeof body[key] !== 'string') return null;
  const value = body[key].trim();
  return value.length <= max ? value : null;
};

// '' (sem data) ou AAAA-MM-DD que existe no calendário.
const validDate = value => {
  if (value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
};

// '' (usa o padrão), https curto ou imagem de verdade (jpeg, png ou webp).
export const validAvatar = value =>
  value === ''
  || (typeof value === 'string' && value.startsWith('https://') && value.length <= MAX_AVATAR_URL)
  || (typeof value === 'string' && value.startsWith('data:') && parseImageUpload(value, MAX_AVATAR_BYTES) !== null);

const TEXT_FIELDS = [['gender', MAX_SHORT], ['phone', MAX_SHORT], ['cpf', MAX_CPF], ['procedure', MAX_TEXT], ['hospital', MAX_TEXT]];

export const validatePatient = (input, { partial = false } = {}) => {
  const body = asObject(input);
  const values = {};

  const name = optionalText(body, 'name', MAX_NAME);
  if (name === null || name === '') return { ok: false };
  if (name !== undefined) values.name = name;

  if (has(body, 'email')) {
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!EMAIL.test(email) || email.length > MAX_EMAIL) return { ok: false };
    values.email = email;
  }

  if (has(body, 'age')) {
    if (!Number.isInteger(body.age) || body.age < 0 || body.age > 130) return { ok: false };
    values.age = body.age;
  }

  for (const [key, max] of TEXT_FIELDS) {
    const value = optionalText(body, key, max);
    if (value === null) return { ok: false };
    if (value !== undefined) values[key] = value;
  }

  for (const key of ['surgeryDate', 'dischargeDate']) {
    if (has(body, key)) {
      if (!validDate(body[key])) return { ok: false };
      values[key] = body[key];
    }
  }

  if (has(body, 'avatar')) {
    if (!validAvatar(body.avatar)) return { ok: false };
    values.avatar = body.avatar;
  }

  const clientId = typeof body.clientId === 'string' && body.clientId && body.clientId.length <= MAX_CLIENT_ID ? body.clientId : undefined;

  if (partial) return { ok: true, values, password: undefined, clientId };

  if (!values.name || !values.email) return { ok: false };
  const password = validatePassword({ password: body.password });
  if (!password.ok) return { ok: false };
  values.age ??= 0;
  for (const [key] of TEXT_FIELDS) values[key] ??= '';
  values.surgeryDate ??= '';
  values.dischargeDate ??= '';
  values.avatar ??= '';
  return { ok: true, values, password: password.password, clientId };
};

export const validatePassword = input => {
  const password = asObject(input).password;
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return { ok: false };
  return { ok: true, password };
};

// A ordem importa: o primeiro da lista é o cirurgião, os demais são equipe.
export const validateCareTeam = input => {
  const ids = asObject(input).professionalIds;
  const valid = Array.isArray(ids)
    && ids.length <= MAX_TEAM
    && ids.every(id => typeof id === 'string' && id && id.length <= MAX_CLIENT_ID)
    && new Set(ids).size === ids.length;
  return valid ? { ok: true, professionalIds: [...ids] } : { ok: false };
};

// Dias desde a cirurgia, contando o meio-dia de São Paulo, como o front faz. Futuro,
// vazio ou inválido vira 0.
export const postOpDay = (surgeryDate, now = new Date()) => {
  if (!validDate(surgeryDate) || surgeryDate === '') return 0;
  const surgery = new Date(`${surgeryDate}T12:00:00-03:00`);
  return Math.max(0, Math.floor((now.getTime() - surgery.getTime()) / 86_400_000));
};

export const defaultAvatar = name =>
  `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=E6F0FA&color=0B5CAB`;
