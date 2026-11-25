-- Administrador inicial sem privilegio de dono no runtime.
--
-- O servidor criava o primeiro admin abrindo uma conexao COMO DONO do banco, a
-- cada login, so para descobrir se ja existia algum. Isso deixava a credencial de
-- dono dentro do processo da API e fazia um login anonimo custar uma conexao TLS
-- nova. Agora a criacao e uma funcao SECURITY DEFINER, chamada com o papel
-- vivace_api, no mesmo padrao de app_lookup_account e app_set_credential.
--
-- Ela so cria quando NAO existe nenhum administrador, e e atomica: duas chamadas
-- simultaneas nao criam duas contas, e a segunda devolve false. Nunca altera um
-- admin que ja existe nem troca a senha dele.

-- O dono da funcao (vivace_rls) precisa poder inserir em admins; o INSERT em
-- account_credentials ja veio na 010. SELECT em admins ja veio de app_lookup_account.
GRANT INSERT ON admins TO vivace_rls;

CREATE OR REPLACE FUNCTION app_bootstrap_admin(admin_id text, admin_name text, admin_email text, new_hash text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  WITH created AS (
    INSERT INTO admins (id, name, email, position)
    SELECT admin_id, admin_name, admin_email, 0
     WHERE NOT EXISTS (SELECT 1 FROM admins)
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  ),
  credential AS (
    INSERT INTO account_credentials (account_id, role, password_hash)
    SELECT id, 'admin', new_hash FROM created
    ON CONFLICT (account_id) DO UPDATE SET password_hash = EXCLUDED.password_hash
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM created)
$$;
ALTER FUNCTION app_bootstrap_admin(text, text, text, text) OWNER TO vivace_rls;

REVOKE ALL ON FUNCTION app_bootstrap_admin(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_bootstrap_admin(text, text, text, text) TO vivace_api;
