// Corpo, JSON e tratamento de erro do servidor HTTP.

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

// Lê o corpo com teto de tamanho. Estourar o teto vira 413: o corpo restante é
// descartado (resume) em vez de destruir a conexão, para que a resposta ainda
// chegue ao cliente. Destruir o socket fazia o estouro aparecer como queda de
// conexão, e o handler acabava respondendo 500.
export const readBody = (request, limit) => new Promise((resolve, reject) => {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    reject(httpError(413, 'Payload too large'));
    return;
  }
  const chunks = [];
  let size = 0;
  let settled = false;
  const fail = error => {
    if (settled) return;
    settled = true;
    chunks.length = 0;
    request.resume();
    reject(error);
  };
  request.on('data', chunk => {
    if (settled) return;
    size += chunk.length;
    if (size > limit) fail(httpError(413, 'Payload too large'));
    else chunks.push(chunk);
  });
  request.on('end', () => {
    if (settled) return;
    settled = true;
    resolve(Buffer.concat(chunks).toString('utf8'));
  });
  request.on('error', error => fail(error));
});

// JSON inválido é erro do cliente (400), não do servidor.
export const parseJson = text => {
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, 'Invalid JSON');
  }
};

// Handler assíncrono do http.createServer: uma rejeição que ninguém trata derruba
// o processo no Node 15+. Aqui toda rejeição chega ao `onError`, e o servidor
// continua de pé.
export const safeHandler = (handler, onError) => (request, response) => {
  Promise.resolve()
    .then(() => handler(request, response))
    .catch(error => {
      try {
        onError(error, request, response);
      } catch (nested) {
        console.error('Falha no tratador de erro:', nested);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    });
};
