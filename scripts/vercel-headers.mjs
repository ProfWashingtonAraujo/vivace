// Leitura dos cabeçalhos de segurança declarados em vercel.json.
//
// A CSP é estática, mas a URL da API é escolhida no build (VIVACE_API_URL). Se as
// duas divergirem, o navegador bloqueia toda chamada à API e o site parece fora do
// ar sem nenhum erro no servidor. O build usa cspAllowsApi para falhar cedo.

export const headerValue = (config, key) => {
  const wanted = key.toLowerCase();
  for (const rule of config?.headers ?? []) {
    for (const header of rule.headers ?? []) {
      if (String(header.key).toLowerCase() === wanted) return header.value;
    }
  }
  return undefined;
};

export const cspAllowsApi = (config, apiUrl) => {
  const csp = headerValue(config, 'Content-Security-Policy');
  if (!csp) return false;
  let origin;
  try {
    origin = new URL(apiUrl).origin;
  } catch {
    return false;
  }
  const directive = csp.split(';').map(part => part.trim()).find(part => part.startsWith('connect-src'));
  if (!directive) return false;
  return directive.split(/\s+/).slice(1).includes(origin);
};
