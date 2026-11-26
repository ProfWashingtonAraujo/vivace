-- Pressao arterial e pulso no check-in (todos opcionais: nem todo paciente tem aparelho).
-- Sistolica e diastolica vem juntas ou nenhuma; o servidor ja valida, e a restricao garante.
--
-- Mesma ordem de trava do app (patients, depois check_ins), como na migracao 023.
SET LOCAL lock_timeout = '15s';
LOCK TABLE patients, check_ins IN ACCESS EXCLUSIVE MODE;

ALTER TABLE check_ins ADD COLUMN IF NOT EXISTS systolic integer;
ALTER TABLE check_ins ADD COLUMN IF NOT EXISTS diastolic integer;
ALTER TABLE check_ins ADD COLUMN IF NOT EXISTS pulse integer;
ALTER TABLE check_ins DROP CONSTRAINT IF EXISTS check_ins_vitals_range;
ALTER TABLE check_ins ADD CONSTRAINT check_ins_vitals_range CHECK (
  ((systolic IS NULL) = (diastolic IS NULL))
  AND (systolic IS NULL OR (systolic BETWEEN 50 AND 300 AND diastolic BETWEEN 30 AND 200 AND systolic > diastolic))
  AND (pulse IS NULL OR pulse BETWEEN 20 AND 250));

-- O ultimo valor continua em patients.blood_pressure (texto "120/80 mmHg") e heart_rate,
-- que ja eram exibidos. Agora o check-in do paciente os atualiza, entao o paciente passa a
-- poder mover essas duas colunas, e elas nao mexem na versao do cadastro.
DROP TRIGGER IF EXISTS patients_guard_patient_columns ON patients;
CREATE TRIGGER patients_guard_patient_columns BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION app_guard_patient_columns(
    'current_pain', 'current_temp', 'current_spo2', 'blood_pressure', 'heart_rate', 'last_check_in_time', 'status',
    'wound_review_pending', 'medication_adherence_percent');

DROP TRIGGER IF EXISTS zz_patients_bump_version ON patients;
CREATE TRIGGER zz_patients_bump_version BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION app_bump_version(
    'current_pain', 'current_temp', 'current_spo2', 'blood_pressure', 'heart_rate', 'last_check_in_time', 'status',
    'wound_review_pending', 'medication_adherence_percent', 'check_in_reopened_at');
