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
- PostgreSQL 18 com schema normalizado e RLS em preparação (ver [Banco de dados](#banco-de-dados))

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

O comando também inicia a API de persistência na porta `3001`.

## Banco de dados

O estado clínico está sendo migrado do arquivo JSON para o PostgreSQL, com acesso controlado por RLS. Hoje o servidor ainda lê e grava o JSON: o schema, o importador e a verificação de paridade já existem, e a troca do servidor vem nas próximas etapas.

Suba um PostgreSQL local de desenvolvimento (cluster descartável em `.pgdata/`, porta `55432`, criado com `initdb`/`pg_ctl`, sem exigir `root`):

```bash
npm run db:cluster
npm run db:migrate
npm run db:import
npm run db:verify
```

- `db:cluster`: `start`, `stop`, `status` ou `destroy` (`node db/dev-cluster.mjs <comando>`)
- `db:migrate`: aplica `db/migrations/*.sql` em ordem, cada arquivo em uma transação, registrado em `schema_migrations` com checksum. Editar uma migração já aplicada faz o comando abortar; escreva uma nova.
- `db:import`: importa `.data/vivace-state.json`. Trunca e reinsere, então exige `--force` se `patients` já tiver linhas.
- `db:verify`: reidrata o agregado do banco e compara com o JSON de origem, campo a campo. É o gate da migração.

Dois papéis, e a distinção é o que faz o RLS valer: `MIGRATION_DATABASE_URL` (`vivace`) é dono das tabelas e cria o schema, enquanto `DATABASE_URL` (`vivace_api`) é o papel da aplicação. Policies de RLS não se aplicam ao dono da tabela, então o servidor vai conectar como `vivace_api`.

Detalhes que a normalização teve de preservar, porque o frontend depende deles:

- `position` em toda tabela filha guarda o índice do item no array do JSON. A ordem não é uniforme entre coleções (`check_ins` e `wound_photos` decrescentes, `timeline_events` e `messages` crescentes) e é lida pela tela, como em `checkIns[0]` como check-in de hoje e `medications.slice(0, 2)`.
- `post_op_day` é coluna armazenada, não derivada de `surgery_date`; os valores em produção são velhos de propósito e os selos "D+n" dependem deles.
- Fotos de upload viram `bytea`; fotos de demonstração ficam só em `image_source_url`. A distinção substitui o truque `imageUrl.includes('images.unsplash.com')` do frontend.
- `patient_care_team` decide **acesso**, com vários profissionais por paciente. `surgeon_label` guarda o **rótulo exibido** e só é usado quando o paciente não tem equipe, caso do `pat-2`, cujo cirurgião não tem cadastro. Sem essa separação, dar cadastro ao profissional inexistente tiraria o paciente da vista de quem o vê hoje.
- A API passa a devolver sempre as chaves opcionais `patientNotes`, `notes`, `reviewedBy`, `reviewedAt`, `reviewFeedback`, `photoUploaded` e `important`, mesmo quando vazias ou `false`. O JSON de origem era misto e alguns registros não tinham a chave; para o frontend, ausente e `false` são equivalentes.

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
- `VIVACE_DATA_DIRECTORY`: pasta com o JSON de origem, usada só pelo `npm run db:import` (padrão `.data/`)
- `DATABASE_URL`: conexão do Postgres usada pela aplicação
- `MIGRATION_DATABASE_URL`: conexão usada pelas migrações, que precisam criar tabelas
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

### Limite de tentativas de login

O `POST /api/auth/login` conta as falhas por endereço IP e por conta, separadamente. Ao passar de `VIVACE_LOGIN_MAX_ATTEMPTS` (padrão: 5), a resposta vira `429` com o cabeçalho `Retry-After` e a tentativa seguinte só é aceita depois de `VIVACE_LOGIN_LOCKOUT_MS` (padrão: 15 minutos). As falhas somam dentro de uma janela de `VIVACE_LOGIN_WINDOW_MS` (padrão: 15 minutos) e um login bem-sucedido zera os contadores.

Limitar pela conta impede que a força bruta distribuída por vários endereços passe, mas também permite que alguém tranque o acesso de um usuário legítimo com `VIVACE_LOGIN_MAX_ATTEMPTS` tentativas. Como os contadores ficam em memória, um reinício da API libera todo mundo; em produção, o desbloqueio precisa vir de um banco com registro das tentativas.

### Tempo de resposta do login

A resposta é a mesma (`401`, "Usuário ou senha inválidos") exista ou não a conta, e o servidor gasta o mesmo tempo nos dois casos: quando o usuário não existe, ou quando a senha ainda está em texto plano, roda um `scrypt` de descarte para compensar o `scrypt` que a verificação real não faria. Sem isso, um usuário inexistente responderia em milissegundos e o `scrypt` levaria dezenas, o que permite enumerar quem tem cadastro medindo a latência.

## Validar

```bash
npm run lint
npm run build
```

## Escopo

Esta versão é demonstrativa. A API exige autenticação por token, senha com `scrypt` e limite de tentativas por IP e por conta, mas ainda faltam criptografia em repouso, trilha de auditoria, renovação de token e o acesso por registro via RLS, que está em preparação. Nada disso deve ser usado com dados reais de pacientes.
