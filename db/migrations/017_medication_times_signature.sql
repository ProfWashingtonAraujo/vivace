-- Os horarios de uma medicacao contam como conteudo dela.
--
-- A versao (016) sobe quando a linha muda. Mas os horarios moram em medication_times,
-- outra tabela: trocar so os horarios nao tocaria a linha da medicacao e a versao
-- ficaria parada, de modo que uma edicao concorrente dos horarios passaria
-- despercebida. A medicacao ganha `times_signature`, os horarios em ordem separados por
-- virgula; como a coluna faz parte da linha, mudar os horarios muda o conteudo e sobe a
-- versao pelo gatilho que ja existe.
--
-- Quem grava a assinatura:
--   * o app, que a calcula e grava junto com a medicacao (POST, PATCH e o PUT);
--   * o gatilho abaixo, como rede de seguranca para SQL direto em medication_times.
-- O app liga `app.skip_times_sync` durante a gravacao, senao cada horario inserido
-- recalcularia a assinatura e a versao subiria varias vezes numa unica edicao.

ALTER TABLE medications ADD COLUMN IF NOT EXISTS times_signature text NOT NULL DEFAULT '';

-- A migracao roda como dono da tabela, e com FORCE ROW LEVEL SECURITY as policies valem
-- tambem para ele: sem identidade, o UPDATE abaixo nao enxergaria linha nenhuma e nao
-- avisaria. Por isso o contexto admin explicito, so nesta transacao.
SELECT set_config('app.role', 'admin', true), set_config('app.user_id', 'adm-1', true);

-- Preenche a assinatura das medicacoes que ja existem SEM subir a versao delas: a coluna
-- e nova, o conteudo nao mudou.
ALTER TABLE medications DISABLE TRIGGER zz_medications_bump_version;
UPDATE medications m
   SET times_signature = coalesce((
     SELECT string_agg(t.time, ',' ORDER BY t.position, t.time)
       FROM medication_times t
      WHERE t.patient_id = m.patient_id AND t.medication_id = m.id), '');
ALTER TABLE medications ENABLE TRIGGER zz_medications_bump_version;

-- Recalcula a assinatura de UMA medicacao a partir dos horarios que ela tem agora.
CREATE OR REPLACE FUNCTION app_recompute_times_signature(target_patient text, target_medication text)
RETURNS void
LANGUAGE sql
SET search_path = public, pg_temp AS $$
  UPDATE medications m
     SET times_signature = coalesce((
       SELECT string_agg(t.time, ',' ORDER BY t.position, t.time)
         FROM medication_times t
        WHERE t.patient_id = m.patient_id AND t.medication_id = m.id), '')
   WHERE m.patient_id = target_patient AND m.id = target_medication
$$;

CREATE OR REPLACE FUNCTION app_sync_times_signature()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF current_setting('app.skip_times_sync', true) = 'on' THEN
    RETURN NULL;
  END IF;
  -- OLD so existe em UPDATE e DELETE, NEW so em INSERT e UPDATE: por isso os ramos. A
  -- chave de um horario nao muda na pratica, mas se mudar as duas medicacoes recalculam.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM app_recompute_times_signature(OLD.patient_id, OLD.medication_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM app_recompute_times_signature(NEW.patient_id, NEW.medication_id);
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS medication_times_sync_signature ON medication_times;
CREATE TRIGGER medication_times_sync_signature
  AFTER INSERT OR UPDATE OR DELETE ON medication_times
  FOR EACH ROW EXECUTE FUNCTION app_sync_times_signature();
