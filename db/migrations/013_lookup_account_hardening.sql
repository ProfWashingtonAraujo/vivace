-- app_lookup_account casava o paciente por prefixo de e-mail com LIKE sem
-- escapar o identificador, e desempatava com LIMIT 1 sem ordem:
--   * "%%%" ou "mar_" viravam curinga e casavam pacientes que ninguem digitou;
--   * com dois pacientes no mesmo prefixo, o resultado era arbitrario.
-- Agora curingas sao literais e o prefixo so vale quando e unico. O casamento
-- exato (nome, e-mail completo) continua valendo para qualquer papel.
CREATE OR REPLACE FUNCTION app_lookup_account(identifier text)
RETURNS TABLE (role text, user_id text, name text, email text, password_hash text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  WITH wanted AS (
    SELECT app_normalize(identifier) AS value,
           replace(replace(replace(app_normalize(identifier), '\', '\'), '%', '\%'), '_', '\_') || '%' AS prefix
  ),
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
        OR (length(w.value) >= 3
            AND app_normalize(pt.email) LIKE w.prefix
            AND (SELECT count(*) FROM patients other WHERE app_normalize(other.email) LIKE w.prefix) = 1)
  )
  SELECT m.role, m.user_id, m.name, m.email, m.password_hash
    FROM matches m
   WHERE m.user_id IS NOT NULL
   ORDER BY m.rank, m.user_id
   LIMIT 1
$$;
ALTER FUNCTION app_lookup_account(text) OWNER TO vivace_rls;
REVOKE ALL ON FUNCTION app_lookup_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_lookup_account(text) TO vivace_api;
