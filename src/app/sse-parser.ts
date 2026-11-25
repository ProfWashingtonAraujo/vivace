// Leitor de Server-Sent Events para quem usa fetch em vez de EventSource.
//
// O EventSource não manda cabeçalho de autorização, então o token ia na URL, onde
// aparece em logs de proxy, histórico e Referer. Lendo o stream com fetch o token
// vai em `Authorization`, como nas outras rotas. Em troca, o parsing e a
// reconexão passam a ser nossos: este módulo cuida do primeiro.

export interface SseParser {
  push(chunk: string): void;
}

interface SseParserOptions {
  /** Teto do que fica acumulado sem fechar um evento. Passou disso, descarta. */
  maxBufferChars?: number;
}

const DEFAULT_MAX_BUFFER_CHARS = 1_000_000;

export const createSseParser = (onData: (data: string) => void, options: SseParserOptions = {}): SseParser => {
  const maxBufferChars = options.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
  let buffer = '';
  let discarding = false;

  const dispatch = (block: string): void => {
    const lines: string[] = [];
    for (const line of block.split('\n')) {
      // Linhas que começam com ":" são comentário (o servidor manda ": connected").
      if (line.startsWith(':') || !line.startsWith('data:')) continue;
      const value = line.slice('data:'.length);
      lines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
    if (lines.length) onData(lines.join('\n'));
  };

  return {
    push(chunk: string): void {
      buffer += chunk.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        // O evento que estourou o teto termina aqui e é jogado fora inteiro.
        if (discarding) discarding = false;
        else dispatch(block);
        boundary = buffer.indexOf('\n\n');
      }
      if (buffer.length > maxBufferChars) {
        buffer = '';
        discarding = true;
      }
    }
  };
};
