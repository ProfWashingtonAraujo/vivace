-- Versao das entidades que a equipe edita.
--
-- Hoje o PUT /api/state regrava tudo a partir do que o cliente tinha na tela, e nada
-- diz se aquilo ainda e o que esta no banco. Cada entidade editavel ganha um numero de
-- versao; na fase 2, uma edicao feita sobre uma versao velha passa a ser recusada com
-- 409 em vez de sobrescrever em silencio.
--
-- A versao sobe quando o CONTEUDO muda, e so nesse caso. Duas coisas a distinguem de um
-- contador de gravacoes:
--   * o PUT regrava todas as linhas a cada salvamento com os mesmos valores. Se isso
--     subisse a versao, toda edicao legitima bateria num conflito;
--   * `position` e reescrito a cada salvamento a partir do indice no corpo.
-- Por isso o gatilho compara a linha inteira em jsonb, sem a versao, sem `position` e
-- sem as colunas listadas, e so soma 1 se houver diferenca.
--
-- O cliente nao escolhe a versao: o gatilho sempre sobrescreve o valor que veio no
-- UPDATE, e um INSERT sempre comeca em 1.

ALTER TABLE patients ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE medications ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE professionals ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- Argumentos do gatilho: colunas que NAO contam como mudanca de conteudo, alem de
-- `version` e `position`, que nunca contam.
CREATE OR REPLACE FUNCTION app_bump_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  ignored text[] := ARRAY['version', 'position'] || TG_ARGV;
BEGIN
  IF (to_jsonb(NEW) - ignored) IS DISTINCT FROM (to_jsonb(OLD) - ignored) THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END
$$;

-- INSERT: sempre a versao 1, mesmo que o cliente peca outra.
CREATE OR REPLACE FUNCTION app_start_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  NEW.version := 1;
  RETURN NEW;
END
$$;

-- Prefixo zz_: o gatilho de versao roda por ultimo entre os BEFORE UPDATE (a ordem e a
-- alfabetica), depois do guarda de colunas do paciente, e so ve a linha ja validada.

-- Pacientes: os sinais que o proprio paciente gera (check-in, dose, foto) e o status,
-- que os dois lados escrevem, ficam de fora. Senao um check-in do paciente derrubaria a
-- edicao do cadastro que a equipe tem aberta.
DROP TRIGGER IF EXISTS zz_patients_bump_version ON patients;
CREATE TRIGGER zz_patients_bump_version BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION app_bump_version(
    'current_pain', 'current_temp', 'last_check_in_time', 'status',
    'wound_review_pending', 'medication_adherence_percent');
DROP TRIGGER IF EXISTS zz_patients_start_version ON patients;
CREATE TRIGGER zz_patients_start_version BEFORE INSERT ON patients
  FOR EACH ROW EXECUTE FUNCTION app_start_version();

DROP TRIGGER IF EXISTS zz_medications_bump_version ON medications;
CREATE TRIGGER zz_medications_bump_version BEFORE UPDATE ON medications
  FOR EACH ROW EXECUTE FUNCTION app_bump_version();
DROP TRIGGER IF EXISTS zz_medications_start_version ON medications;
CREATE TRIGGER zz_medications_start_version BEFORE INSERT ON medications
  FOR EACH ROW EXECUTE FUNCTION app_start_version();

DROP TRIGGER IF EXISTS zz_instructions_bump_version ON instructions;
CREATE TRIGGER zz_instructions_bump_version BEFORE UPDATE ON instructions
  FOR EACH ROW EXECUTE FUNCTION app_bump_version();
DROP TRIGGER IF EXISTS zz_instructions_start_version ON instructions;
CREATE TRIGGER zz_instructions_start_version BEFORE INSERT ON instructions
  FOR EACH ROW EXECUTE FUNCTION app_start_version();

DROP TRIGGER IF EXISTS zz_professionals_bump_version ON professionals;
CREATE TRIGGER zz_professionals_bump_version BEFORE UPDATE ON professionals
  FOR EACH ROW EXECUTE FUNCTION app_bump_version();
DROP TRIGGER IF EXISTS zz_professionals_start_version ON professionals;
CREATE TRIGGER zz_professionals_start_version BEFORE INSERT ON professionals
  FOR EACH ROW EXECUTE FUNCTION app_start_version();
