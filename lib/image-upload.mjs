// Valida uma foto enviada como data URL. O prefixo `data:image/` sozinho aceitava
// qualquer coisa: o tipo vinha da string do cliente, e SVG (que carrega script) ou
// um arquivo de texto entravam como "imagem". Aqui o tipo tem que estar na lista,
// o conteúdo decodificado tem que começar com os bytes mágicos do mesmo tipo e o
// tamanho decodificado tem teto. Devolve { mime, size } ou null.
const SIGNATURES = {
  'image/jpeg': bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/png': bytes => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value),
  'image/webp': bytes => bytes.length >= 12
    && bytes.toString('latin1', 0, 4) === 'RIFF'
    && bytes.toString('latin1', 8, 12) === 'WEBP'
};

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const parseImageUpload = (value, maxBytes) => {
  if (typeof value !== 'string') return null;
  const match = /^data:([a-z0-9.+/-]+);base64,(.*)$/s.exec(value);
  if (!match) return null;
  const [, mime, payload] = match;
  const signature = SIGNATURES[mime];
  if (!signature || !payload || payload.length % 4 !== 0 || !BASE64.test(payload)) return null;
  // Tamanho decodificado calculado antes de alocar o buffer.
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const size = payload.length / 4 * 3 - padding;
  if (size <= 0 || size > maxBytes) return null;
  const bytes = Buffer.from(payload, 'base64');
  return signature(bytes) ? { mime, size: bytes.length } : null;
};
