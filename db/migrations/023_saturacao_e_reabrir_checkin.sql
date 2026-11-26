-- Saturacao de oxigenio (SpO2) no check-in, e a equipe poder reabrir o check-in do dia.
--
-- spo2 e opcional: nem todo paciente tem oximetro. Fica no check-in (historico) e em
-- patients.current_spo2 (o ultimo valor, como a dor e a temperatura).
ALTER TABLE check_ins ADD COLUMN IF NOT EXISTS spo2 integer CHECK (spo2 IS NULL OR spo2 BETWEEN 50 AND 100);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS current_spo2 integer;

-- Reabrir nao apaga nada: a equipe marca o instante, e o paciente pode enviar mais um
-- check-in hoje se o ultimo de hoje foi criado antes dessa marca. O historico guarda os dois.
ALTER TABLE check_ins ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE patients ADD COLUMN IF NOT EXISTS check_in_reopened_at timestamptz;

-- O paciente move a saturacao (vem do check-in dele), mas nao a marca de reabertura:
-- essa so a equipe escreve.
DROP TRIGGER IF EXISTS patients_guard_patient_columns ON patients;
CREATE TRIGGER patients_guard_patient_columns BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION app_guard_patient_columns(
    'current_pain', 'current_temp', 'current_spo2', 'last_check_in_time', 'status',
    'wound_review_pending', 'medication_adherence_percent');

-- Nenhuma das duas mexe na versao do cadastro (a saturacao e gerada pelo paciente; a
-- reabertura e uma acao da equipe, e nao deve derrubar a edicao que outro colega tem aberta).
DROP TRIGGER IF EXISTS zz_patients_bump_version ON patients;
CREATE TRIGGER zz_patients_bump_version BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION app_bump_version(
    'current_pain', 'current_temp', 'current_spo2', 'last_check_in_time', 'status',
    'wound_review_pending', 'medication_adherence_percent', 'check_in_reopened_at');
