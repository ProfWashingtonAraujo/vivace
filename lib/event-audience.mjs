// Quem recebe um evento do stream. Espelha app_can_access_patient no banco: o
// admin vê tudo, o paciente só o próprio registro, e o profissional os pacientes
// da sua equipe ou os que ainda não têm equipe. O SSE é a única rota que não passa
// pelo RLS, então a regra tem que ser repetida aqui.
//
// `audience` é { everyone, professionalIds } do paciente do evento, ou null quando
// não foi possível consultar. Sem público conhecido a decisão é fechada: só o dono
// do registro e o admin recebem.
export const shouldDeliver = (session, event, audience) => {
  if (session.role === 'admin') return true;
  if (!event.patientId) return false;
  if (session.role === 'patient') return event.patientId === session.userId;
  if (session.role === 'professional') {
    if (!audience) return false;
    return audience.everyone || audience.professionalIds.includes(session.userId);
  }
  return false;
};
