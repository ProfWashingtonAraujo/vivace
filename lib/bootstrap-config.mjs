// Credenciais do administrador inicial. Em desenvolvimento o padrão público
// (admin@vivace.med.br / vivace-demo) é conveniente; hospedado ele é uma porta
// aberta, porque a senha está no README. Por isso, quando a API roda no Render ou
// com NODE_ENV=production, subir sem uma senha própria é um erro, e a senha
// pública e as curtas demais também são recusadas.
const PUBLIC_DEMO_PASSWORD = 'vivace-demo';
const MIN_HOSTED_PASSWORD_LENGTH = 10;

const isHosted = env => env.RENDER === 'true' || env.NODE_ENV === 'production';

export const resolveBootstrap = (env = process.env) => {
  const email = env.VIVACE_BOOTSTRAP_EMAIL || 'admin@vivace.med.br';
  const configured = env.VIVACE_BOOTSTRAP_PASSWORD;

  if (!isHosted(env)) {
    return { email, password: configured || PUBLIC_DEMO_PASSWORD };
  }

  if (!configured || configured === PUBLIC_DEMO_PASSWORD || configured.length < MIN_HOSTED_PASSWORD_LENGTH) {
    throw new Error(
      `VIVACE_BOOTSTRAP_PASSWORD precisa ser definida com uma senha própria de pelo menos ${MIN_HOSTED_PASSWORD_LENGTH} caracteres (e diferente da senha pública de demonstração) quando a API roda hospedada.`
    );
  }
  return { email, password: configured };
};
