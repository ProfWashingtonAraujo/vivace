import { createHash, randomUUID, scrypt as scryptCallback } from 'node:crypto';
import { readAggregate, readPatient } from './aggregate.mjs';
import { asAdmin, createPool, withSession } from './session.mjs';
import { exceedsDeletionLimit, idsMarkedRead } from '../lib/state-guards.mjs';
import { brDateTime } from '../lib/br-time.mjs';
import { reviewTimelineTitle } from '../lib/staff-actions.mjs';

const pool = createPool();

export const closeStore = () => pool.end();

const hashPassword = async (salt, password) => {
  const key = await new Promise((resolve, reject) => {
    scryptCallback(password, salt, 64, (error, derived) => (error ? reject(error) : resolve(derived)));
  });
  return `scrypt$${salt}$${key.toString('hex')}`;
};


const isHashed = value => typeof value === 'string' && value.startsWith('scrypt$');
const normalize = value => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const parseSurgeon = value => {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  return { name: normalize(match ? match[1] : raw), council: normalize(match ? match[2] : '') };
};

const photoImage = imageUrl => {
  const value = String(imageUrl ?? '');
  if (value.startsWith('data:image/')) {
    const comma = value.indexOf(',');
    if (comma > 0) {
      return { image: Buffer.from(value.slice(comma + 1), 'base64'), mime: value.slice('data:'.length, value.indexOf(';')), url: null };
    }
  }
  return { image: null, mime: null, url: value || null };
};

const medicationAdherence = medications => {
  const slots = medications.flatMap(medication => (medication.times ?? []).map(time => medication.takenToday?.[time]));
  return slots.length ? Math.round(slots.filter(Boolean).length / slots.length * 100) : 100;
};

const severityFor = checkIn => checkIn.painLevel >= 7 || checkIn.temperature >= 37.8
  ? 'critico'
  : checkIn.painLevel >= 4 || checkIn.temperature >= 37.3
    ? 'atencao'
    : 'estavel';

const notFound = () => Object.assign(new Error('Patient not found'), { statusCode: 404 });
const denied = () => Object.assign(new Error('Insufficient permissions'), { statusCode: 403 });

// ------------------------------------------------------------------ leitura

// O RLS ja filtra: o que a sessao nao pode ver simplesmente nao volta.
export const readState = session => withSession(pool, session, client => readAggregate(client));

export const findAccount = async identifier => {
  // app_lookup_account e SECURITY DEFINER, entao ignora os GUCs de sessao e
  // alcanca a conta mesmo sem um papel definido. Precisa de um contexto porque
  // o runner sempre abre transacao.
  return withSession(pool, { role: '', userId: '' }, async client => {
    const result = await client.query('SELECT * FROM app_lookup_account($1)', [identifier]);
    const row = result.rows[0];
    if (!row) return null;
    return { role: row.role, userId: row.user_id, name: row.name, email: row.email, passwordHash: row.password_hash };
  });
};

// Quem pode receber eventos de um paciente no stream (SSE), pela mesma regra de
// app_can_access_patient: a equipe do paciente, ou qualquer profissional enquanto
// ele não tem equipe. Contexto admin porque patient_care_team tem RLS e um
// profissional só veria as próprias linhas.
export const patientAudience = patientId => asAdmin(pool, async client => {
  const { rows } = await client.query('SELECT professional_id FROM patient_care_team WHERE patient_id = $1', [patientId]);
  return { everyone: rows.length === 0, professionalIds: rows.map(row => row.professional_id) };
});

// Cria o primeiro administrador quando ainda não existe nenhum. É app_bootstrap_admin
// (SECURITY DEFINER, migração 014) que decide e grava, de forma atômica, com o papel
// normal da aplicação: o runtime não precisa de conexão de dono. Devolve true só
// quando criou; se já havia admin, não toca em nada, nem na senha dele.
export const bootstrapAdmin = async ({ id, name, email, password }) => {
  const salt = randomUUID().replace(/-/g, '').slice(0, 16);
  const passwordHash = await hashPassword(salt, password);
  return withSession(pool, { role: '', userId: '' }, async client => {
    const result = await client.query('SELECT app_bootstrap_admin($1, $2, $3, $4) AS created', [id, name, email, passwordHash]);
    return result.rows[0].created === true;
  });
};

// Senha antiga em texto plano vira hash no primeiro login valido. Passa por
// app_set_credential, o mesmo caminho de escrita das senhas do PUT.
export const rehashAccount = async (account, password) => {
  if (isHashed(account.passwordHash)) return false;
  const salt = randomUUID().replace(/-/g, '').slice(0, 16);
  const passwordHash = await hashPassword(salt, password);
  await withSession(pool, { role: '', userId: '' }, client =>
    client.query('SELECT app_set_credential($1, $2, $3)', [account.userId, account.role, passwordHash]));
  return true;
};

// ------------------------------------------------------------------ sessoes
//
// Estas operações não usam withSession de propósito. A tabela de sessão não tem
// policy (a decisão e o comentário da 011 e da 012), então não existe papel para
// avaliar, e o BEGIN/set_config/COMMIT de withSession custaria três idas e voltas
// ao banco no caminho quente de toda requisição autenticada. Sem transação, um
// SELECT de sessão é uma ida só.

// O token em claro não é a chave: o banco guarda sha256 dele, e a linha é procurada
// pelo resumo. Uma leitura da base -- dump, réplica, backup, injeção em outra tabela
// -- devolve resumos, que não dá para reapresentar como token. Mesmo argumento da
// 006, que isolou o hash de senha em account_credentials.
//
// sha256 e não scrypt: o token tem 256 bits do CSPRNG e não tem dicionário, então
// não há o que forçar. O custo de um scrypt aqui (~100ms) pagaria em toda requisição
// autenticada para proteger algo que não sofre ataque de força bruta.
const tokenHash = token => createHash('sha256').update(token).digest('hex');

export const findSession = async token => {
  if (!token) return null;
  const { rows } = await pool.query(
    // A expiração é absoluta e quem decide é o relógio do banco. Traz só as três
    // colunas que o servidor usa: ler expires_at devolve timestamptz e não há ganho
    // em pagá-lo no Node.
    'SELECT role, user_id, name FROM sessions WHERE token_hash = $1 AND expires_at > now()',
    [tokenHash(token)]
  );
  const row = rows[0];
  return row ? { role: row.role, userId: row.user_id, name: row.name } : null;
};

// O TTL é absoluto: expires_at é gravado uma vez, no login. O TTL deslizante do
// Map reescrevia o vencimento a cada requisição, e isso viraria um UPDATE por
// request. O prazo também é calculado por now() no banco, para valer igual em
// qualquer réplica.
export const createSession = ({ token, role, userId, name, ttlMs }) =>
  pool.query(
    `INSERT INTO sessions (token_hash, role, user_id, name, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::double precision / 1000))`,
    [tokenHash(token), role, userId, name, ttlMs]
  ).then(() => token);

export const deleteSession = token =>
  pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]).then(() => undefined);

// ------------------------------------------------- bloqueio de login

// O pior caso entre as chaves (o IP e a conta). bigint volta como string no
// node-postgres, daí o Number.
export const loginLockoutRemaining = async keys => {
  const { rows } = await pool.query('SELECT app_login_lockout_ms($1::text[]) AS remaining', [keys]);
  return Number(rows[0].remaining);
};

// A contagem mora em app_record_login_failure porque precisa ser um
// read-modify-write atômico. As várias chaves vão na mesma instrução, via unnest,
// para que registrar a falha continue custando uma ida ao banco.
export const recordLoginFailure = (keys, { windowMs, lockoutMs, maxAttempts }) =>
  pool.query(
    'SELECT app_record_login_failure(k, $1, $2, $3) FROM unnest($4::text[]) AS k',
    [windowMs, lockoutMs, maxAttempts, keys]
  ).then(() => undefined);

export const clearLoginFailures = keys =>
  pool.query('DELETE FROM login_attempts WHERE key = ANY($1::text[])', [keys]).then(() => undefined);

// O que sweepLoginAttempts fazia no Map, agora em dois DELETEs indexados. As
// leituras já expiram sozinhas (o filtro de janela e de locked_until estão nas
// queries), então isto é só higiene: sem isso, sessões mortas e chaves
// esquecidas ficariam para sempre.
export const purgeExpiredAuth = windowMs =>
  pool.query(
    `WITH purged AS (DELETE FROM sessions WHERE expires_at <= now())
     DELETE FROM login_attempts
     WHERE first_attempt_at <= now() - make_interval(secs => $1::double precision / 1000)`,
    [windowMs]
  ).then(() => undefined);

// ------------------------------------------------------------------ escrita

// As colunas do schema sao NOT NULL com default, entao `?? null` estouraria a
// constraint quando o item do JSON nao tem o campo. Colunas numericas e booleanas
// recebem o tipo certo, nunca ''.
const numericColumns = new Set(['pain_level', 'temperature', 'position', 'age', 'post_op_day', 'current_pain', 'heart_rate', 'medication_adherence_percent']);
const booleanColumns = new Set(['photo_uploaded', 'important', 'is_read', 'wound_review_pending']);
const arrayColumns = new Set(['symptoms', 'allergies']);

const columnValue = (column, item, defaults) => {
  const value = item[column];
  if (value === undefined || value === null) return defaults[column] ?? (arrayColumns.has(column) ? [] : '');
  if (numericColumns.has(column)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : (defaults[column] ?? 0);
  }
  if (booleanColumns.has(column)) return Boolean(value);
  if (arrayColumns.has(column)) return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  return value;
};

const childWrites = {
  timeline_events: {
    collection: 'timeline',
    columns: ['date', 'day_label', 'title', 'description', 'author', 'type'],
    defaults: {}
  },
  wound_photos: {
    collection: 'woundPhotos',
    columns: ['date', 'day_label', 'patient_notes', 'reviewed_by', 'reviewed_at', 'review_status', 'review_feedback'],
    defaults: { review_status: 'pendente' }
  },
  medications: {
    collection: 'medications',
    columns: ['name', 'dose', 'frequency', 'purpose', 'instructions'],
    defaults: {}
  },
  check_ins: {
    collection: 'checkIns',
    columns: ['date', 'day_label', 'pain_level', 'temperature', 'mobility_score', 'symptoms', 'notes', 'mood', 'photo_uploaded'],
    defaults: { pain_level: 0, temperature: 36.5, mobility_score: 'repouso_absoluto', mood: 'bem', photo_uploaded: false, symptoms: [] }
  },
  instructions: {
    collection: 'instructions',
    columns: ['category', 'title', 'content', 'icon_name', 'important'],
    defaults: { important: false }
  },
  clinical_notes: {
    collection: 'clinicalNotes',
    columns: ['author', 'date', 'text'],
    defaults: {}
  }
};

// `messages` fica de fora de childWrites de proposito: o PUT faz uniao, nunca
// apaga, porque a mensagem chega por POST /api/messages e o corpo inteiro do PUT
// seria uma copia possivelmente desatualizada. Era o que mergeMessages fazia em
// memoria.

const writeChildren = async (client, table, patientId, items, columns, defaults) => {
  for (const [index, item] of items.entries()) {
    if (!item || typeof item.id !== 'string') continue;
    try {
      await client.query(
        `INSERT INTO ${table} (patient_id, id, position, ${columns.join(', ')})
         VALUES ($1, $2, $3, ${columns.map((_, offset) => `$${offset + 4}`).join(', ')})
         ON CONFLICT (patient_id, id) DO UPDATE SET
           position = EXCLUDED.position,
           ${columns.map(column => `${column} = EXCLUDED.${column}`).join(', ')}`,
        [patientId, item.id, index, ...columns.map(column => columnValue(column, item, defaults))]
      );
    } catch (error) {
      // Sem o contexto, "invalid input syntax for type integer" nao diz nada.
      throw Object.assign(error, { message: `${table}/${item.id}: ${error.message}` });
    }
  }
  const ids = items.map(item => item?.id).filter(id => typeof id === 'string');
  await client.query(
    `DELETE FROM ${table} WHERE patient_id = $1 AND NOT (id = ANY($2::text[]))`,
    [patientId, ids]
  );
};

// Coleções que o PUT só acrescenta ou atualiza, nunca apaga: linha do tempo,
// check-ins e notas clínicas. Elas são criadas por outras rotas (o paciente faz
// check-in, o servidor registra a linha do tempo) e nenhuma tela apaga um item, então
// "o que não veio no corpo" quer dizer "o corpo é antigo", não "apague". A posição de
// um item que já existe não é reescrita; um item novo recebe a posição pelo lado certo
// da lista: no início (check-ins e notas, mais novo primeiro) ou no fim (linha do tempo).
const appendOnlyPlacement = {
  timeline_events: 'last',
  check_ins: 'first',
  clinical_notes: 'first'
};

const writeAppendOnly = async (client, table, patientId, items, columns, defaults) => {
  const placement = appendOnlyPlacement[table];
  const position = placement === 'first'
    ? `(SELECT coalesce(min(position), 1) - 1 FROM ${table} WHERE patient_id = $1)`
    : `(SELECT coalesce(max(position) + 1, 0) FROM ${table} WHERE patient_id = $1)`;
  // 'first' percorre do fim para o início, para que o item mais novo do corpo
  // termine com a menor posição; 'last' mantém a ordem do corpo.
  const ordered = placement === 'first' ? [...items].reverse() : items;
  for (const item of ordered) {
    if (!item || typeof item.id !== 'string') continue;
    try {
      await client.query(
        `INSERT INTO ${table} (patient_id, id, position, ${columns.join(', ')})
         VALUES ($1, $2, ${position}, ${columns.map((_, offset) => `$${offset + 3}`).join(', ')})
         ON CONFLICT (patient_id, id) DO UPDATE SET
           ${columns.map(column => `${column} = EXCLUDED.${column}`).join(', ')}`,
        [patientId, item.id, ...columns.map(column => columnValue(column, item, defaults))]
      );
    } catch (error) {
      throw Object.assign(error, { message: `${table}/${item.id}: ${error.message}` });
    }
  }
};

const writeMedications = async (client, patientId, medications) => {
  for (const [index, medication] of (medications ?? []).entries()) {
    if (!medication || typeof medication.id !== 'string') continue;
    await client.query(
      `INSERT INTO medications (patient_id, id, position, name, dose, frequency, purpose, instructions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (patient_id, id) DO UPDATE SET
         position = EXCLUDED.position, name = EXCLUDED.name, dose = EXCLUDED.dose,
         frequency = EXCLUDED.frequency, purpose = EXCLUDED.purpose, instructions = EXCLUDED.instructions`,
      [patientId, medication.id, index, medication.name ?? '', medication.dose ?? '',
        medication.frequency ?? '', medication.purpose ?? '', medication.instructions ?? '']
    );
    const times = Array.isArray(medication.times) ? medication.times : [];
    for (const [timeIndex, time] of times.entries()) {
      await client.query(
        `INSERT INTO medication_times (patient_id, medication_id, time, position) VALUES ($1,$2,$3,$4)
         ON CONFLICT (patient_id, medication_id, time) DO UPDATE SET position = EXCLUDED.position`,
        [patientId, medication.id, time, timeIndex]
      );
      await client.query(
        `INSERT INTO medication_doses (patient_id, medication_id, time, taken) VALUES ($1,$2,$3,$4)
         ON CONFLICT (patient_id, medication_id, time) DO UPDATE SET taken = EXCLUDED.taken`,
        [patientId, medication.id, time, Boolean(medication.takenToday?.[time])]
      );
    }
    await client.query(
      `DELETE FROM medication_times WHERE patient_id = $1 AND medication_id = $2 AND NOT (time = ANY($3::text[]))`,
      [patientId, medication.id, times]
    );
    await client.query(
      `DELETE FROM medication_doses WHERE patient_id = $1 AND medication_id = $2 AND NOT (time = ANY($3::text[]))`,
      [patientId, medication.id, times]
    );
  }
  const ids = (medications ?? []).map(medication => medication?.id).filter(id => typeof id === 'string');
  await client.query(
    `DELETE FROM medications WHERE patient_id = $1 AND NOT (id = ANY($2::text[]))`,
    [patientId, ids]
  );
};

// Fotos da ferida só crescem pelo PUT: quem as cria é o paciente (POST /api/checkins)
// e nenhuma tela as apaga. Antes o PUT apagava toda foto que não estivesse no corpo,
// então uma foto enviada pelo paciente depois da última leitura da equipe sumia no
// próximo salvamento. A posição de uma foto que já existe também não é reescrita
// com o índice do corpo, para não empatar com a foto nova que o corpo desconhece.
const writePhotos = async (client, patientId, photos) => {
  // Do fim para o início, para que a foto mais nova do corpo fique com a menor posição.
  for (const photo of [...(photos ?? [])].reverse()) {
    if (!photo || typeof photo.id !== 'string') continue;
    const { image, mime, url } = photoImage(photo.imageUrl);
    await client.query(
      `INSERT INTO wound_photos (patient_id, id, position, date, day_label, image, image_mime,
         image_source_url, patient_notes, reviewed_by, reviewed_at, review_status, review_feedback)
       VALUES ($1,$2,(SELECT coalesce(min(position), 1) - 1 FROM wound_photos WHERE patient_id = $1),
         $3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (patient_id, id) DO UPDATE SET
         date = EXCLUDED.date, day_label = EXCLUDED.day_label,
         image = EXCLUDED.image, image_mime = EXCLUDED.image_mime,
         image_source_url = EXCLUDED.image_source_url, patient_notes = EXCLUDED.patient_notes,
         reviewed_by = EXCLUDED.reviewed_by, reviewed_at = EXCLUDED.reviewed_at,
         review_status = EXCLUDED.review_status, review_feedback = EXCLUDED.review_feedback`,
      [patientId, photo.id, photo.date ?? '', photo.dayLabel ?? '', image, mime, url,
        photo.patientNotes ?? '', photo.reviewedBy ?? '', photo.reviewedAt ?? '',
        photo.reviewStatus ?? 'pendente', photo.reviewFeedback ?? '']
    );
  }
};

// account_credentials nao tem SELECT para a aplicacao (nem privilegio, nem
// policy). Isso impede ate um UPDATE ... WHERE, porque citar coluna no WHERE
// exige SELECT sobre ela. A escrita passa por app_set_credential, que e
// SECURITY DEFINER, como o login ja usava app_lookup_account.
const storePassword = async (client, accountId, role, password) => {
  if (typeof password !== 'string' || !password) return;
  const passwordHash = isHashed(password)
    ? password
    : await hashPassword(randomUUID().replace(/-/g, '').slice(0, 16), password);
  await client.query('SELECT app_set_credential($1, $2, $3)', [accountId, role, passwordHash]);
};

const writePatient = async (client, patient, { role, userId }) => {
  const contact = patient.emergencyContact ?? {};
  await client.query(
    `INSERT INTO patients (
       id, name, age, gender, avatar, email, phone, cpf, procedure, surgery_date, discharge_date,
       hospital, anesthesia_type, allergies, status, post_op_day, last_check_in_time, current_pain,
       current_temp, blood_pressure, heart_rate, wound_review_pending, medication_adherence_percent,
       emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
       position, surgeon_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, age = EXCLUDED.age, gender = EXCLUDED.gender, avatar = EXCLUDED.avatar,
       email = EXCLUDED.email, phone = EXCLUDED.phone, cpf = EXCLUDED.cpf, procedure = EXCLUDED.procedure,
       surgery_date = EXCLUDED.surgery_date, discharge_date = EXCLUDED.discharge_date,
       hospital = EXCLUDED.hospital, anesthesia_type = EXCLUDED.anesthesia_type,
       allergies = EXCLUDED.allergies, status = EXCLUDED.status, post_op_day = EXCLUDED.post_op_day,
       last_check_in_time = EXCLUDED.last_check_in_time, current_pain = EXCLUDED.current_pain,
       current_temp = EXCLUDED.current_temp, blood_pressure = EXCLUDED.blood_pressure,
       heart_rate = EXCLUDED.heart_rate, wound_review_pending = EXCLUDED.wound_review_pending,
       medication_adherence_percent = EXCLUDED.medication_adherence_percent,
       emergency_contact_name = EXCLUDED.emergency_contact_name,
       emergency_contact_phone = EXCLUDED.emergency_contact_phone,
       emergency_contact_relationship = EXCLUDED.emergency_contact_relationship,
       position = EXCLUDED.position, surgeon_label = EXCLUDED.surgeon_label`,
    [patient.id, patient.name, patient.age ?? 0, patient.gender ?? '', patient.avatar ?? '',
      patient.email, patient.phone ?? '', patient.cpf ?? '', patient.procedure ?? '',
      patient.surgeryDate ?? '', patient.dischargeDate ?? '', patient.hospital ?? '',
      patient.anesthesiaType ?? '', patient.allergies ?? [], patient.status ?? 'estavel',
      patient.postOpDay ?? 0, patient.lastCheckInTime ?? '', patient.currentPain ?? 0,
      patient.currentTemp ?? 36.5, patient.bloodPressure ?? '', patient.heartRate ?? 0,
      patient.woundReviewPending ?? false, medicationAdherence(patient.medications ?? []),
      contact.name ?? '', contact.phone ?? '', contact.relationship ?? '',
      patient.position ?? 0, patient.surgeon ?? '']
  );
  await storePassword(client, patient.id, 'patient', patient.password);

  // O vinculo de acesso vem do rotulo de cirurgiao, como o import faz. Se nao
  // der para resolver (cirurgiao sem cadastro), o rotulo ja foi salvo acima e a
  // equipe fica como esta: um profissional nunca rouba a equipe de outro.
  const { name, council } = parseSurgeon(patient.surgeon);
  if (name || council) {
    const resolved = (await client.query('SELECT id, name, crm_coren FROM professionals')).rows
      .find(professional => {
        const professionalName = normalize(professional.name);
        const professionalCouncil = normalize(professional.crm_coren);
        if (council && professionalCouncil && council.includes(professionalCouncil)) return true;
        return name.length >= 3 && professionalName && professionalName.startsWith(name);
      });
    if (resolved) {
      const existing = (await client.query(
        'SELECT professional_id FROM patient_care_team WHERE patient_id = $1 AND role = $2',
        [patient.id, 'cirurgiao']
      )).rows;
      if (!existing.length) {
        await client.query(
          `INSERT INTO patient_care_team (patient_id, professional_id, role, position)
           VALUES ($1,$2,'cirurgiao',0) ON CONFLICT (patient_id, professional_id) DO NOTHING`,
          [patient.id, resolved.id]
        );
      } else if (role === 'admin' && !existing.some(row => row.professional_id === resolved.id)) {
        await client.query(`DELETE FROM patient_care_team WHERE patient_id = $1 AND role = 'cirurgiao'`, [patient.id]);
        await client.query(
          `INSERT INTO patient_care_team (patient_id, professional_id, role, position) VALUES ($1,$2,'cirurgiao',0)`,
          [patient.id, resolved.id]
        );
      }
    }
  }
  void userId;

  for (const [table, definition] of Object.entries(childWrites)) {
    const items = patient[definition.collection] ?? [];
    if (table === 'medications') {
      await writeMedications(client, patient.id, items);
      continue;
    }
    if (table === 'wound_photos') {
      await writePhotos(client, patient.id, items);
      continue;
    }
    if (table in appendOnlyPlacement) {
      await writeAppendOnly(client, table, patient.id, items, definition.columns, definition.defaults);
      continue;
    }
    await writeChildren(client, table, patient.id, items, definition.columns, definition.defaults);
  }

  // Mensagens: o PUT só marca como lida uma mensagem que já existe. Remetente, nome e
  // texto nunca vêm do corpo; mensagens novas nascem em POST /api/messages, onde o
  // remetente sai da sessão.
  const readIds = idsMarkedRead(patient.messages);
  if (readIds.length) {
    await client.query(
      'UPDATE messages SET is_read = true WHERE patient_id = $1 AND id = ANY($2::text[]) AND NOT is_read',
      [patient.id, readIds]
    );
  }
};

const writeProfessionals = async (client, professionals) => {
  for (const [index, professional] of professionals.entries()) {
    if (!professional || typeof professional.id !== 'string') continue;
    await client.query(
      `INSERT INTO professionals (id, name, job_title, crm_coren, avatar, email, specialty, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, job_title = EXCLUDED.job_title, crm_coren = EXCLUDED.crm_coren,
         avatar = EXCLUDED.avatar, email = EXCLUDED.email, specialty = EXCLUDED.specialty,
         position = EXCLUDED.position`,
      [professional.id, professional.name ?? '', professional.role ?? '', professional.crmCoren ?? '',
        professional.avatar ?? '', professional.email, professional.specialty ?? '', index]
    );
    await storePassword(client, professional.id, 'professional', professional.password);
  }
  const ids = professionals.map(professional => professional?.id).filter(id => typeof id === 'string');
  await client.query('DELETE FROM professionals WHERE NOT (id = ANY($1::text[]))', [ids]);
};

const writeAdmins = async (client, admins) => {
  for (const [index, admin] of admins.entries()) {
    if (!admin || typeof admin.id !== 'string') continue;
    await client.query(
      `INSERT INTO admins (id, name, email, position) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, position = EXCLUDED.position`,
      [admin.id, admin.name ?? '', admin.email, index]
    );
    await storePassword(client, admin.id, 'admin', admin.password);
  }
  const ids = admins.map(admin => admin?.id).filter(id => typeof id === 'string');
  await client.query('DELETE FROM admins WHERE NOT (id = ANY($1::text[]))', [ids]);
};

// PUT /api/state. O corpo chega inteiro e nao ha diff: cada colecao e reescrita
// na ordem do array, e o que nao veio e apagado. O RLS e o que impede o estrago
// entre profissionais: apagar um paciente que a sessao nao enxerga simplesmente
// nao apaga nada, enquanto antes isso exigia reinserir a lista proibida na mao
// (rejectForeignPatients).
export const putState = (session, incoming) => withSession(pool, session, async client => {
  if (session.role === 'patient') throw denied();

  // O payload carrega o professionals e o admins do estado local do frontend,
  // que para quem nao e admin sao os mocks do bundle. Escrever neles sobrescreveria
  // cadastro e senha de verdade, entao so o admin escreve essas duas colecoes.
  if (session.role === 'admin') {
    await writeAdmins(client, incoming.admins ?? []);
    await writeProfessionals(client, incoming.professionals ?? []);
  }

  const patients = incoming.patients ?? [];

  // Antes de gravar qualquer coisa: um salvamento que apagaria vários pacientes de uma
  // vez vem de estado velho ou de lista vazia. O RLS já limita a contagem ao que a
  // sessão enxerga. Responde 409 e a transação nem começa a escrever.
  const keepIds = patients.map(patient => patient?.id).filter(id => typeof id === 'string');
  const doomed = await client.query('SELECT count(*)::int AS total FROM patients WHERE NOT (id = ANY($1::text[]))', [keepIds]);
  if (exceedsDeletionLimit(doomed.rows[0].total)) {
    throw Object.assign(new Error('Mass patient deletion refused'), { statusCode: 409 });
  }

  for (const [index, patient] of patients.entries()) {
    if (!patient || typeof patient.id !== 'string') continue;
    await writePatient(client, { ...patient, position: index }, session);
  }
  const ids = patients.map(patient => patient?.id).filter(id => typeof id === 'string');
  await client.query('DELETE FROM patients WHERE NOT (id = ANY($1::text[]))', [ids]);
  return { saved: true };
});

export const insertMessage = (session, { patientId, text, sender, senderName, clientMessageId }) =>
  withSession(pool, session, async client => {
    const visible = await client.query('SELECT 1 FROM patients WHERE id = $1', [patientId]);
    if (!visible.rows.length) throw notFound();
    const messageId = typeof clientMessageId === 'string' && clientMessageId ? clientMessageId : `msg-${randomUUID()}`;
    const existing = await client.query('SELECT * FROM messages WHERE patient_id = $1 AND id = $2', [patientId, messageId]);
    if (existing.rows[0]) return existing.rows[0];
    const timestamp = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date());
    const { rows } = await client.query(
      `INSERT INTO messages (patient_id, id, position, sender, sender_name, timestamp, text, is_read)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false)
       RETURNING id, sender, sender_name, timestamp, text, is_read`,
      [patientId, messageId,
        (await client.query('SELECT coalesce(max(position) + 1, 0) AS next FROM messages WHERE patient_id = $1', [patientId])).rows[0].next,
        sender, senderName, timestamp, text]
    );
    return rows[0];
  });

const patientTimestamp = date => new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
}).format(date);

export const insertCheckIn = (session, { patientId, checkIn, photo }) =>
  withSession(pool, session, async client => {
    const patient = await readPatient(client, patientId);
    if (!patient) throw notFound();
    const already = await client.query('SELECT 1 FROM check_ins WHERE patient_id = $1 AND id = $2', [patientId, checkIn.id]);
    if (already.rows.length) return patient;

    const now = new Date();
    const time = patientTimestamp(now);
    const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(now);
    const dayLabel = checkIn.dayLabel || `D+${patient.postOpDay}`;

    // A UI le checkIns[0] como "hoje", entao o novo entra no inicio da lista.
    await client.query(
      `UPDATE check_ins SET position = position + 1 WHERE patient_id = $1`, [patientId]
    );
    await client.query(
      `INSERT INTO check_ins (patient_id, id, position, date, day_label, pain_level, temperature,
         mobility_score, symptoms, notes, mood, photo_uploaded)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [patientId, checkIn.id, 0, date, dayLabel, checkIn.painLevel, checkIn.temperature,
        checkIn.mobilityScore ?? 'repouso_absoluto', checkIn.symptoms ?? [], checkIn.notes ?? '',
        checkIn.mood ?? 'bem', Boolean(photo?.imageUrl)]
    );
    await client.query(
      `UPDATE patients SET current_pain = $1, current_temp = $2, last_check_in_time = $3, status = $4
       WHERE id = $5`,
      [checkIn.painLevel, checkIn.temperature, `Hoje às ${time}`,
        severityFor({ painLevel: checkIn.painLevel, temperature: checkIn.temperature }), patientId]
    );
    await appendTimeline(client, patientId, {
      id: `tl-${checkIn.id}`,
      date: `${date} ${time}`,
      dayLabel,
      title: `Check-in Diário (${dayLabel})`,
      description: `Dor ${checkIn.painLevel}/10, Temp ${checkIn.temperature}°C. ${checkIn.notes ?? ''}`.trim(),
      author: `${patient.name} (Paciente)`,
      type: 'checkin'
    });

    if (photo?.imageUrl) {
      const photoId = photo.id || `wp-${checkIn.id}`;
      await client.query('UPDATE wound_photos SET position = position + 1 WHERE patient_id = $1', [patientId]);
      const { image, mime, url } = photoImage(photo.imageUrl);
      await client.query(
        `INSERT INTO wound_photos (patient_id, id, position, date, day_label, image, image_mime,
           image_source_url, patient_notes, review_status, review_feedback, reviewed_by, reviewed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pendente','','','')
         ON CONFLICT (patient_id, id) DO NOTHING`,
        [patientId, photoId, 0, date, dayLabel, image, mime, url, photo.patientNotes ?? '']
      );
      await client.query('UPDATE patients SET wound_review_pending = true WHERE id = $1', [patientId]);
      await appendTimeline(client, patientId, {
        id: `tl-${photoId}`,
        date: `${date} ${time}`,
        dayLabel,
        title: 'Nova Foto da Ferida Cirúrgica Enviada',
        description: photo.patientNotes || 'Registro fotográfico enviado para avaliação.',
        author: `${patient.name} (Paciente)`,
        type: 'curativo'
      });
    }
    return readPatient(client, patientId);
  });

// A timeline e lida na ordem em que os eventos aconteceram, entao o novo entra
// no fim, diferente de check_ins e wound_photos.
const appendTimeline = async (client, patientId, event) => {
  const position = (await client.query(
    'SELECT coalesce(max(position) + 1, 0) AS next FROM timeline_events WHERE patient_id = $1', [patientId]
  )).rows[0].next;
  await client.query(
    `INSERT INTO timeline_events (patient_id, id, position, date, day_label, title, description, author, type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (patient_id, id) DO NOTHING`,
    [patientId, event.id, position, event.date, event.dayLabel, event.title, event.description, event.author, event.type]
  );
};

export const toggleMedicationTaken = (session, { patientId, medicationId, time }) =>
  withSession(pool, session, async client => {
    const patient = await readPatient(client, patientId);
    if (!patient) throw notFound();
    const medication = patient.medications.find(item => item.id === medicationId);
    if (!medication || !medication.times.includes(time)) return patient;
    await client.query(
      `INSERT INTO medication_doses (patient_id, medication_id, time, taken) VALUES ($1,$2,$3,true)
       ON CONFLICT (patient_id, medication_id, time) DO UPDATE SET taken = NOT medication_doses.taken`,
      [patientId, medicationId, time]
    );
    const updated = medicationAdherence((await readPatient(client, patientId)).medications);
    await client.query('UPDATE patients SET medication_adherence_percent = $1 WHERE id = $2', [updated, patientId]);
    return readPatient(client, patientId);
  });

// ------------------------------------------------- acoes que so a equipe faz
//
// Cada uma decide no servidor o que o cliente não pode decidir: autor, revisor, data
// e id vêm da sessão e do relógio do servidor, e o corpo só traz a intenção.

// Nota clínica. `clientId` é a chave de idempotência: repetir a chamada com o mesmo
// valor devolve a nota que já existe em vez de criar outra.
export const addClinicalNote = (session, { patientId, text, clientId }) =>
  withSession(pool, session, async client => {
    if (session.role === 'patient') throw denied();
    const visible = await client.query('SELECT 1 FROM patients WHERE id = $1', [patientId]);
    if (!visible.rows.length) throw notFound();

    const id = clientId ?? `cn-${randomUUID()}`;
    const { date, time } = brDateTime();
    // ON CONFLICT DO NOTHING: duas chamadas simultâneas com o mesmo clientId não
    // quebram na chave primária, a segunda só não insere e cai na leitura abaixo.
    const inserted = await client.query(
      `INSERT INTO clinical_notes (patient_id, id, position, author, date, text)
       VALUES ($1, $2, (SELECT coalesce(min(position), 1) - 1 FROM clinical_notes WHERE patient_id = $1), $3, $4, $5)
       ON CONFLICT (patient_id, id) DO NOTHING
       RETURNING id, author, date, text`,
      [patientId, id, session.name, `${date} ${time}`, text]
    );
    if (inserted.rows[0]) return { note: inserted.rows[0], created: true };
    const existing = await client.query(
      'SELECT id, author, date, text FROM clinical_notes WHERE patient_id = $1 AND id = $2', [patientId, id]
    );
    return { note: existing.rows[0], created: false };
  });

const photoNotFound = () => Object.assign(new Error('Photo not found'), { statusCode: 404, publicMessage: 'Photo not found' });

// Avaliação de uma foto da ferida. O revisor é o usuário da sessão, a hora é a do
// servidor, e o evento da linha do tempo e a marca de "revisão pendente" do paciente
// são consequências da avaliação, registradas na mesma transação.
export const reviewWoundPhoto = (session, { patientId, photoId, status, feedback }) =>
  withSession(pool, session, async client => {
    if (session.role === 'patient') throw denied();
    const patient = await client.query('SELECT post_op_day FROM patients WHERE id = $1', [patientId]);
    if (!patient.rows.length) throw notFound();
    const photo = await client.query('SELECT 1 FROM wound_photos WHERE patient_id = $1 AND id = $2', [patientId, photoId]);
    if (!photo.rows.length) throw photoNotFound();

    const { date, time } = brDateTime();
    const reviewedAt = `${date} às ${time}`;
    await client.query(
      `UPDATE wound_photos
          SET review_status = $3, review_feedback = $4, reviewed_by = $5, reviewed_at = $6
        WHERE patient_id = $1 AND id = $2`,
      [patientId, photoId, status, feedback, session.name, reviewedAt]
    );

    const timelineEventId = `tl-${randomUUID()}`;
    await appendTimeline(client, patientId, {
      id: timelineEventId,
      date: `${date} ${time}`,
      dayLabel: `D+${patient.rows[0].post_op_day}`,
      title: reviewTimelineTitle(status),
      description: feedback,
      author: session.name,
      type: 'curativo'
    });

    // Mesma regra do front (isRealWoundPhoto): foto de demonstração, que só tem URL do
    // unsplash, não conta como pendente.
    const pending = (await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM wound_photos
          WHERE patient_id = $1 AND review_status = 'pendente'
            AND coalesce(image_source_url, '') NOT LIKE '%images.unsplash.com%') AS pending`,
      [patientId]
    )).rows[0].pending;
    await client.query('UPDATE patients SET wound_review_pending = $2 WHERE id = $1', [patientId, pending]);

    return {
      photo: { id: photoId, reviewStatus: status, reviewFeedback: feedback, reviewedBy: session.name, reviewedAt },
      timelineEventId,
      woundReviewPending: pending
    };
  });
