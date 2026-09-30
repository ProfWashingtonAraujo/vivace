-- vivace_rls e dono das funcoes SECURITY DEFINER (app_can_access_patient e
-- app_lookup_account) e tem BYPASSRLS, mas BYPASSRLS apenas pula as policies:
-- ainda sao necessarios os privilegios de tabela. Sem estes GRANTs as funcoes
-- falhavam com "permission denied for table patient_care_team" /
-- "... for table admins", o que fazia toda consulta negada por erro em vez de
-- por policy.

GRANT SELECT ON patient_care_team, patients, professionals, admins TO vivace_rls;
