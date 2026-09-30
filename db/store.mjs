import { randomUUID, scrypt as scryptCallback } from 'node:crypto';
import { readAggregate, readPatient } from './aggregate.mjs';
import { asAdmin, createMigrationPool, createPool, withSession } from './session.mjs';

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

// Precisa de contexto admin e doPrivilegio de dono: `admins` tem RLS, e sem um
// papel valido a consulta volta vazia e o bootstrap recriava a conta a cada login.
export const hasAnyAccount = async () => {
  const adminPool = createMigrationPool();
  try {
    return await asAdmin(adminPool, async client => {
      const accounts = await client.query('SELECT count(*)::int AS total FROM admins');
      return accounts.rows[0].total > 0;
    });
  } finally {
    await adminPool.end();
  }
};

export const bootstrapAdmin = async ({ id, name, email, password }) => {
  const salt = randomUUID().replace(/-/g, '').slice(0, 16);
  const passwordHash = await hashPassword(salt, password);
  const adminPool = createMigrationPool();
  try {
    await asAdmin(adminPool, async client => {
      await client.query(
        `INSERT INTO admins (id, name, email, position) VALUES ($1, $2, $3, 0)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email`,
        [id, name, email]
      );
      await client.query(
        `INSERT INTO account_credentials (account_id, role, password_hash) VALUES ($1, 'admin', $2)
         ON CONFLICT (account_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
        [id, passwordHash]
      );
    });
  } finally {
    await adminPool.end();
  }
};

// Senha antiga em texto plano vira hash no primeiro login valido.
export const rehashAccount = async (account, password) => {
  if (isHashed(account.passwordHash)) return false;
  const salt = randomUUID().replace(/-/g, '').slice(0, 16);
  const passwordHash = await hashPassword(salt, password);
  const adminPool = createMigrationPool();
  try {
    await asAdmin(adminPool, client => client.query(
      `INSERT INTO account_credentials (account_id, role, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [account.userId, account.role, passwordHash]
    ));
  } finally {
    await adminPool.end();
  }
  return true;
};

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

const writePhotos = async (client, patientId, photos) => {
  for (const [index, photo] of (photos ?? []).entries()) {
    if (!photo || typeof photo.id !== 'string') continue;
    const { image, mime, url } = photoImage(photo.imageUrl);
    await client.query(
      `INSERT INTO wound_photos (patient_id, id, position, date, day_label, image, image_mime,
         image_source_url, patient_notes, reviewed_by, reviewed_at, review_status, review_feedback)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (patient_id, id) DO UPDATE SET
         position = EXCLUDED.position, date = EXCLUDED.date, day_label = EXCLUDED.day_label,
         image = EXCLUDED.image, image_mime = EXCLUDED.image_mime,
         image_source_url = EXCLUDED.image_source_url, patient_notes = EXCLUDED.patient_notes,
         reviewed_by = EXCLUDED.reviewed_by, reviewed_at = EXCLUDED.reviewed_at,
         review_status = EXCLUDED.review_status, review_feedback = EXCLUDED.review_feedback`,
      [patientId, photo.id, index, photo.date ?? '', photo.dayLabel ?? '', image, mime, url,
        photo.patientNotes ?? '', photo.reviewedBy ?? '', photo.reviewedAt ?? '',
        photo.reviewStatus ?? 'pendente', photo.reviewFeedback ?? '']
    );
  }
  const ids = (photos ?? []).map(photo => photo?.id).filter(id => typeof id === 'string');
  await client.query(
    `DELETE FROM wound_photos WHERE patient_id = $1 AND NOT (id = ANY($2::text[]))`,
    [patientId, ids]
  );
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
    await writeChildren(client, table, patient.id, items, definition.columns, definition.defaults);
  }

  // Uniao de mensagens, nunca delete.
  for (const [index, message] of (patient.messages ?? []).entries()) {
    if (!message || typeof message.id !== 'string') continue;
    await client.query(
      `INSERT INTO messages (patient_id, id, position, sender, sender_name, timestamp, text, is_read)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (patient_id, id) DO UPDATE SET
         position = EXCLUDED.position, sender = EXCLUDED.sender, sender_name = EXCLUDED.sender_name,
         timestamp = EXCLUDED.timestamp, text = EXCLUDED.text, is_read = EXCLUDED.is_read`,
      [patient.id, message.id, index, message.sender ?? 'equipe', message.senderName ?? '',
        message.timestamp ?? '', message.text ?? '', message.isRead ?? false]
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
