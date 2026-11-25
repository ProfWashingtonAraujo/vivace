-- Escrita do paciente e da equipe, no banco.
--
-- Ate aqui as tabelas filhas do paciente tinham UMA policy `_all`, sem olhar o
-- papel: quem podia ler o registro podia escrever nele. Para o papel `patient` isso
-- significava, no banco, alterar a propria prescricao, reescrever mensagens com
-- sender = 'equipe', mudar o resultado da avaliacao de uma foto, forjar eventos da
-- equipe na linha do tempo e trocar o proprio e-mail e nome (que e o login). Quem
-- impedia era so o codigo da API; um bug ali (ou uma injecao de SQL) virava
-- escalada de privilegio.
--
-- Aqui as policies passam a separar quem escreve:
--   * leitura continua pela regra de acesso ao paciente;
--   * admin e profissional com acesso escrevem em tudo, como antes;
--   * o paciente escreve SO o que o fluxo dele precisa: mensagem como 'paciente',
--     check-in, foto pendente, evento de check-in/curativo e confirmacao de dose.
-- Quando o paciente precisa de UPDATE, o que muda e restrito por coluna por um
-- gatilho (uma policy nao enxerga a linha antiga, o gatilho sim).

-- ----------------------------------------------- leitura x escrita da equipe
DO $$
DECLARE
  child text;
BEGIN
  FOREACH child IN ARRAY ARRAY[
    'timeline_events', 'wound_photos', 'medications', 'medication_times',
    'medication_doses', 'check_ins', 'messages', 'instructions'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', child || '_all', child);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', child || '_select', child);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', child || '_staff_write', child);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (app_can_access_patient(patient_id))',
      child || '_select', child);
    EXECUTE format(
      $policy$CREATE POLICY %I ON %I FOR ALL
        USING (app_role_name() IN ('admin', 'professional') AND app_can_access_patient(patient_id))
        WITH CHECK (app_role_name() IN ('admin', 'professional') AND app_can_access_patient(patient_id))$policy$,
      child || '_staff_write', child);
  END LOOP;
END $$;

-- ---------------------------------------------------- o que o paciente escreve
-- Mensagem: so como paciente, so no proprio registro. Sem UPDATE nem DELETE.
DROP POLICY IF EXISTS messages_patient_insert ON messages;
CREATE POLICY messages_patient_insert ON messages FOR INSERT WITH CHECK (
  app_role_name() = 'patient' AND patient_id = app_user_id() AND sender = 'paciente');

-- Check-in: insere o proprio; o UPDATE existe so para reordenar (coluna position).
DROP POLICY IF EXISTS check_ins_patient_insert ON check_ins;
CREATE POLICY check_ins_patient_insert ON check_ins FOR INSERT WITH CHECK (
  app_role_name() = 'patient' AND patient_id = app_user_id());
DROP POLICY IF EXISTS check_ins_patient_update ON check_ins;
CREATE POLICY check_ins_patient_update ON check_ins FOR UPDATE
  USING (app_role_name() = 'patient' AND patient_id = app_user_id())
  WITH CHECK (app_role_name() = 'patient' AND patient_id = app_user_id());

-- Foto da ferida: entra sempre pendente e sem avaliacao. A avaliacao e da equipe.
DROP POLICY IF EXISTS wound_photos_patient_insert ON wound_photos;
CREATE POLICY wound_photos_patient_insert ON wound_photos FOR INSERT WITH CHECK (
  app_role_name() = 'patient' AND patient_id = app_user_id()
  AND review_status = 'pendente'
  AND coalesce(reviewed_by, '') = '' AND coalesce(reviewed_at, '') = '' AND coalesce(review_feedback, '') = '');
DROP POLICY IF EXISTS wound_photos_patient_update ON wound_photos;
CREATE POLICY wound_photos_patient_update ON wound_photos FOR UPDATE
  USING (app_role_name() = 'patient' AND patient_id = app_user_id())
  WITH CHECK (app_role_name() = 'patient' AND patient_id = app_user_id());

-- Linha do tempo: so os eventos que o proprio fluxo do paciente gera, assinados por ele.
DROP POLICY IF EXISTS timeline_events_patient_insert ON timeline_events;
CREATE POLICY timeline_events_patient_insert ON timeline_events FOR INSERT WITH CHECK (
  app_role_name() = 'patient' AND patient_id = app_user_id()
  AND type IN ('checkin', 'curativo') AND author LIKE '%(Paciente)');

-- Dose: confirma e desfaz a confirmacao (INSERT ... ON CONFLICT DO UPDATE).
DROP POLICY IF EXISTS medication_doses_patient_insert ON medication_doses;
CREATE POLICY medication_doses_patient_insert ON medication_doses FOR INSERT WITH CHECK (
  app_role_name() = 'patient' AND patient_id = app_user_id());
DROP POLICY IF EXISTS medication_doses_patient_update ON medication_doses;
CREATE POLICY medication_doses_patient_update ON medication_doses FOR UPDATE
  USING (app_role_name() = 'patient' AND patient_id = app_user_id())
  WITH CHECK (app_role_name() = 'patient' AND patient_id = app_user_id());

-- medications, medication_times e instructions: o paciente so le.

-- -------------------------------------------- guarda de colunas para o paciente
-- Para o papel `patient`, so as colunas listadas podem mudar num UPDATE. Para os
-- demais papeis o gatilho nao faz nada. Compara a linha inteira em jsonb, entao uma
-- coluna nova no futuro ja nasce protegida.
CREATE OR REPLACE FUNCTION app_guard_patient_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF app_role_name() = 'patient'
     AND (to_jsonb(NEW) - TG_ARGV) IS DISTINCT FROM (to_jsonb(OLD) - TG_ARGV) THEN
    RAISE EXCEPTION 'o paciente nao pode alterar estas colunas em %', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- Dados cadastrais ficam com a equipe. O paciente so move os sinais do check-in e a
-- aderencia, que sao dele (o servidor os calcula a partir do que o paciente envia).
DROP TRIGGER IF EXISTS patients_guard_patient_columns ON patients;
CREATE TRIGGER patients_guard_patient_columns BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION app_guard_patient_columns(
    'current_pain', 'current_temp', 'last_check_in_time', 'status',
    'wound_review_pending', 'medication_adherence_percent');

DROP TRIGGER IF EXISTS check_ins_guard_patient_columns ON check_ins;
CREATE TRIGGER check_ins_guard_patient_columns BEFORE UPDATE ON check_ins
  FOR EACH ROW EXECUTE FUNCTION app_guard_patient_columns('position');

DROP TRIGGER IF EXISTS wound_photos_guard_patient_columns ON wound_photos;
CREATE TRIGGER wound_photos_guard_patient_columns BEFORE UPDATE ON wound_photos
  FOR EACH ROW EXECUTE FUNCTION app_guard_patient_columns('position');

DROP TRIGGER IF EXISTS medication_doses_guard_patient_columns ON medication_doses;
CREATE TRIGGER medication_doses_guard_patient_columns BEFORE UPDATE ON medication_doses
  FOR EACH ROW EXECUTE FUNCTION app_guard_patient_columns('taken');

-- ------------------------------------------------------------ equipe do paciente
-- Antes, qualquer profissional que visse o paciente podia tirar QUALQUER colega da
-- equipe; e um paciente sem equipe fica visivel a todos os profissionais. Tirar a
-- ultima pessoa da equipe era, na pratica, abrir o paciente para todos.
--
-- Agora: o profissional so remove a si mesmo, e so se a equipe continua com mais
-- alguem. Esvaziar uma equipe e decisao do admin.
DROP POLICY IF EXISTS patient_care_team_delete ON patient_care_team;
CREATE POLICY patient_care_team_delete ON patient_care_team FOR DELETE USING (
  app_role_name() = 'admin'
  OR (app_role_name() = 'professional' AND professional_id = app_user_id()));

-- SECURITY DEFINER: precisa ler a equipe inteira e o paciente, o que o RLS nao
-- deixaria o profissional fazer. Quando o paciente ja foi apagado (a exclusao em
-- cascata leva a equipe junto) nao ha nada a proteger.
CREATE OR REPLACE FUNCTION app_keep_care_team()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF app_role_name() IS DISTINCT FROM 'admin'
     AND EXISTS (SELECT 1 FROM patients WHERE id = OLD.patient_id)
     AND NOT EXISTS (
       SELECT 1 FROM patient_care_team t
        WHERE t.patient_id = OLD.patient_id AND t.professional_id <> OLD.professional_id) THEN
    RAISE EXCEPTION 'so o administrador pode deixar um paciente sem equipe'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END
$$;
ALTER FUNCTION app_keep_care_team() OWNER TO vivace_rls;

DROP TRIGGER IF EXISTS patient_care_team_keep_team ON patient_care_team;
CREATE TRIGGER patient_care_team_keep_team BEFORE DELETE ON patient_care_team
  FOR EACH ROW EXECUTE FUNCTION app_keep_care_team();
