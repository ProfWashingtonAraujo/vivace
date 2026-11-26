// Cirurgião exibido para um paciente.
//
// O nome vem do cadastro do profissional (assim renomeá-lo atualiza a tela). Só quem tem
// papel `cirurgiao` na equipe conta como "o cirurgião": um membro com papel `equipe` (por
// exemplo, alguém atribuído para o paciente ficar visível a ele) não apaga o rótulo
// guardado em surgeon_label, que é o cirurgião responsável quando ele não tem cadastro.
// Sem cirurgião e sem rótulo, cai no primeiro membro da equipe.
export const displayedSurgeon = (team, label) => {
  const surgeon = team.find(member => member.role === 'cirurgiao') ?? (label ? null : team[0]);
  return surgeon ? `${surgeon.name} (${surgeon.crm_coren})` : (label ?? '');
};
