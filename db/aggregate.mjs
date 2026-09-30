// Reidrata o agregado no mesmo formato que GET /api/state devolve hoje.
// A ordem de cada colecao vem de `position`, que guarda o indice do array no
// JSON, porque o frontend depende dela (checkIns[0] e "hoje", medications.slice(0,2)).

const ordered = rows => [...rows].sort((a, b) => a.position - b.position);

const groupByPatient = rows => {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.patient_id)) grouped.set(row.patient_id, []);
    grouped.get(row.patient_id).push(row);
  }
  return grouped;
};

// `current_temp` e numeric no Postgres e voltaria como string, o que mudaria o
// tipo no JSON. Converte explicitamente.
const toNumber = value => (value === null || value === undefined ? value : Number(value));

const photoUrl = row => {
  if (row.image) return `data:${row.image_mime ?? 'image/jpeg'};base64,${row.image.toString('base64')}`;
  return row.image_source_url ?? '';
};

const readMedications = (medications, times, doses) => medications.map(medication => {
  const medicationTimes = ordered(times.filter(time => time.medication_id === medication.id));
  const takenToday = {};
  for (const time of medicationTimes) {
    const dose = doses.find(item => item.medication_id === medication.id && item.time === time.time);
    takenToday[time.time] = Boolean(dose?.taken);
  }
  return {
    id: medication.id,
    name: medication.name,
    dose: medication.dose,
    frequency: medication.frequency,
    purpose: medication.purpose,
    instructions: medication.instructions,
    times: medicationTimes.map(time => time.time),
    takenToday
  };
});

const buildPatient = (row, { timeline, photos, medications, times, doses, checkIns, messages, instructions, notes, surgeon }) => ({
  id: row.id,
  name: row.name,
  age: row.age,
  gender: row.gender,
  avatar: row.avatar,
  email: row.email,
  phone: row.phone,
  cpf: row.cpf,
  procedure: row.procedure,
  surgeryDate: row.surgery_date,
  dischargeDate: row.discharge_date,
  hospital: row.hospital,
  surgeon,
  anesthesiaType: row.anesthesia_type,
  allergies: row.allergies,
  status: row.status,
  postOpDay: row.post_op_day,
  lastCheckInTime: row.last_check_in_time,
  currentPain: row.current_pain,
  currentTemp: toNumber(row.current_temp),
  bloodPressure: row.blood_pressure,
  heartRate: row.heart_rate,
  woundReviewPending: row.wound_review_pending,
  medicationAdherencePercent: row.medication_adherence_percent,
  emergencyContact: {
    name: row.emergency_contact_name,
    phone: row.emergency_contact_phone,
    relationship: row.emergency_contact_relationship
  },
  timeline: ordered(timeline).map(event => ({
    id: event.id,
    date: event.date,
    dayLabel: event.day_label,
    title: event.title,
    description: event.description,
    author: event.author,
    type: event.type
  })),
  woundPhotos: ordered(photos).map(photo => ({
    id: photo.id,
    date: photo.date,
    dayLabel: photo.day_label,
    imageUrl: photoUrl(photo),
    patientNotes: photo.patient_notes,
    reviewedBy: photo.reviewed_by,
    reviewedAt: photo.reviewed_at,
    reviewStatus: photo.review_status,
    reviewFeedback: photo.review_feedback
  })),
  medications: readMedications(ordered(medications), times, doses),
  checkIns: ordered(checkIns).map(checkIn => ({
    id: checkIn.id,
    date: checkIn.date,
    dayLabel: checkIn.day_label,
    painLevel: checkIn.pain_level,
    temperature: toNumber(checkIn.temperature),
    mobilityScore: checkIn.mobility_score,
    symptoms: checkIn.symptoms,
    notes: checkIn.notes,
    mood: checkIn.mood,
    photoUploaded: checkIn.photo_uploaded
  })),
  messages: ordered(messages).map(message => ({
    id: message.id,
    sender: message.sender,
    senderName: message.sender_name,
    timestamp: message.timestamp,
    text: message.text,
    isRead: message.is_read
  })),
  instructions: ordered(instructions).map(instruction => ({
    id: instruction.id,
    category: instruction.category,
    title: instruction.title,
    content: instruction.content,
    iconName: instruction.icon_name,
    important: instruction.important
  })),
  clinicalNotes: ordered(notes).map(note => ({
    id: note.id,
    author: note.author,
    date: note.date,
    text: note.text
  }))
});

// Consultas sequenciais: um unico client nao pode executar em paralelo.
const readPatients = async (client, patientId = null) => {
  const filter = patientId === null ? '' : 'WHERE patient_id = $1';
  const params = patientId === null ? [] : [patientId];
  const all = patientId === null ? '' : 'WHERE id = $1';
  const patientRows = await client.query(`SELECT * FROM patients ${all} ORDER BY position`, params);
  if (!patientRows.rows.length) return [];

  const teamRows = await client.query(`SELECT t.*, p.name, p.crm_coren
                  FROM patient_care_team t JOIN professionals p ON p.id = t.professional_id
                  ORDER BY t.patient_id, t.position`);
  const timelineRows = await client.query(`SELECT * FROM timeline_events ${filter}`, params);
  const photoRows = await client.query(`SELECT * FROM wound_photos ${filter}`, params);
  const medicationRows = await client.query(`SELECT * FROM medications ${filter}`, params);
  const timeRows = await client.query(`SELECT * FROM medication_times ${filter}`, params);
  const doseRows = await client.query(`SELECT * FROM medication_doses ${filter}`, params);
  const checkInRows = await client.query(`SELECT * FROM check_ins ${filter}`, params);
  const messageRows = await client.query(`SELECT * FROM messages ${filter}`, params);
  const instructionRows = await client.query(`SELECT * FROM instructions ${filter}`, params);
  const noteRows = await client.query(`SELECT * FROM clinical_notes ${filter}`, params);

  const byPatient = {
    timeline: groupByPatient(timelineRows.rows),
    photos: groupByPatient(photoRows.rows),
    medications: groupByPatient(medicationRows.rows),
    checkIns: groupByPatient(checkInRows.rows),
    messages: groupByPatient(messageRows.rows),
    instructions: groupByPatient(instructionRows.rows),
    notes: groupByPatient(noteRows.rows)
  };
  const timesByPatient = groupByPatient(timeRows.rows);
  const dosesByPatient = groupByPatient(doseRows.rows);
  const teamByPatient = groupByPatient(teamRows.rows);

  return patientRows.rows.map(row => {
    const team = teamByPatient.get(row.id) ?? [];
    const primary = team.find(member => member.role === 'cirurgiao') ?? team[0];
    // O nome vem da equipe (assim renomear o profissional atualiza a tela, como
    // hoje) e cai no rotulo guardado quando o paciente nao tem equipe.
    const surgeon = primary ? `${primary.name} (${primary.crm_coren})` : row.surgeon_label;
    return buildPatient(row, {
      timeline: byPatient.timeline.get(row.id) ?? [],
      photos: byPatient.photos.get(row.id) ?? [],
      medications: byPatient.medications.get(row.id) ?? [],
      times: timesByPatient.get(row.id) ?? [],
      doses: dosesByPatient.get(row.id) ?? [],
      checkIns: byPatient.checkIns.get(row.id) ?? [],
      messages: byPatient.messages.get(row.id) ?? [],
      instructions: byPatient.instructions.get(row.id) ?? [],
      notes: byPatient.notes.get(row.id) ?? [],
      surgeon
    });
  });
};

export const readAggregate = async client => ({
  patients: await readPatients(client),
  professionals: (await client.query('SELECT * FROM professionals ORDER BY position')).rows.map(row => ({
    id: row.id,
    name: row.name,
    role: row.job_title,
    crmCoren: row.crm_coren,
    avatar: row.avatar,
    email: row.email,
    specialty: row.specialty
  })),
  admins: (await client.query('SELECT * FROM admins ORDER BY position')).rows.map(row => ({
    id: row.id,
    name: row.name,
    email: row.email
  }))
});

// Um paciente so. Devolve null quando o RLS esconde o registro, que e o mesmo
// sinal de "nao encontrado" que a API ja usava.
export const readPatient = (client, patientId) => readPatients(client, patientId).then(rows => rows[0] ?? null);
