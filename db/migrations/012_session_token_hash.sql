-- O token de sessão deixa de ser a chave da tabela e passa a ser o hash dela.
--
-- Até aqui, sessions.token guardava o token que o cliente manda no cabeçalho. Isso
-- tornava a tabela um cofre de credencial: qualquer leitura da base -- um pg_dump,
-- uma réplica de leitura, um backup, um SQL injection em outra parte do banco --
-- entregava de uma vez todas as sessões válidas das últimas 8 horas, cada uma
-- pronta para ser reapresentada como se fosse o usuário. account_credentials já
-- tinha sido isolada exatamente por isso (a 006): o mesmo argumento vale para a
-- sessão, e só não tinha sido aplicado.
--
-- A correção é a mesma da senha, e por isso ela é conhecida aqui: guarda-se o
-- resumo e não o segredo. sha256 e não scrypt porque não há o que adivinhar: o
-- token tem 256 bits de entropia do CSPRNG e não existe dicionário. scrypt aqui
-- custaria ~100ms por requisição para proteger algo que não sofre ataque de força
-- bruta, e o login já paga scrypt de verdade onde ele importa.

-- As sessões em andamento não são convertidas, e sim descartadas, e quem provavelmente
-- vai notar é quem estiver logado enquanto esta migração roda: vai ter que entrar de
-- novo. Converter exigiria hashear a linha antiga em SQL, o que pediria a extensão
-- pgcrypto -- uma dependência a mais no schema para usar uma vez, em migração, e
-- descartada logo em seguida. Descartar é o comportamento seguro e não custa nada
-- real: o único estado de sessão que existe é de desenvolvimento.

DROP TABLE sessions;

CREATE TABLE sessions (
  -- O nome sem 'token' é deliberado. Ler `token_hash` na query avisa que o valor é
  -- um resumo; a coluna antiga se chamava `token` e parecia credencial.
  token_hash text PRIMARY KEY,
  role text NOT NULL,
  user_id text NOT NULL,
  name text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Sem RLS, de propósito, como na 011. A consulta que descobre quem é o chamador
-- acontece antes de existir sessão, então não há papel para avaliar. Um RLS aqui
-- exigiria uma policy que liberasse a leitura por token_hash, o que equivale a não
-- ter RLS com uma camada a mais para manter. O que protege a coluna é o fato de ela
-- não ser a credencial, não uma policy.
--
-- Não diga "sem policy, então RLS não se aplica": o oposto vale. Sem nenhuma policy,
-- RLS habilitado nega TUDO, e o FORCE alcança o dono também. A 004 registrou as duas
-- coisas em sessões distintas justamente porque separar as custou uma migração
-- inteira. Se algum dia esta tabela ganhar policy, ENABLE e FORCE têm de vir juntos,
-- com GRANT para quem escreve, ou o login volta a falhar com 42501.

REVOKE ALL ON sessions FROM PUBLIC;

-- INSERT e DELETE são do login e do logout; SELECT é do caminho quente de auth.
-- UPDATE não é concedido: nada reescreve sessão, e o TTL é absoluto.
GRANT SELECT, INSERT, DELETE ON sessions TO vivace_api;
