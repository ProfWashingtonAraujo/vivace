-- account_credentials: escrita por funcao, leitura nunca.
--
-- UPDATE ... WHERE coluna exige privilegio de SELECT sobre a coluna citada, e
-- SELECT aqui e justamente o que esta negado. Por isso o caminho de escrita
-- passa por uma funcao SECURITY DEFINER, como o de leitura ja passava por
-- app_lookup_account: a aplicacao ganha EXECUTE e nunca precisa de SELECT.
--
-- As policies de INSERT e UPDATE da 008 saem: nao sao necessarias, porque o
-- dono da funcao tem BYPASSRLS e nao passa por RLS. Sem elas, um INSERT ou
-- UPDATE direto na tabela nao Grant, so a funcao.
--
-- A garantia de leitura continua sendo a mais forte possivel: sem privilegio
-- de SELECT, a leitura falha com "permission denied for table", e nao
-- silenciosamente com zero linhas.

DROP POLICY IF EXISTS account_credentials_insert ON account_credentials;
DROP POLICY IF EXISTS account_credentials_update ON account_credentials;

CREATE OR REPLACE FUNCTION app_set_credential(account_id text, account_role text, new_hash text)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  UPDATE account_credentials
     SET password_hash = new_hash
   WHERE account_credentials.account_id = app_set_credential.account_id
     AND account_credentials.role = app_set_credential.account_role;
  INSERT INTO account_credentials (account_id, role, password_hash)
  SELECT app_set_credential.account_id, app_set_credential.account_role, app_set_credential.new_hash
  WHERE NOT EXISTS (SELECT 1 FROM account_credentials c
                     WHERE c.account_id = app_set_credential.account_id
                       AND c.role = app_set_credential.account_role);
$$;
ALTER FUNCTION app_set_credential(text, text, text) OWNER TO vivace_rls;

REVOKE ALL ON FUNCTION app_set_credential(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_set_credential(text, text, text) TO vivace_api;
