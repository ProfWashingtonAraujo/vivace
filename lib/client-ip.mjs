// Endereço do cliente para os limites de tentativa e de requisição.
//
// X-Forwarded-For é uma lista que cada proxy confiável aumenta no FIM com o
// endereço de quem falou com ele. Tudo que vem antes foi escrito por quem fez a
// requisição e não vale nada: ler a primeira entrada deixava o atacante escolher
// o próprio IP a cada tentativa. Por isso só se confia em `trustedHops` entradas,
// contadas da direita, e com 0 (o padrão) o cabeçalho é ignorado e vale o socket.
const MAX_ADDRESS_LENGTH = 64;

export const clientAddress = ({ forwardedFor, remoteAddress } = {}, trustedHops = 0) => {
  const fallback = remoteAddress || 'desconhecido';
  if (!trustedHops) return fallback;
  const chain = String(forwardedFor ?? '').split(',').map(part => part.trim()).filter(Boolean);
  const entry = chain[chain.length - trustedHops];
  return entry && entry.length <= MAX_ADDRESS_LENGTH ? entry : fallback;
};
