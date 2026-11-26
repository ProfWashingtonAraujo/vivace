// Validação das ações que só a equipe faz. Cada função devolve APENAS o que o servidor
// aceita do cliente: o texto da nota, o veredito e o comentário da avaliação. Autor,
// revisor, data e id nunca passam por aqui, porque são decididos no servidor.
const MAX_NOTE_LENGTH = 2_000;
const MAX_REVIEW_FEEDBACK_LENGTH = 1_000;
const MAX_CLIENT_ID_LENGTH = 100;

const asObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

export const validateNote = input => {
  const body = asObject(input);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > MAX_NOTE_LENGTH) return { ok: false };
  // clientId é a chave de idempotência: repetir a chamada com o mesmo valor não duplica.
  const clientId = typeof body.clientId === 'string' && body.clientId && body.clientId.length <= MAX_CLIENT_ID_LENGTH
    ? body.clientId
    : undefined;
  return { ok: true, text, clientId };
};

// 'pendente' não é veredito: é o estado de uma foto ainda sem avaliação.
const REVIEW_VERDICTS = new Set(['avaliado_adequado', 'requer_atencao']);

export const validateReview = input => {
  const body = asObject(input);
  if (typeof body.status !== 'string' || !REVIEW_VERDICTS.has(body.status)) return { ok: false };
  if (body.feedback !== undefined && typeof body.feedback !== 'string') return { ok: false };
  const feedback = (body.feedback ?? '').trim();
  if (feedback.length > MAX_REVIEW_FEEDBACK_LENGTH) return { ok: false };
  return { ok: true, status: body.status, feedback };
};

// Os mesmos títulos que o front usava ao registrar a avaliação na linha do tempo.
export const reviewTimelineTitle = status =>
  status === 'avaliado_adequado' ? 'Cicatrização aprovada' : 'Ferida requer atenção';
