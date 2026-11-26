-- I9: um paciente sem equipe deixa de ser visivel a todos os profissionais.
--
-- Ate aqui a regra era "profissional da equipe, OU paciente sem ninguem atribuido":
-- enquanto um paciente nao tinha equipe, qualquer profissional o via e podia, por
-- exemplo, redefinir a senha dele. Isso e uma regra que falha aberta: tirar a ultima
-- pessoa da equipe, ou criar um paciente sem equipe, abria o prontuario a todos.
-- Agora o profissional so ve o paciente de cuja equipe faz parte, e quem esta sem
-- equipe so e visivel ao admin (e ao proprio paciente).

-- Identidade de admin so nesta transacao: com FORCE ROW LEVEL SECURITY as policies valem
-- tambem para o dono da tabela, e sem identidade o INSERT abaixo seria barrado.
SELECT set_config('app.role', 'admin', true), set_config('app.user_id', 'adm-1', true);

-- Os dados que ja existem: quem hoje esta sem equipe ganha uma explicita, com todos os
-- profissionais cadastrados (papel `equipe`), para ninguem perder acesso por causa da
-- mudanca. Em um banco com um unico profissional (a demonstracao), isso e dar a esse
-- profissional a equipe do paciente. Dai em diante a equipe e decisao do admin.
INSERT INTO patient_care_team (patient_id, professional_id, role, position)
SELECT p.id, pr.id, 'equipe',
       row_number() OVER (PARTITION BY p.id ORDER BY pr.position, pr.id) - 1
  FROM patients p
 CROSS JOIN professionals pr
 WHERE NOT EXISTS (SELECT 1 FROM patient_care_team t WHERE t.patient_id = p.id);

CREATE OR REPLACE FUNCTION app_can_access_patient(patient_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT CASE app_role_name()
    WHEN 'admin' THEN true
    WHEN 'patient' THEN patient_id = app_user_id()
    -- So quem esta na equipe. Sem equipe nao ha profissional com acesso.
    WHEN 'professional' THEN
      EXISTS (SELECT 1 FROM patient_care_team t
              WHERE t.patient_id = app_can_access_patient.patient_id
                AND t.professional_id = app_user_id())
    ELSE false
  END
$$;

-- Criar um paciente: o profissional nao pode exigir acesso ANTES de existir equipe (a
-- regra acima o barraria), entao a policy deixa de olhar o acesso e quem cria entra na
-- equipe pelo gatilho abaixo, na mesma operacao.
DROP POLICY IF EXISTS patients_insert ON patients;
CREATE POLICY patients_insert ON patients FOR INSERT WITH CHECK (
  app_role_name() IN ('admin', 'professional'));

-- Quem cria entra na equipe como cirurgiao. SECURITY DEFINER porque a policy de INSERT em
-- patient_care_team exige acesso ao paciente, que o criador so passa a ter por esta linha.
-- Nao abre brecha para "assumir" um paciente sem equipe: o gatilho so dispara no INSERT do
-- paciente, e o criador e o usuario da sessao, nunca um id vindo de fora.
GRANT INSERT ON patient_care_team TO vivace_rls;

CREATE OR REPLACE FUNCTION app_join_team_on_create()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF app_role_name() = 'professional' AND app_user_id() IS NOT NULL THEN
    INSERT INTO patient_care_team (patient_id, professional_id, role, position)
    VALUES (NEW.id, app_user_id(), 'cirurgiao', 0)
    ON CONFLICT (patient_id, professional_id) DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;
ALTER FUNCTION app_join_team_on_create() OWNER TO vivace_rls;

DROP TRIGGER IF EXISTS patients_join_team ON patients;
CREATE TRIGGER patients_join_team AFTER INSERT ON patients
  FOR EACH ROW EXECUTE FUNCTION app_join_team_on_create();
