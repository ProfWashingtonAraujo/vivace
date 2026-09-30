-- A aplicacao precisa gravar hash de senha: cadastro de paciente pela tela de
-- gestao, troca de senha, e a conversao de texto plano para scrypt no login.
-- Sem isto, vivace_api levaria "permission denied" ao criar um paciente com senha.
--
-- O concessao e so de escrita, deliberadamente. SELECT continua negado, e o RLS
-- nao tem nenhuma policy de leitura nesta tabela, entao o hash nao volta por
-- SELECT nem por aggregate, nem com um bug de serializacao. A leitura continua
-- exclusiva de app_lookup_account.
--
-- DELETE tambem nao e concedido: remover uma conta e uma operacao administrativa
-- e nada no fluxo atual precisa disso.

GRANT INSERT, UPDATE ON account_credentials TO vivace_api;
