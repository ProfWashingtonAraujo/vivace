// O PUT /api/state do admin reescreve a lista de admins inteira e apaga o que não
// veio (writeAdmins), tratando "sem o campo" como lista vazia. Mandar zero admins
// deixaria o sistema sem ninguém para entrar e, com o bootstrap, devolveria a conta
// inicial no próximo login anônimo. Só vale para o admin: o profissional não
// escreve admins.
export const removesLastAdmin = (session, incoming) => {
  if (session.role !== 'admin') return false;
  const admins = Array.isArray(incoming?.admins) ? incoming.admins : [];
  return !admins.some(admin => admin && typeof admin.id === 'string');
};

// O PUT reescreve o estado a partir de um corpo que o cliente montou com o que
// tinha na tela. Duas proteções contra um corpo que não reflete a realidade.

// Mensagens: o PUT só pode marcar como lida uma mensagem que já existe. Antes ele
// fazia upsert de remetente, nome, texto e leitura vindos do corpo, o que permitia
// reescrever mensagem do paciente e forjar remetente. Mensagens novas só nascem
// por POST /api/messages, onde o remetente sai da sessão.
export const idsMarkedRead = messages => (Array.isArray(messages) ? messages : [])
  .filter(message => message && typeof message.id === 'string' && message.isRead === true)
  .map(message => message.id);

// Exclusão em massa: a tela apaga um paciente por vez. Um salvamento que apagaria
// vários vem de estado velho ou de uma lista vazia (por exemplo, a carga falhou),
// e levar o prontuário de todos junto não é o que ninguém quis. Valor que não é
// número recusa por segurança.
const MAX_PATIENT_DELETIONS_PER_SAVE = 1;
export const exceedsDeletionLimit = count => !(Number.isInteger(count) && count <= MAX_PATIENT_DELETIONS_PER_SAVE);
