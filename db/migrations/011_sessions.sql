-- Sessoes e tentativas de login saem da memoria do processo. A razao e o
-- comportamento que o Map em memoria nao conseguia dar: o bloqueio de forca
-- bruta sobrevivia a um restart, e valia igual em qualquer replica. Com o Map,
-- reiniciar o servidor zerava a contagem, e duas replicas dividiam a conta pela
-- metade -- cinco tentativas em cada uma entravam como uma.
--
-- Estas duas tabelas NAO tem RLS, e a decisao e deliberada. A identidade da
-- sessao chega ao banco por GUCs montados em withSession, mas a consulta de
-- sessao acontece ANTES de existir sessao: ainda nao ha papel para avaliar. Um RLS
-- aqui exigiria uma policy que liberasse a leitura por token, o que equivale a
-- nao ter RLS, com uma camada a mais para manter.
--
-- O relogio e o do banco (now()), nao o do Node, para que TTL e bloqueio valham
-- igual em qualquer replica. O Node pode estar adiantado ou atrasado.

CREATE TABLE sessions (
  token text PRIMARY KEY,
  role text NOT NULL,
  user_id text NOT NULL,
  name text NOT NULL,
  -- Expiracao ABSOLUTA, gravada no login e nunca reescrita. Com o TTL deslizante
  -- do Map, cada requisicao autenticada reescrevia expiresAt; no banco isso
  -- seria um UPDATE por request, trocando uma leitura em memoria por uma escrita
  -- no caminho quente.
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Serve ao varredor periodico, que apaga o que ja venceu.
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- A chave e a mesma forma que o servidor usava no Map: 'ip:<endereco>' e
-- 'conta:<identificador normalizado>'. Uma chave so, porque as duas dimensoes do
-- bloqueio compartilham a mesma janela e o mesmo teto.
CREATE TABLE login_attempts (
  key text PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0,
  first_attempt_at timestamptz NOT NULL,
  -- NULL significa nunca bloqueado, e nao '-infinity' como se registraria a conta.
  -- '-infinity' e valido em Postgres, mas o node-postgres nao sabe parsear
  -- timestamptz infinito: qualquer `SELECT *` numa ferramenta de debug, num
  -- dump ou num futuro teste quebraria com erro de scanner. NULL nao tem esse
  -- problema e, em `locked_until > now()`, devolve NULL, que ja exclui a linha.
  locked_until timestamptz
);

-- ------------------------------------------------------------------ bloqueio

-- Registra uma falha. A janela que vale e a de first_attempt_at: se ela venceu,
-- a contagem comeca de novo, como o Map fazia ao reescrever a entrada.
--
-- Fica numa funcao porque o ON CONFLICT sozinho nao daria: as tres colunas mudam
-- juntas e o Postgres avalia todas as expressoes do SET contra a linha ANTIGA, o
-- que aqui e exatamente o que se quer. Em uma unica instrucao, duas requisicoes
-- simultaneas para a mesma chave se serializam no indice e nenhuma contagem se
-- perde.
CREATE FUNCTION app_record_login_failure(
  target_key text,
  window_ms integer,
  lockout_ms integer,
  max_attempts integer
)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO login_attempts (key, failures, first_attempt_at, locked_until)
  VALUES (target_key, 1, now(), NULL)
  ON CONFLICT (key) DO UPDATE SET
    failures = CASE
      WHEN login_attempts.first_attempt_at <= now() - make_interval(secs => window_ms::double precision / 1000)
        THEN 1
      ELSE login_attempts.failures + 1
    END,
    first_attempt_at = CASE
      WHEN login_attempts.first_attempt_at <= now() - make_interval(secs => window_ms::double precision / 1000)
        THEN now()
      ELSE login_attempts.first_attempt_at
    END,
    locked_until = CASE
      WHEN login_attempts.first_attempt_at <= now() - make_interval(secs => window_ms::double precision / 1000)
        THEN NULL
      WHEN login_attempts.failures + 1 >= max_attempts
        THEN now() + make_interval(secs => lockout_ms::double precision / 1000)
      ELSE login_attempts.locked_until
    END
$$;

-- Quanto falta de bloqueio, em milissegundos, considering o pior caso entre as
-- chaves informadas (o IP e a conta). Sem chave bloqueada, 0.
--
-- STABLE e nao VOLATILE: le a tabela, mas nao apaga. A limpeza dos registros
-- antiquity fica com o varredor periodico, para que o caminho de leitura do
-- login nao grave nada.
--
-- bigint volta como string no node-postgres: quem chama precisa de Number().
--
-- A janela e o teto ficam de fora de proposito: sao politica do servidor, lida do
-- .env, e nao do schema.
CREATE FUNCTION app_login_lockout_ms(target_keys text[])
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT COALESCE(ceil(EXTRACT(EPOCH FROM (max(a.locked_until) - now())) * 1000)::bigint, 0)
  FROM login_attempts a
  WHERE a.key = ANY (target_keys) AND a.locked_until > now()
$$;

-- ------------------------------------------------------------------ grants

-- PUBLIC nunca recebe nada, como nas tabelas de clinica.
REVOKE ALL ON sessions, login_attempts FROM PUBLIC;

-- INSERT e DELETE sao do login e do logout; SELECT e do caminho quente de auth.
GRANT SELECT, INSERT, DELETE ON sessions TO vivace_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON login_attempts TO vivace_api;

-- As duas funcoes sao SECURITY INVOKER (o padrao): nao ha RLS para furar, entao
-- nao ha motivo para delas rodarem com privilegio de dono. Precisam dos GRANTs de
-- tabela acima para funcionar, o que e o modelo honesto.
GRANT EXECUTE ON FUNCTION app_login_lockout_ms(text[]) TO vivace_api;
GRANT EXECUTE ON FUNCTION app_record_login_failure(text, integer, integer, integer) TO vivace_api;
