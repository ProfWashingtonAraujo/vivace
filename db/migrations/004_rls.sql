-- Controle de acesso por registro (RLS).
--
-- A identidade da sessao chega ao banco por GUCs de transacao:
--   SELECT set_config('app.role', $1, true);      -- 'admin' | 'professional' | 'patient'
--   SELECT set_config('app.user_id', $2, true);
-- O ultimo `true` torna o valor local a transacao, entao o pool nao carrega
-- estado entre requisicoes. Sem esses GUCs, app_role_name() devolve NULL e tudo
-- nega: falha fechada.
--
-- CUIDADO com a armadilha classica: policies nao se aplicam ao dono da tabela.
-- Por isso o servidor vai conectar como vivace_api, que nao e dono, e o schema e
-- criado pelo papel vivace. Alem disso ha FORCE ROW LEVEL SECURITY em todas as
-- tabelas de dominio, como segunda barreira.
--
-- app_can_access_patient le patient_care_team por dentro de um SECURITY DEFINER
-- cujo dono tem BYPASSRLS. Sem isso a consulta sufferia recursao de policy e, pior,
-- um profissional so enxergaria as proprias linhas da equipe: veria zero linhas
-- para um paciente atendido por outro e concluiria "sem equipe", gaining acesso
-- a todos os pacientes.

CREATE EXTENSION IF NOT EXISTS unaccent;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vivace_rls') THEN
    -- Dono das funcoes SECURITY DEFINER que precisam ler alem das policies.
    CREATE ROLE vivace_rls NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vivace_api') THEN
    -- Papel da aplicacao. Sem senha aqui de proposito: a senha fica fora das
    -- migrations, no provisionamento do ambiente.
    CREATE ROLE vivace_api LOGIN;
  END IF;
END $$;

-- Mesma normalizacao do servidor: tira acento,ixa para minuscula e apara espacos.
-- STABLE, e nao IMMUTABLE, porque unaccent depende de dicionario.
CREATE OR REPLACE FUNCTION app_normalize(value text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT lower(btrim(unaccent(coalesce(value, ''))))
$$;

CREATE OR REPLACE FUNCTION app_role_name()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.role', true), '')
$$;

CREATE OR REPLACE FUNCTION app_user_id()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')
$$;

-- Regra de acesso a um paciente, espelhando o que o servidor fazia em JS
-- (server.mjs canAccessPatient).
CREATE OR REPLACE FUNCTION app_can_access_patient(patient_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT CASE app_role_name()
    WHEN 'admin' THEN true
    WHEN 'patient' THEN patient_id = app_user_id()
    -- profissional da equipe, ou paciente sem ninguem atribuido (o padrao
    -- atual: enquanto o paciente nao tem cirurgiao, qualquer profissional ve)
    WHEN 'professional' THEN
      EXISTS (SELECT 1 FROM patient_care_team t
              WHERE t.patient_id = app_can_access_patient.patient_id
                AND t.professional_id = app_user_id())
      OR NOT EXISTS (SELECT 1 FROM patient_care_team t WHERE t.patient_id = app_can_access_patient.patient_id)
    ELSE false
  END
$$;
ALTER FUNCTION app_can_access_patient(text) OWNER TO vivace_rls;

-- Login precisa ler o hash, mas a aplicacao nao deve poder ler a coluna em
-- massa. A busca por conta fica em um unico ponto auditavel, e a coluna perde o
-- SELECT direto. Reproduz o findAccount do servidor, inclusive o casamento por
-- prefixo de email do paciente.
CREATE OR REPLACE FUNCTION app_lookup_account(identifier text)
RETURNS TABLE (role text, user_id text, name text, email text, password_hash text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  WITH wanted AS (SELECT app_normalize(identifier) AS value),
  matches AS (
    SELECT 1 AS rank, 'admin'::text AS role, a.id AS user_id, a.name, a.email::text, a.password_hash
      FROM admins a, wanted w
     WHERE app_normalize(a.name) = w.value OR app_normalize(a.email) = w.value
    UNION ALL
    SELECT 2, 'professional', p.id, p.name, p.email::text, p.password_hash
      FROM professionals p, wanted w
     WHERE app_normalize(p.name) = w.value OR app_normalize(p.email) = w.value
    UNION ALL
    SELECT 3, 'patient', pt.id, pt.name, pt.email::text, pt.password_hash
      FROM patients pt, wanted w
     WHERE app_normalize(pt.name) = w.value
        OR app_normalize(pt.email) = w.value
        OR (length(w.value) >= 3 AND app_normalize(pt.email) LIKE w.value || '%')
  )
  SELECT m.role, m.user_id, m.name, m.email, m.password_hash
    FROM matches m
   WHERE m.user_id IS NOT NULL
   ORDER BY m.rank
   LIMIT 1
$$;
ALTER FUNCTION app_lookup_account(text) OWNER TO vivace_rls;

REVOKE ALL ON FUNCTION app_lookup_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_lookup_account(text) TO vivace_api;

REVOKE ALL ON FUNCTION app_normalize(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_normalize(text) TO vivace_api, vivace_rls;

-- ---------------------------------------------------------------- patients
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patients_select ON patients;
DROP POLICY IF EXISTS patients_select ON patients;
CREATE POLICY patients_select ON patients FOR SELECT USING (app_can_access_patient(id));
DROP POLICY IF EXISTS patients_insert ON patients;
DROP POLICY IF EXISTS patients_insert ON patients;
CREATE POLICY patients_insert ON patients FOR INSERT WITH CHECK (
  app_role_name() IN ('admin', 'professional') AND app_can_access_patient(id));
DROP POLICY IF EXISTS patients_update ON patients;
DROP POLICY IF EXISTS patients_update ON patients;
CREATE POLICY patients_update ON patients FOR UPDATE
  USING (app_can_access_patient(id)) WITH CHECK (app_can_access_patient(id));
DROP POLICY IF EXISTS patients_delete ON patients;
DROP POLICY IF EXISTS patients_delete ON patients;
CREATE POLICY patients_delete ON patients FOR DELETE USING (
  app_role_name() = 'admin' OR (app_role_name() = 'professional' AND app_can_access_patient(id)));

-- ---------------------------------------------------------- care team
ALTER TABLE patient_care_team ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_care_team FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_care_team_select ON patient_care_team;
DROP POLICY IF EXISTS patient_care_team_select ON patient_care_team;
CREATE POLICY patient_care_team_select ON patient_care_team FOR SELECT USING (
  app_role_name() = 'admin'
  OR (app_role_name() = 'patient' AND patient_id = app_user_id())
  OR (app_role_name() = 'professional' AND app_can_access_patient(patient_id)));
DROP POLICY IF EXISTS patient_care_team_insert ON patient_care_team;
DROP POLICY IF EXISTS patient_care_team_insert ON patient_care_team;
CREATE POLICY patient_care_team_insert ON patient_care_team FOR INSERT WITH CHECK (
  app_role_name() = 'admin'
  OR (app_role_name() = 'professional' AND app_can_access_patient(patient_id)));
DROP POLICY IF EXISTS patient_care_team_update ON patient_care_team;
DROP POLICY IF EXISTS patient_care_team_update ON patient_care_team;
CREATE POLICY patient_care_team_update ON patient_care_team FOR UPDATE
  USING (app_role_name() = 'admin'
         OR (app_role_name() = 'professional' AND app_can_access_patient(patient_id)))
  WITH CHECK (app_role_name() = 'admin'
              OR (app_role_name() = 'professional' AND app_can_access_patient(patient_id)));
-- Profissional pode tirar a si mesmo da equipe mesmo sem ver o paciente.
DROP POLICY IF EXISTS patient_care_team_delete ON patient_care_team;
DROP POLICY IF EXISTS patient_care_team_delete ON patient_care_team;
CREATE POLICY patient_care_team_delete ON patient_care_team FOR DELETE USING (
  app_role_name() = 'admin'
  OR (app_role_name() = 'professional' AND (professional_id = app_user_id() OR app_can_access_patient(patient_id))));

-- ------------------------------------------------- tabelas filhas do paciente
-- Todas seguem a mesma regra de leitura e escrita sobre o paciente dono.
-- wound_photos, medications, check_ins, messages, timeline_events, instructions.

ALTER TABLE timeline_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE timeline_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS timeline_events_all ON timeline_events;
CREATE POLICY timeline_events_all ON timeline_events
  USING (app_can_access_patient(patient_id)) WITH CHECK (app_can_access_patient(patient_id));

ALTER TABLE wound_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE wound_photos FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wound_photos_all ON wound_photos;
CREATE POLICY wound_photos_all ON wound_photos
  USING (app_can_access_patient(patient_id)) WITH CHECK (app_can_access_patient(patient_id));

ALTER TABLE medications ENABLE ROW LEVEL SECURITY;
ALTER TABLE medications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS medications_all ON medications;
CREATE POLICY medications_all ON medications
  USING (app_can_access_patient(patient_id)) WITH CHECK (app_can_access_patient(patient_id));

ALTER TABLE medication_times ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_times FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS medication_times_all ON medication_times;
CREATE POLICY medication_times_all ON medication_times
  USING (app_can_access_patient(patient_id)) WITH CHECK (app_can_access_patient(patient_id));

ALTER TABLE medication_doses ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_doses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS medication_doses_all ON medication_doses;
CREATE POLICY medication_doses_all ON medication_doses
  USING (app_can_access_patient(patient_id)) WITH CHECK (app_can_access_patient(patient_id));

ALTER TABLE check_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_ins FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS check_ins_all ON check_ins;
CREATE POLICY check_ins_all ON check_ins
  USING (app_can_access_patient(patient_id)) WITH CHECK (app_can_access_patient(patient_id));

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messages_all ON messages;
CREATE POLICY messages_all ON messages
  USING (app_can_access_patient(patient_id)) WITH CHECK (app_can_access_patient(patient_id));

ALTER TABLE instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE instructions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instructions_all ON instructions;
CREATE POLICY instructions_all ON instructions
  USING (app_can_access_patient(patient_id)) WITH CHECK (app_can_access_patient(patient_id));

-- Notas clinicas: nem o proprio paciente ve. Hoje /api/checkins devolve o
-- paciente inteiro com clinicalNotes para quem tem papel de paciente
-- (server.mjs:650), o que e vazamento; aqui a linha simplesmente nao aparece.
ALTER TABLE clinical_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clinical_notes_all ON clinical_notes;
CREATE POLICY clinical_notes_all ON clinical_notes
  USING (app_role_name() IN ('admin', 'professional') AND app_can_access_patient(patient_id))
  WITH CHECK (app_role_name() IN ('admin', 'professional') AND app_can_access_patient(patient_id));

-- ------------------------------------------------------------ profissionais
-- Um profissional ve so a si proprio. Isso corrige um bug real: professionalUser()
-- no frontend e professionals()[0], entao hoje uma sessao do profissional #2
-- grava o nome do #1 em reviewedBy, no autor da nota e no chat. O painel
-- administrativo continua vendo todos, por ser papel admin.
ALTER TABLE professionals ENABLE ROW LEVEL SECURITY;
ALTER TABLE professionals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS professionals_select ON professionals;
CREATE POLICY professionals_select ON professionals FOR SELECT USING (
  app_role_name() = 'admin' OR (app_role_name() = 'professional' AND id = app_user_id()));
DROP POLICY IF EXISTS professionals_write ON professionals;
CREATE POLICY professionals_write ON professionals FOR ALL USING (
  app_role_name() = 'admin') WITH CHECK (app_role_name() = 'admin');

-- ------------------------------------------------------------------ admins
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE admins FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admins_select ON admins;
CREATE POLICY admins_select ON admins FOR SELECT USING (app_role_name() = 'admin' AND id = app_user_id());
DROP POLICY IF EXISTS admins_write ON admins;
CREATE POLICY admins_write ON admins FOR ALL USING (app_role_name() = 'admin') WITH CHECK (app_role_name() = 'admin');

-- ------------------------------------------------------------------ grants
-- PUBLIC nunca recebe nada nas tabelas de clinica.
REVOKE ALL ON patients, professionals, admins, patient_care_team, timeline_events, wound_photos,
  medications, medication_times, medication_doses, check_ins, messages, instructions, clinical_notes
  FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON patients, professionals, admins, patient_care_team, timeline_events,
  wound_photos, medications, medication_times, medication_doses, check_ins, messages, instructions, clinical_notes
  TO vivace_api;

-- O hash de senha nao e legivel em massa pela aplicacao; so via app_lookup_account.
REVOKE SELECT (password_hash) ON patients, professionals, admins FROM vivace_api;
