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
