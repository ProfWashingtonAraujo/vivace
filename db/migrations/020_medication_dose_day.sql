-- "Tomado" passa a valer so no dia em que o paciente marcou (America/Sao_Paulo, aaaa-mm-dd).
-- Antes, a marca ficava para sempre: a de ontem aparecia como de hoje, e as marcas de
-- demonstracao do seed apareciam como tomadas sem o paciente ter feito nada. Linhas
-- existentes ficam sem dia (NULL) e, por isso, nao contam como tomadas.
ALTER TABLE medication_doses ADD COLUMN IF NOT EXISTS taken_on text;

-- O paciente confirma e desfaz a propria dose: muda `taken` e o dia.
DROP TRIGGER IF EXISTS medication_doses_guard_patient_columns ON medication_doses;
CREATE TRIGGER medication_doses_guard_patient_columns BEFORE UPDATE ON medication_doses
  FOR EACH ROW EXECUTE FUNCTION app_guard_patient_columns('taken', 'taken_on');
