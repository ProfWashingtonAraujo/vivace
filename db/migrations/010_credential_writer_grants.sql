-- vivace_rls e o dono de app_set_credential, e uma funcao SECURITY DEFINER roda
-- com os privilegios do dono. A 006 deu apenas SELECT a esse papel, entao
-- app_set_credential falhava com "permission denied for table account_credentials"
-- na propria instrucao, e nao na chamada.
--
-- INSERT e UPDATE sao o que a funcao precisa. SELECT ja veio da 006 e nao e
-- concedido a mais ninguem: vivace_api continua sem leitura.

GRANT INSERT, UPDATE ON account_credentials TO vivace_rls;
