-- account_credentials: escrita liberada para a aplicacao, leitura nunca.
--
-- O RLS precisa de policy de INSERT e UPDATE. Sem elas, o UPDATE era barrado com
-- "permission denied for table account_credentials" mesmo tendo o privilegio
-- concedido na 007: quando RLS esta ligado e nao ha policy para o comando, o
-- Postgres nega o statement inteiro.
--
-- Nao ha policy de SELECT de proposito. O privilegio nem existe (a 007 concede
-- so INSERT e UPDATE), entao a leitura continua barrada em duas camadas: sem
-- privilegio e sem policy.
--
-- Por isso store.mjs nao usa INSERT ... ON CONFLICT DO UPDATE: o ON CONFLICT
-- precisa de SELECT para achar a linha conflitante, e SELECT e justamente o que
-- esta negado. Faz UPDATE e, se nao afetar linha nenhuma, INSERT.

DROP POLICY IF EXISTS account_credentials_insert ON account_credentials;
CREATE POLICY account_credentials_insert ON account_credentials FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS account_credentials_update ON account_credentials;
CREATE POLICY account_credentials_update ON account_credentials FOR UPDATE USING (true) WITH CHECK (true);
