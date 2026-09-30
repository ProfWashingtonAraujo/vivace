-- O hash de senha nao pode ficar em patients/professionals/admins.
--
-- A migracao 004 tentou REVOKE SELECT (password_hash) e isso nao funciona: no
-- PostgreSQL o privilegio de coluna e aditivo e nao pode ser mais restritivo que
-- o de tabela, entao um papel com SELECT na tabela continua lendo a coluna
-- (attacl fica NULL e a coluna segue acessivel, como o teste mostrou devolvendo
-- scrypt$ para vivace_api em contexto admin). Revogar a tabela e conceder coluna
-- por coluna exigiria dezenas de GRANTs frágeis a cada coluna nova.
--
-- A solucao e nao guardar o segredo na tabela clinica: account_credentials fica
-- isolada, sem privilege nenhum para vivace_api. A aplicacao nao tem como ler o
-- hash, nem por engano, e o login passa obrigatoriamente por
-- app_lookup_account, que e o unico ponto auditavel.
--
-- Nao ha FK para as tres tabelas de conta porque o account_id aponta para uma
-- uniao delas; a coerencia e mantida pelo import e pela migracao de senhas.

CREATE TABLE account_credentials (
  account_id text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('admin', 'professional', 'patient')),
  password_hash text
);

ALTER TABLE account_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_credentials FORCE ROW LEVEL SECURITY;
-- Nenhuma policy concede leitura: vivace_api nao tem privilegio algum aqui.
-- Admin tambem nao le, porque nao precisa; o hash sai so por app_lookup_account.
DROP POLICY IF EXISTS account_credentials_select ON account_credentials;

INSERT INTO account_credentials (account_id, role, password_hash)
SELECT id, 'patient', password_hash FROM patients WHERE password_hash IS NOT NULL
ON CONFLICT (account_id) DO UPDATE SET password_hash = EXCLUDED.password_hash;
INSERT INTO account_credentials (account_id, role, password_hash)
SELECT id, 'professional', password_hash FROM professionals WHERE password_hash IS NOT NULL
ON CONFLICT (account_id) DO UPDATE SET password_hash = EXCLUDED.password_hash;
INSERT INTO account_credentials (account_id, role, password_hash)
SELECT id, 'admin', password_hash FROM admins WHERE password_hash IS NOT NULL
ON CONFLICT (account_id) DO UPDATE SET password_hash = EXCLUDED.password_hash;

ALTER TABLE patients DROP COLUMN password_hash;
ALTER TABLE professionals DROP COLUMN password_hash;
ALTER TABLE admins DROP COLUMN password_hash;

REVOKE ALL ON account_credentials FROM PUBLIC;
GRANT SELECT ON account_credentials TO vivace_rls;

CREATE OR REPLACE FUNCTION app_lookup_account(identifier text)
RETURNS TABLE (role text, user_id text, name text, email text, password_hash text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  WITH wanted AS (SELECT app_normalize(identifier) AS value),
  matches AS (
    SELECT 1 AS rank, 'admin'::text AS role, a.id AS user_id, a.name, a.email::text, c.password_hash
      FROM admins a
      CROSS JOIN wanted w
      LEFT JOIN account_credentials c ON c.account_id = a.id AND c.role = 'admin'
     WHERE app_normalize(a.name) = w.value OR app_normalize(a.email) = w.value
    UNION ALL
    SELECT 2, 'professional', p.id, p.name, p.email::text, c.password_hash
      FROM professionals p
      CROSS JOIN wanted w
      LEFT JOIN account_credentials c ON c.account_id = p.id AND c.role = 'professional'
     WHERE app_normalize(p.name) = w.value OR app_normalize(p.email) = w.value
    UNION ALL
    SELECT 3, 'patient', pt.id, pt.name, pt.email::text, c.password_hash
      FROM patients pt
      CROSS JOIN wanted w
      LEFT JOIN account_credentials c ON c.account_id = pt.id AND c.role = 'patient'
     WHERE app_normalize(pt.name) = w.value
        OR app_normalize(pt.email) = w.value
        OR (length(w.value) >= 3 AND app_normalize(pt.email) LIKE w.value || '%')
  )
  SELECT m.role, m.user_id, m.name, m.email, m.password_hash
    FROM matches m
   WHERE m.user_id IS NOT NULL
   ORDER BY m.rank
   LIMIT 1
$$;
ALTER FUNCTION app_lookup_account(text) OWNER TO vivace_rls;
