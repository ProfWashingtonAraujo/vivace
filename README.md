# VIVACE

Plataforma Angular para acompanhamento pós-operatório, com experiências separadas para equipe profissional, paciente e administração.

## Tecnologias

- Angular 21 com componentes standalone e Signals
- Angular Aria para abas e acordeões acessíveis
- Signal Forms no formulário de login
- Highcharts Angular para evolução de dor e temperatura
- TypeScript em modo estrito
- Tailwind CSS 4
- API Node com autenticação por token, senhas em `scrypt` e permissões por papel
- Persistência demonstrativa compartilhada na rede local, com contingência em `localStorage`

## Funcionalidades

- Painel profissional com triagem, alertas e prontuário clínico
- Portal do paciente com check-in, medicamentos, mensagens e envio de fotos
- Painel administrativo com CRUD de profissionais e pacientes
- Login com sessão por token e permissões distintas para cada perfil
- Layout responsivo para desktop e dispositivos móveis

## Executar

Requer Node.js 22.9 ou superior.

```bash
npm install
npm run dev
```

A aplicação estará disponível em `http://localhost:3000`. Outros dispositivos na mesma rede podem acessar pelo IP do computador, por exemplo `http://192.168.0.4:3000`.

O comando também inicia a API de persistência na porta `3001`. Os dados compartilhados ficam em `.data/` no computador que executa a aplicação.

### Portas

As portas são configuradas por variáveis de ambiente. Para torná-las permanentes, copie `.env.example` para `.env` e ajuste os valores:

```bash
cp .env.example .env
```

O `.env` é carregado automaticamente pelo `npm run dev` e pelo `npm run start`. Também é possível passar as variáveis direto no comando:

```bash
VIVACE_FRONTEND_PORT=4321 VIVACE_API_PORT=4001 npm run dev
```

- `VIVACE_FRONTEND_PORT`: porta do frontend Angular (padrão `3000`)
- `VIVACE_API_PORT`: porta da API de persistência (padrão `3001`)
- `VIVACE_DATA_DIRECTORY`: pasta dos dados compartilhados (padrão `.data/`)
- `VIVACE_SKIP_FRONTEND=true`: inicia apenas a API
- `VIVACE_SESSION_TTL_MS`: validade da sessão em milissegundos (padrão `28800000`, 8 horas)
- `VIVACE_BOOTSTRAP_EMAIL` / `VIVACE_BOOTSTRAP_PASSWORD`: credenciais do administrador inicial (padrão `admin@vivace.med.br` / `vivace-demo`)
- `VIVACE_ALLOWED_ORIGINS`: origens extras liberadas no CORS, separadas por vírgula

Verifique se as portas estão livres antes de iniciar:

```bash
ss -tln | grep -E ':(3000|3001)'
```

Se a `VIVACE_API_PORT` estiver ocupada por outro servidor, o check-in no celular vai exibir "não foi sincronizado": o frontend cai no servidor alheio, que responde 404 em `/api/state`, e o salvamento é descartado. Use outra porta em `VIVACE_API_PORT`.

## Autenticação e API

Toda rota exige um token de sessão (`Authorization: Bearer <token>`), emitido por `POST /api/auth/login` com usuário e senha. A senha é comparada com `scrypt` e nunca trafega nem é devolvida pela API.

| Rota | Profissional | Paciente |
| --- | --- | --- |
| `POST /api/auth/login` | público | público |
| `GET /api/state` | todos os pacientes | apenas o próprio registro, sem notas clínicas |
| `PUT /api/state` | permitido | `403` |
| `POST /api/messages` | envia como `equipe` | envia como `paciente`, apenas para si mesmo |
| `GET /api/events` | eventos de todos | apenas os próprios eventos |

O remetente da mensagem é definido pelo servidor conforme o papel do token, então um paciente não consegue se passar pela equipe. O CORS só responde à própria origem do frontend.

Contas de demonstração (senha `vivace-demo`):

| Perfil | Usuário |
| --- | --- |
| Profissional | `Rafaely Carvalho` ou `rafaely.carvalho@vivace.med.br` |
| Paciente | `mariana` ou `mariana.souza@email.com` |
| Administração | `admin@vivace.med.br` |

No primeiro acesso a API cria a conta de administração inicial. Ao entrar como administrador, todas as senhas ainda em texto plano da base são convertidas para `scrypt`.

## Validar

```bash
npm run lint
npm run build
```

## Escopo

Esta versão é demonstrativa. A API exige autenticação por token e senha com `scrypt`, mas ainda faltam criptografia em repouso, trilha de auditoria, renovação de token, limite de tentativas de login e um banco de dados com controle de acesso por registro. Nada disso deve ser usado com dados reais de pacientes.
