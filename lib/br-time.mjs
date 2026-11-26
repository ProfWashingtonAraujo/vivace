// Data e hora no formato que o front sempre gravou nos textos do prontuário
// (dd/mm/aaaa e hh:mm), no fuso de São Paulo. Quem decide a hora de uma nota, de uma
// avaliação ou de um evento da linha do tempo é o servidor, e o relógio do aparelho do
// usuário (que pode estar errado ou ser forjado) deixa de contar.
const timeZone = 'America/Sao_Paulo';

const dateFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone });
const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });

export const brDateTime = (moment = new Date()) => ({
  date: dateFormat.format(moment),
  time: timeFormat.format(moment)
});
