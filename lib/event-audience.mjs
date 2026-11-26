// Quem recebe um evento do stream. Espelha app_can_access_patient no banco: o
// admin vê tudo, o paciente só o próprio registro, e o profissional os pacientes
// da sua equipe (paciente sem equipe só o admin vê). O SSE é a única rota que não
// passa pelo RLS, então a regra tem que ser repetida aqui.
//
// `audience` é { professionalIds } (a equipe do paciente do evento), ou null quando
// não foi possível consultar. Sem público conhecido a decisão é fechada: só o dono
// do registro e o admin recebem.
export const shouldDeliver = (session, event, audience) => {
  if (session.role === 'admin') return true;
  if (!event.patientId) return false;
  // Evento só da equipe (por exemplo, uma nota clínica): o paciente não recebe nem o
  // aviso, porque até a existência e o momento de uma nota são da equipe.
  if (session.role === 'patient') return !event.staffOnly && event.patientId === session.userId;
  if (session.role === 'professional') {
    if (!audience) return false;
    return audience.professionalIds.includes(session.userId);
  }
  return false;
};
