-- Super administrador: o admin que gerencia as contas de administrador.
--
-- O papel de sessao continua 'admin' (as policies de RLS nao mudam); a distincao e uma coluna
-- e a checagem fica no store: so um super admin cria e apaga administradores ou muda o
-- `is_super` de alguem, e um admin comum edita so a propria conta. O servidor nunca deixa
-- o sistema sem super admin.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS is_super boolean NOT NULL DEFAULT false;

-- Quem ja administra hoje vira super: o primeiro da fila, se ainda nao houver nenhum.
SELECT set_config('app.role', 'admin', true), set_config('app.user_id', 'adm-1', true);
UPDATE admins SET is_super = true
 WHERE id = (SELECT id FROM admins ORDER BY position, id LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM admins WHERE is_super);

-- O administrador inicial (banco sem nenhum admin) ja nasce super.
CREATE OR REPLACE FUNCTION app_bootstrap_admin(admin_id text, admin_name text, admin_email text, new_hash text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  WITH created AS (
    INSERT INTO admins (id, name, email, position, is_super)
    SELECT admin_id, admin_name, admin_email, 0, true
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
