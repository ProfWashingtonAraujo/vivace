import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = process.env.VIVACE_IMPORT_FILE ?? join(root, '.data', 'vivace-state.json');
const connectionString = process.env.MIGRATION_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://vivace:vivace@127.0.0.1:55432/vivace';
const force = process.argv.includes('--force');

const normalize = value => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const isHashed = value => typeof value === 'string' && value.startsWith('scrypt$');

// "Rafaely Carvalho (CRM-SP 148.920)" -> nome e conselho, para casar com a equipe.
const parseSurgeon = value => {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  return {
    name: normalize(match ? match[1] : raw),
    council: normalize(match ? match[2] : '')
  };
};

const resolveProfessional = (surgeon, professionals) => {
  const { name, council } = parseSurgeon(surgeon);
  if (!name && !council) return null;
  return professionals.find(professional => {
    const professionalName = normalize(professional.name);
    const professionalCouncil = normalize(professional.crmCoren);
    if (council && professionalCouncil && council.includes(professionalCouncil)) return true;
    return name.length >= 3 && professionalName && professionalName.startsWith(name);
  }) ?? null;
};

// Foto de upload vira bytea; foto de demonstracao fica so como URL, o que
// preserva a distincao que o frontend faz checando images.unsplash.com.
const parsePhotoImage = imageUrl => {
  const value = String(imageUrl ?? '');
  if (value.startsWith('data:image/')) {
    const comma = value.indexOf(',');
    if (comma > 0) {
      const mime = value.slice('data:'.length, value.indexOf(';'));
      return { image: Buffer.from(value.slice(comma + 1), 'base64'), mime, url: null };
    }
  }
  return { image: null, mime: null, url: value || null };
};

const childTables = [
  'timeline_events',
  'wound_photos',
  'medications',
  'medication_times',
  'medication_doses',
  'check_ins',
  'messages',
  'instructions',
  'clinical_notes'
];

const insertCollections = async (client, state, warnings) => {
  const professionals = state.professionals ?? [];
  for (const [index, professional] of professionals.entries()) {
    await client.query(
      `INSERT INTO professionals (id, name, job_title, crm_coren, avatar, email, password_hash, specialty, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, job_title = EXCLUDED.job_title, crm_coren = EXCLUDED.crm_coren,
         avatar = EXCLUDED.avatar, email = EXCLUDED.email, specialty = EXCLUDED.specialty,
         position = EXCLUDED.position,
         password_hash = COALESCE(EXCLUDED.password_hash, professionals.password_hash)`,
      [professional.id, professional.name, professional.role ?? '', professional.crmCoren ?? '',
        professional.avatar ?? '', professional.email, isHashed(professional.password) ? professional.password : null,
        professional.specialty ?? '', index]
    );
  }

  for (const [index, admin] of (state.admins ?? []).entries()) {
    await client.query(
      `INSERT INTO admins (id, name, email, password_hash, position) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, email = EXCLUDED.email, position = EXCLUDED.position,
         password_hash = COALESCE(EXCLUDED.password_hash, admins.password_hash)`,
      [admin.id, admin.name, admin.email, isHashed(admin.password) ? admin.password : null, index]
    );
  }

  let orphanSurgeons = 0;
  for (const [index, patient] of (state.patients ?? []).entries()) {
    const contact = patient.emergencyContact ?? {};
    await client.query(
      `INSERT INTO patients (
         id, name, age, gender, avatar, email, password_hash, phone, cpf, procedure,
         surgery_date, discharge_date, hospital, anesthesia_type, allergies, status,
         post_op_day, last_check_in_time, current_pain, current_temp, blood_pressure, heart_rate,
         wound_review_pending, medication_adherence_percent,
         emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, position, surgeon_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
      [patient.id, patient.name, patient.age ?? 0, patient.gender ?? '', patient.avatar ?? '',
        patient.email, isHashed(patient.password) ? patient.password : null,
        patient.phone ?? '', patient.cpf ?? '', patient.procedure ?? '',
        patient.surgeryDate ?? '', patient.dischargeDate ?? '', patient.hospital ?? '',
        patient.anesthesiaType ?? '', patient.allergies ?? [], patient.status ?? 'estavel',
        patient.postOpDay ?? 0, patient.lastCheckInTime ?? '',
        patient.currentPain ?? 0, patient.currentTemp ?? 36.5, patient.bloodPressure ?? '',
        patient.heartRate ?? 0, patient.woundReviewPending ?? false,
        patient.medicationAdherencePercent ?? 100,
        contact.name ?? '', contact.phone ?? '', contact.relationship ?? '', index,
        patient.surgeon ?? '']
    );

    const surgeon = resolveProfessional(patient.surgeon, professionals);
    if (surgeon) {
      await client.query(
        `INSERT INTO patient_care_team (patient_id, professional_id, role, position)
         VALUES ($1, $2, 'cirurgiao', 0)
         ON CONFLICT (patient_id, professional_id) DO UPDATE SET role = 'cirurgiao', position = 0`,
        [patient.id, surgeon.id]
      );
    } else if (patient.surgeon) {
      orphanSurgeons += 1;
      warnings.push(`${patient.id}: cirurgiao "${patient.surgeon}" nao existe em professionals; equipe ficou vazia`);
    }

    for (const [index, event] of (patient.timeline ?? []).entries()) {
      await client.query(
        `INSERT INTO timeline_events (patient_id, id, position, date, day_label, title, description, author, type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [patient.id, event.id, index, event.date ?? '', event.dayLabel ?? '', event.title ?? '',
          event.description ?? '', event.author ?? '', event.type ?? '']
      );
    }

    for (const [index, photo] of (patient.woundPhotos ?? []).entries()) {
      const { image, mime, url } = parsePhotoImage(photo.imageUrl);
      await client.query(
        `INSERT INTO wound_photos (patient_id, id, position, date, day_label, image, image_mime,
           image_source_url, patient_notes, reviewed_by, reviewed_at, review_status, review_feedback)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [patient.id, photo.id, index, photo.date ?? '', photo.dayLabel ?? '', image, mime, url,
          photo.patientNotes ?? '', photo.reviewedBy ?? '', photo.reviewedAt ?? '',
          photo.reviewStatus ?? 'pendente', photo.reviewFeedback ?? '']
      );
    }

    for (const [index, medication] of (patient.medications ?? []).entries()) {
      await client.query(
        `INSERT INTO medications (patient_id, id, position, name, dose, frequency, purpose, instructions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [patient.id, medication.id, index, medication.name ?? '', medication.dose ?? '',
          medication.frequency ?? '', medication.purpose ?? '', medication.instructions ?? '']
      );
      const takenToday = medication.takenToday ?? {};
      for (const [timeIndex, time] of (medication.times ?? []).entries()) {
        await client.query(
          `INSERT INTO medication_times (patient_id, medication_id, time, position) VALUES ($1,$2,$3,$4)`,
          [patient.id, medication.id, time, timeIndex]
        );
        await client.query(
          `INSERT INTO medication_doses (patient_id, medication_id, time, taken) VALUES ($1,$2,$3,$4)`,
          [patient.id, medication.id, time, Boolean(takenToday[time])]
        );
      }
      const stray = Object.keys(takenToday).filter(time => !(medication.times ?? []).includes(time));
      if (stray.length) {
        warnings.push(`${patient.id}/${medication.id}: takenToday com horarios fora de times (${stray.join(', ')})`);
      }
    }

    for (const [index, checkIn] of (patient.checkIns ?? []).entries()) {
      await client.query(
        `INSERT INTO check_ins (patient_id, id, position, date, day_label, pain_level, temperature,
           mobility_score, symptoms, notes, mood, photo_uploaded)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [patient.id, checkIn.id, index, checkIn.date ?? '', checkIn.dayLabel ?? '',
          checkIn.painLevel ?? 0, checkIn.temperature ?? 36.5, checkIn.mobilityScore ?? 'repouso_absoluto',
          checkIn.symptoms ?? [], checkIn.notes ?? '', checkIn.mood ?? 'bem', checkIn.photoUploaded ?? false]
      );
    }

    for (const [index, message] of (patient.messages ?? []).entries()) {
      await client.query(
        `INSERT INTO messages (patient_id, id, position, sender, sender_name, timestamp, text, is_read)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [patient.id, message.id, index, message.sender ?? 'equipe', message.senderName ?? '',
          message.timestamp ?? '', message.text ?? '', message.isRead ?? false]
      );
    }

    for (const [index, instruction] of (patient.instructions ?? []).entries()) {
      await client.query(
        `INSERT INTO instructions (patient_id, id, position, category, title, content, icon_name, important)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [patient.id, instruction.id, index, instruction.category ?? '', instruction.title ?? '',
          instruction.content ?? '', instruction.iconName ?? '', instruction.important ?? false]
      );
    }

    for (const [index, note] of (patient.clinicalNotes ?? []).entries()) {
      await client.query(
        `INSERT INTO clinical_notes (patient_id, id, position, author, date, text) VALUES ($1,$2,$3,$4,$5,$6)`,
        [patient.id, note.id, index, note.author ?? '', note.date ?? '', note.text ?? '']
      );
    }
  }
  if (orphanSurgeons) console.log(`${orphanSurgeons} paciente(s) com cirurgiao sem correspondencia`);
};

const main = async () => {
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const client = new pg.Client({ connectionString });
  await client.connect();
  const warnings = [];
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT count(*)::int AS total FROM patients');
    if (existing.rows[0].total > 0 && !force) {
      throw new Error(
        `patients ja tem ${existing.rows[0].total} linha(s). O import trunca e reinsere; ` +
        'rode com --force se isso for de proposito.'
      );
    }
    await client.query(`TRUNCATE ${childTables.join(', ')} RESTART IDENTITY CASCADE`);
    await client.query('TRUNCATE patients, patient_care_team, professionals, admins RESTART IDENTITY CASCADE');
    await insertCollections(client, state, warnings);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`import falhou: ${error.message}`);
    process.exitCode = 1;
    return;
  } finally {
    await client.end();
  }

  const summary = {
    pacientes: (state.patients ?? []).length,
    profissionais: (state.professionals ?? []).length,
    admins: (state.admins ?? []).length,
    equipe: (state.patients ?? []).filter(patient => resolveProfessional(patient.surgeon, state.professionals ?? [])).length
  };
  console.log(`importado de ${stateFile}`);
  console.log(JSON.stringify(summary, null, 2));
  for (const warning of warnings) console.log(`aviso: ${warning}`);
};

await main();
