-- Schema inicial do Vivace.
--
-- Todos os ids sao text para preservar os identificadores ja existentes no
-- arquivo JSON (pat-1, prof-1, msg-..., chk-...), evitando conversao na migracao.
--
-- Toda tabela filha guarda `position`, que e o indice do item no array do JSON.
-- A ordem no frontend nao e uniforme (check_ins e wound_photos sao decrescentes,
-- timeline_events e messages crescentes) e varios templates dependem dela, como
-- `checkIns[0]` como "check-in de hoje" e `medications.slice(0, 2)`. Guardar o
-- indice reproduz a ordem exata sem tentar deduzi-la por data.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE professionals (
  id text PRIMARY KEY,
  name text NOT NULL,
  -- job_title vira `role` no JSON; a coluna nao se chama `role` para nao
  -- colidir com o papel de acesso usado pelas policies.
  job_title text NOT NULL DEFAULT '',
  crm_coren text NOT NULL DEFAULT '',
  avatar text NOT NULL DEFAULT '',
  email citext NOT NULL UNIQUE,
  password_hash text,
  specialty text NOT NULL DEFAULT ''
);

CREATE TABLE admins (
  id text PRIMARY KEY,
  name text NOT NULL,
  email citext NOT NULL UNIQUE,
  password_hash text
);

CREATE TABLE patients (
  id text PRIMARY KEY,
  name text NOT NULL,
  age integer NOT NULL DEFAULT 0,
  gender text NOT NULL DEFAULT '',
  avatar text NOT NULL DEFAULT '',
  email citext NOT NULL UNIQUE,
  password_hash text,
  phone text NOT NULL DEFAULT '',
  cpf text NOT NULL DEFAULT '',
  procedure text NOT NULL DEFAULT '',
  surgery_date text NOT NULL DEFAULT '',
  discharge_date text NOT NULL DEFAULT '',
  hospital text NOT NULL DEFAULT '',
  anesthesia_type text NOT NULL DEFAULT '',
  allergies text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'estavel' CHECK (status IN ('estavel', 'atencao', 'critico')),
  -- post_op_day e coluna armazenada, nao derivada de surgery_date: os valores
  -- em producao sao velhos de proposito e os selos "D+n" da tela dependem deles.
  post_op_day integer NOT NULL DEFAULT 0,
  -- Texto de exibicao em pt-BR ("Hoje as 08:30"), nao timestamp.
  last_check_in_time text NOT NULL DEFAULT '',
  current_pain integer NOT NULL DEFAULT 0,
  current_temp numeric(4,1) NOT NULL DEFAULT 36.5,
  blood_pressure text NOT NULL DEFAULT '',
  heart_rate integer NOT NULL DEFAULT 0,
  wound_review_pending boolean NOT NULL DEFAULT false,
  medication_adherence_percent integer NOT NULL DEFAULT 100,
  emergency_contact_name text NOT NULL DEFAULT '',
  emergency_contact_phone text NOT NULL DEFAULT '',
  emergency_contact_relationship text NOT NULL DEFAULT ''
);

-- Varios profissionais por paciente. `role = 'cirurgiao'` alimenta o campo
-- `surgeon` do JSON, montado como "Nome (CRM/COREN)".
CREATE TABLE patient_care_team (
  patient_id text NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  professional_id text NOT NULL REFERENCES professionals (id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'equipe' CHECK (role IN ('cirurgiao', 'equipe')),
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (patient_id, professional_id)
);

CREATE INDEX patient_care_team_professional_idx ON patient_care_team (professional_id);

CREATE TABLE timeline_events (
  patient_id text NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  id text NOT NULL,
  position integer NOT NULL,
  -- Texto de exibicao, nao timestamp.
  date text NOT NULL DEFAULT '',
  day_label text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  author text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT '',
  PRIMARY KEY (patient_id, id)
);

CREATE INDEX timeline_events_order_idx ON timeline_events (patient_id, position);

-- Fotos: upload real vira `image` (bytea); foto de demonstracao fica so em
-- `image_source_url`. A distincao substitui o truque
-- `imageUrl.includes('images.unsplash.com')` usado no frontend.
CREATE TABLE wound_photos (
  patient_id text NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  id text NOT NULL,
  position integer NOT NULL,
  date text NOT NULL DEFAULT '',
  day_label text NOT NULL DEFAULT '',
  image bytea,
  image_mime text,
  image_source_url text,
  patient_notes text NOT NULL DEFAULT '',
  reviewed_by text NOT NULL DEFAULT '',
  reviewed_at text NOT NULL DEFAULT '',
  review_status text NOT NULL DEFAULT 'pendente'
    CHECK (review_status IN ('pendente', 'avaliado_adequado', 'requer_atencao')),
  review_feedback text NOT NULL DEFAULT '',
  CONSTRAINT wound_photos_image_source CHECK (
    (image IS NOT NULL AND image_source_url IS NULL) OR (image IS NULL AND image_source_url IS NOT NULL)
  ),
  PRIMARY KEY (patient_id, id)
);

CREATE INDEX wound_photos_order_idx ON wound_photos (patient_id, position);

CREATE TABLE medications (
  patient_id text NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  id text NOT NULL,
  position integer NOT NULL,
  name text NOT NULL DEFAULT '',
  dose text NOT NULL DEFAULT '',
  frequency text NOT NULL DEFAULT '',
  purpose text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  PRIMARY KEY (patient_id, id)
);

CREATE INDEX medications_order_idx ON medications (patient_id, position);

-- `times[]` do JSON, normalizado e ordenado.
CREATE TABLE medication_times (
  patient_id text NOT NULL,
  medication_id text NOT NULL,
  time text NOT NULL,
  position integer NOT NULL,
  PRIMARY KEY (patient_id, medication_id, time),
  FOREIGN KEY (patient_id, medication_id) REFERENCES medications (patient_id, id) ON DELETE CASCADE
);

-- `takenToday[time]`. A leitura precisa devolver false explicito para todo slot
-- declarado em medication_times, mesmo sem linha aqui.
CREATE TABLE medication_doses (
  patient_id text NOT NULL,
  medication_id text NOT NULL,
  time text NOT NULL,
  taken boolean NOT NULL DEFAULT false,
  PRIMARY KEY (patient_id, medication_id, time),
  FOREIGN KEY (patient_id, medication_id) REFERENCES medications (patient_id, id) ON DELETE CASCADE
);

CREATE TABLE check_ins (
  patient_id text NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  id text NOT NULL,
  position integer NOT NULL,
  -- Texto de exibicao, nao timestamp.
  date text NOT NULL DEFAULT '',
  day_label text NOT NULL DEFAULT '',
  pain_level integer NOT NULL CHECK (pain_level BETWEEN 0 AND 10),
  temperature numeric(4,1) NOT NULL CHECK (temperature BETWEEN 25 AND 45),
  mobility_score text NOT NULL DEFAULT 'repouso_absoluto',
  symptoms text[] NOT NULL DEFAULT '{}',
  notes text NOT NULL DEFAULT '',
  mood text NOT NULL DEFAULT 'bem',
  photo_uploaded boolean NOT NULL DEFAULT false,
  PRIMARY KEY (patient_id, id)
);

CREATE INDEX check_ins_order_idx ON check_ins (patient_id, position);

CREATE TABLE messages (
  patient_id text NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  id text NOT NULL,
  position integer NOT NULL,
  sender text NOT NULL CHECK (sender IN ('paciente', 'equipe')),
  sender_name text NOT NULL DEFAULT '',
  -- Texto de exibicao, nao timestamp.
  timestamp text NOT NULL DEFAULT '',
  text text NOT NULL DEFAULT '',
  is_read boolean NOT NULL DEFAULT false,
  PRIMARY KEY (patient_id, id)
);

CREATE INDEX messages_order_idx ON messages (patient_id, position);

CREATE TABLE instructions (
  patient_id text NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  id text NOT NULL,
  position integer NOT NULL,
  category text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  icon_name text NOT NULL DEFAULT '',
  important boolean NOT NULL DEFAULT false,
  PRIMARY KEY (patient_id, id)
);

CREATE INDEX instructions_order_idx ON instructions (patient_id, position);

CREATE TABLE clinical_notes (
  patient_id text NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  id text NOT NULL,
  position integer NOT NULL,
  author text NOT NULL DEFAULT '',
  -- Texto de exibicao, nao timestamp.
  date text NOT NULL DEFAULT '',
  text text NOT NULL DEFAULT '',
  PRIMARY KEY (patient_id, id)
);

CREATE INDEX clinical_notes_order_idx ON clinical_notes (patient_id, position);
