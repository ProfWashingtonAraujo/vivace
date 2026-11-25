// Chaves do bloqueio de login. A chave de conta usa a conta RESOLVIDA, não o
// texto digitado: o login casa o paciente por prefixo de e-mail, então "mari",
// "maria" e "mariana" são a mesma conta, e uma chave por texto dava cinco
// tentativas novas a cada variação.
//
// Sem conta (identificador que não existe) a chave cai no texto normalizado, com
// teto de tamanho para que um identificador gigante não vire linha gigante.
const MAX_UNKNOWN_IDENTIFIER = 100;

export const loginKeys = ({ ip, account, identifier }) => [
  `ip:${ip}`,
  account
    ? `conta:${account.role}:${account.userId}`
    : `conta:?:${String(identifier ?? '').slice(0, MAX_UNKNOWN_IDENTIFIER)}`
];
