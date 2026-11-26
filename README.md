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
- PostgreSQL 18 com schema normalizado, RLS por registro e testes de negação (ver [Banco de dados](#banco-de-dados))

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

O comando também inicia a API de persistência na porta `3001`. O estado compartilhado fica no Postgres; o arquivo `.data/vivace-state.json` é a fonte do import inicial e não é mais escrito pelo servidor.

## Banco de dados

O estado clínico fica no PostgreSQL, com acesso controlado por RLS. O servidor já lê e grava no banco; o arquivo JSON em `.data/` sobra só como fonte do import inicial.

Suba um PostgreSQL local de desenvolvimento (cluster descartável em `.pgdata/`, porta `55432`, criado com `initdb`/`pg_ctl`, sem exigir `root`):

```bash
npm run db:cluster
npm run db:migrate
npm run db:import
npm run db:verify
npm test
```

- `db:cluster`: `start`, `stop`, `status` ou `destroy` (`node db/dev-cluster.mjs <comando>`)
- `db:migrate`: aplica `db/migrations/*.sql` em ordem, cada arquivo em uma transação, registrado em `schema_migrations` com checksum. Editar uma migração já aplicada faz o comando abortar; escreva uma nova. As migrações pressupõem ordem: reaplicar uma antiga depois de uma posterior não funciona.
- `db:import`: importa `.data/vivace-state.json`. Trunca e reinsere, então exige `--force` se `patients` já tiver linhas.
- `db:verify`: reidrata o agregado do banco e compara com o JSON de origem, campo a campo. É o gate da migração.
- `test`: 59 asserções, 23 de RLS e 36 de API ponta a ponta. Roda com `--test-concurrency=1` de propósito: os dois arquivos reimportam a base no início e no fim, e dois `TRUNCATE` simultâneos travam com `deadlock detected`. Requer o cluster, as migrações e a importação rodados antes. Os testes gravam de verdade para exercitar a escrita, e restauram o banco ao final para não contaminar o gate.

### Como o acesso é controlado

A identidade da sessão chega ao banco por GUCs locais à transação, montados pelo `withSession` (`db/session.mjs`) dentro de um `BEGIN`/`COMMIT` no mesmo cliente do pool:

```sql
SELECT set_config('app.role', 'patient', true);
SELECT set_config('app.user_id', 'pat-1', true);
```

Sem esses GUCs, `app_role_name()` devolve `NULL` e tudo nega: falha fechada. Um papel inventado também não vê nada.

A filtragem não está mais no JavaScript. `GET /api/state` consulta tudo e devolve o que o RLS deixou passar, e as policies espelham o comportamento antigo, inclusive dois pontos que parecem contraditórios:

- Profissional só vê o paciente de cuja equipe faz parte. Um paciente **sem equipe** só é visível ao admin (e ao próprio paciente); antes da migração `018`, qualquer profissional o via (veja "Visibilidade e equipe do paciente").
- Paciente não vê nota clínica, nem a própria. `/api/checkins` devolvia o paciente inteiro com `clinicalNotes` para quem tem papel de paciente; agora a linha simplesmente não aparece.

As policies também corrigem um bug real: profissional passa a ver **apenas o próprio cadastro**, porque `professionalUser()` no frontend é `professionals()[0]` e, com todos visíveis, uma sessão do profissional #2 gravava o nome do #1 em `reviewedBy`, no autor da nota e no chat. O painel administrativo continua vendo todos, por ser papel `admin`.

### Escrita por papel (migração 015)

As tabelas filhas do paciente (linha do tempo, fotos, medicações, horários, doses, check-ins, mensagens e instruções) tinham uma única policy que não olhava o papel: quem lia o registro podia escrevê-lo. Para o papel `patient`, isso permitia, direto no banco, alterar a própria prescrição, mandar mensagem como `equipe`, mudar o resultado da avaliação de uma foto, forjar eventos da equipe na linha do tempo e trocar o próprio e-mail e nome (o login). Agora a leitura segue a regra de acesso ao paciente, admin e profissional com acesso escrevem como antes, e o paciente escreve apenas o que o fluxo dele precisa:

| Tabela | O que o paciente pode escrever |
| --- | --- |
| `messages` | inserir, somente com `sender = 'paciente'`; sem editar nem apagar |
| `check_ins` | inserir o próprio; `UPDATE` só da coluna `position` |
| `wound_photos` | inserir sempre `pendente` e sem avaliação; `UPDATE` só de `position` |
| `timeline_events` | inserir só `checkin` ou `curativo`, assinado `... (Paciente)` |
| `medication_doses` | confirmar e desfazer; `UPDATE` só de `taken` |
| `patients` | só `current_pain`, `current_temp`, `last_check_in_time`, `status`, `wound_review_pending` e `medication_adherence_percent` |
| `medications`, `medication_times`, `instructions`, `clinical_notes` | nada |

Uma policy não enxerga a linha antiga, então o limite por coluna é um gatilho (`app_guard_patient_columns`) que compara a linha inteira em `jsonb`: uma coluna nova no futuro já nasce protegida. Os sinais do check-in e a aderência continuam graváveis pelo paciente porque o servidor os calcula a partir do que ele envia.

**Equipe do paciente.** Um profissional só remove a si mesmo da equipe, e só se ela continua com mais alguém (`app_keep_care_team`); esvaziar uma equipe é decisão do admin. A regra de visibilidade que tornava isso grave (paciente sem equipe visível a todos) foi trocada na migração `018`: veja a seção abaixo.

### Quatro armadilhas que custaram tempo

- **Policies não se aplicam ao dono da tabela.** `MIGRATION_DATABASE_URL` (`vivace`) cria o schema; `DATABASE_URL` (`vivace_api`) é o papel da aplicação. Há também `FORCE ROW LEVEL SECURITY` em todas as tabelas. Os testes conectam como `vivace_api` de propósito: testar com o dono não provaria nada.
- **`app_can_access_patient` é `SECURITY DEFINER` com dono `vivace_rls`, um papel `BYPASSRLS`.** Sem isso a consulta sofreria recursão de policy e, pior, um profissional só veria as próprias linhas da equipe: veria zero linhas para um paciente atendido por outro e concluiria "sem equipe", gaining acesso a todos. Esse papel também precisa de `GRANT`, porque `BYPASSRLS` pula a policy mas não o privilégio.
- **`REVOKE SELECT (password_hash)` não funciona.** No PostgreSQL o privilégio de coluna é aditivo e não pode ser mais restritivo que o de tabela, então o papel continuava lendo a coluna. A saída foi `account_credentials`, isolada, e o login passa só por `app_lookup_account`.
- **`UPDATE ... WHERE coluna` exige `SELECT` sobre a coluna citada.** Como `account_credentials` não concede SELECT, nem um UPDATE simples passava, e `ON CONFLICT DO UPDATE` também não (ele precisa de SELECT para achar a linha). A escrita passou por `app_set_credential`, uma função `SECURITY DEFINER`, e as policies de INSERT/UPDATE dessa tabela saíram: só a função escreve.

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
- `VIVACE_DATA_DIRECTORY`: pasta com o JSON de origem, usada só pelo `npm run db:import` (padrão `.data/`). O servidor não grava mais ali.
- `DATABASE_URL`: conexão do Postgres usada pela aplicação
- `MIGRATION_DATABASE_URL`: conexão usada pelas migrações, pelo provisionamento e pelo import, que precisam de privilégio de dono. **O servidor da API não a usa**: ele roda só como `vivace_api` (um teste falha se o código de runtime voltar a abrir conexão de dono).
- `VIVACE_SKIP_FRONTEND=true`: inicia apenas a API
- `VIVACE_SESSION_TTL_MS`: validade da sessão em milissegundos (padrão `28800000`, 8 horas)
- `VIVACE_BOOTSTRAP_EMAIL` / `VIVACE_BOOTSTRAP_PASSWORD`: credenciais do administrador inicial. Em desenvolvimento o padrão é `admin@vivace.med.br` / `vivace-demo`. **Hospedado (Render ou `NODE_ENV=production`) a API não sobe** sem uma `VIVACE_BOOTSTRAP_PASSWORD` própria, com pelo menos 10 caracteres e diferente de `vivace-demo`.
- `VIVACE_ALLOWED_ORIGINS`: origens extras liberadas no CORS, separadas por vírgula

Verifique se as portas estão livres antes de iniciar:

```bash
ss -tln | grep -E ':(3000|3001)'
```

Se a `VIVACE_API_PORT` estiver ocupada por outro servidor, o check-in no celular vai exibir "não foi sincronizado": o frontend cai no servidor alheio, que responde 404 em `/api/state`, e o salvamento é descartado. Use outra porta em `VIVACE_API_PORT`.

## Publicação (Vercel + Render + Neon)

O front é estático e vai para a Vercel. A API (`server.mjs`) é um servidor Node de longa duração, com conexões de eventos abertas, e por isso roda no Render. O banco é um Postgres no Neon.

**1. Neon.** Crie o projeto e copie a conexão **direta** (sem `-pooler`): a API usa variáveis de sessão do RLS dentro de transações e as migrações usam trava consultiva.

**2. Render (API).** Web service Node a partir deste repositório:

- Build: `npm ci`
- Start: `npm run start:hosted` (aplica as migrações, define a senha do papel `vivace_api` e carrega `db/seed/demo-state.json` só se o banco estiver vazio; depois sobe a API **sem** `MIGRATION_DATABASE_URL` no ambiente, com `env -u`, então a credencial de dono existe só no provisionamento)
- Variáveis:
  - `MIGRATION_DATABASE_URL`: conexão do dono do banco (por exemplo `neondb_owner`).
  - `DATABASE_URL`: `postgresql://vivace_api:<senha-nova>@<host-direto>/neondb?sslmode=require`. A senha é definida por você aqui; o provisionamento a aplica ao papel.
  - `VIVACE_SKIP_FRONTEND=true`
  - `VIVACE_API_PORT`: a porta que o Render informa em `PORT` (padrão `10000`).
  - `VIVACE_ALLOWED_ORIGINS`: a URL pública do front na Vercel, com `https://`, sem barra no fim.
  - `VIVACE_BOOTSTRAP_PASSWORD`: obrigatória. Pelo menos 10 caracteres e diferente de `vivace-demo`, senão a API recusa subir.
  - `VIVACE_SEED_DEMO=false` se não quiser os dados de demonstração.

**3. Vercel (front).** Projeto ligado a este repositório. O `vercel.json` já define o build (`npm run build:vercel`) e a saída (`dist/browser`). Defina a variável `VIVACE_API_URL` com a URL pública da API no Render (sem barra no fim); ela é gravada no bundle em tempo de build e o build falha se ela faltar. Depois de mudar a URL da API é preciso um novo deploy.

Observação: no plano gratuito do Render a API hiberna após alguns minutos sem uso e a primeira requisição demora cerca de um minuto.

## Autenticação e API

Toda rota exige um token de sessão (`Authorization: Bearer <token>`), emitido por `POST /api/auth/login` com usuário e senha. A senha é comparada com `scrypt` e nunca trafega nem é devolvida pela API.

| Rota | Profissional | Paciente |
| --- | --- | --- |
| `POST /api/auth/login` | público | público |
| `GET /api/state` | todos os pacientes | apenas o próprio registro, sem notas clínicas |
| `POST /api/messages` | envia como `equipe` | envia como `paciente`, apenas para si mesmo |
| `GET /api/events` | eventos dos pacientes da equipe (mesma regra do RLS) | apenas os próprios eventos |

O remetente da mensagem é definido pelo servidor conforme o papel do token, então um paciente não consegue se passar pela equipe. O CORS só responde à própria origem do frontend.

Contas de demonstração (senha `vivace-demo`):

| Perfil | Usuário |
| --- | --- |
| Profissional | `Rafaely Carvalho` ou `rafaely.carvalho@vivace.med.br` |
| Paciente | `mariana` ou `mariana.souza@email.com` |
| Administração | `admin@vivace.med.br` |

No primeiro acesso a API cria a conta de administração inicial. Ao entrar como administrador, todas as senhas ainda em texto plano da base são convertidas para `scrypt`.

### Tamanho de corpo, fotos e erros

Cada rota tem o próprio teto de corpo: login 4 KB, mensagem 16 KB, confirmação de medicação 4 KB, check-in com foto 8 MB. Passar do teto responde `413`, e JSON inválido responde `400` (antes ambos viravam `500`). A foto de um check-in precisa ser JPEG, PNG ou WebP de verdade, conferida pelos bytes iniciais do arquivo e não só pelo tipo declarado, com até 6 MB depois de decodificada; SVG e texto disfarçado de imagem são recusados com `400`. Campos curtos (`mood`, `dayLabel`, `mobilityScore`, `senderName`, ids e cada sintoma) aceitam até 100 caracteres.

Qualquer erro que escape de uma rota, como uma falha de banco ao consultar a sessão, responde `500` e o processo continua de pé. Ainda não existe cota diária de check-ins ou fotos por paciente, porque a tabela `check_ins` não guarda a hora de criação.

### Gravações (fase 4: o `PUT /api/state` foi removido)

Não existe mais rota que grave o estado inteiro: `PUT /api/state` responde `405`, e só o `GET /api/state` continua. Toda alteração tem endpoint próprio, com a regra de quem pode, a validação e o controle de versão (`If-Match`) descritos nas seções das áreas 1 a 5. Com isso, um salvamento com tela velha não apaga o que outra pessoa criou, e autor, data e id sempre saem do servidor. O front grava por essas chamadas, sem fila de sincronização: se o servidor recusa ou há conflito (`409`), a tela avisa e recarrega. O botão "Restaurar dados de demonstração" também não existe mais.

### Integração contínua

`.github/workflows/ci.yml` roda em cada push com um Postgres 18 como serviço: gera um estado de teste com administrador (`scripts/make-test-state.mjs`, que exige um caminho de saída e nunca sobrescreve `.data/`), provisiona o banco pelo mesmo `npm run db:provision` do Render e executa `npm test`, o que inclui os testes de API e de RLS que precisam de banco. Um segundo job compila o front em modo de desenvolvimento e o build de produção da Vercel, que falha se a CSP não liberar a URL da API.

### Visibilidade e equipe do paciente (fase 2, área 3, parte I9)

Antes da migração `018` a regra era "profissional da equipe **ou** paciente sem equipe": enquanto um paciente não tinha ninguém atribuído, qualquer profissional o via e podia, por exemplo, redefinir a senha dele. Era uma regra que falhava aberta: tirar a última pessoa da equipe, ou criar um paciente sem equipe, abria o prontuário a todos. Agora:

- **O profissional só vê o paciente de cuja equipe faz parte.** Paciente sem equipe só é visível ao admin e ao próprio paciente. O mesmo vale para o stream de eventos.
- **Quem cria um paciente entra na equipe dele** como cirurgião, por um gatilho no próprio `INSERT` (`app_join_team_on_create`). Sem isso o criador não veria o que acabou de criar, e a criação de paciente quebraria. O gatilho só dispara na criação e usa o usuário da sessão, nunca um id vindo de fora: **ninguém consegue "assumir" um paciente que ficou sem equipe** (a policy de `patient_care_team` continua exigindo acesso ao paciente).
- **O admin cria sem equipe** e atribui depois; criar como admin não coloca ninguém na equipe.
- **Os dados existentes:** quem estava sem equipe na hora da migração ganhou uma equipe explícita, com todos os profissionais cadastrados (papel `equipe`), para ninguém perder acesso por causa da mudança. Na demonstração, que tem um profissional, o `pat-2` passou a ter o `prof-1` na equipe, e o cirurgião que aparece na tela continua o do rótulo (`Dr. Marcos Albuquerque`): só quem tem papel `cirurgiao` substitui o rótulo guardado (`lib/surgeon.mjs`).
- **Semente e import:** `db/seed/demo-state.json` traz `careTeam: ["prof-1"]` no `pat-2`, e o import aceita `careTeam` (lista de ids, papel `equipe`) para dar equipe a um paciente cujo cirurgião responsável não tem cadastro. Se o seu `.data/vivace-state.json` local tiver um paciente nesse caso, acrescente `careTeam`, ou ele ficará visível só ao admin.

### Ações da equipe (fase 2, área 1)

Primeiras chamadas próprias que substituem o `PUT /api/state`. Em todas, o servidor decide autor, revisor, data e id (da sessão e do relógio dele, no fuso de São Paulo); o corpo traz só a intenção, e qualquer `author`, `reviewedBy`, `date` ou `id` enviado é ignorado.

| Chamada | Corpo | Resposta |
| --- | --- | --- |
| `POST /api/patients/:id/clinical-notes` | `{ text, clientId? }` | `201 { note }`; `200` com a mesma nota se o `clientId` se repetir |
| `PUT /api/patients/:id/wound-photos/:photoId/review` | `{ status, feedback? }` com `status` `avaliado_adequado` ou `requer_atencao` | `200 { photo, timelineEventId, woundReviewPending }` |

A nota entra no início da lista, tem até 2000 caracteres e só a equipe com acesso ao paciente a cria (`403` para o paciente, `404` para quem não vê o paciente). A avaliação registra o revisor e a hora, acrescenta o evento "Cicatrização aprovada" ou "Ferida requer atenção" à linha do tempo e recalcula a marca de revisão pendente do paciente, tudo na mesma transação; o comentário vai até 1000 caracteres. `clientId` é a chave de idempotência: repetir a chamada não duplica a nota.

Em tempo real, uma nota gera `clinical-note.created`, **só para a equipe e sem o texto** (até a existência de uma nota é dela), e uma avaliação gera `wound-photo.reviewed`, que o paciente dono também recebe, sem o comentário. O `POST /api/messages` passou a usar sempre o nome da sessão como remetente, para os dois lados. A marcação de mensagem como lida não ganhou chamada porque nenhuma tela a usa: o front nunca marca `isRead`.

### Medicações e instruções (fase 2, área 2)

Criar, editar e apagar por chamadas próprias, com controle de versão:

| Chamada | Corpo | Resposta |
| --- | --- | --- |
| `POST /api/patients/:id/medications` | `{ name, times, dose?, frequency?, purpose?, instructions?, clientId? }` | `201 { medication }` (`200` se o `clientId` se repetir) |
| `PATCH /api/patients/:id/medications/:mid` | só os campos a mudar; cabeçalho `If-Match: <versão>` | `200 { medication }` |
| `DELETE /api/patients/:id/medications/:mid` | cabeçalho `If-Match: <versão>` | `200 { deleted, id }` |
| `POST /api/patients/:id/instructions` | `{ category, title, content?, important?, iconName?, clientId? }` | `201 { instruction }` |
| `PATCH` e `DELETE /api/patients/:id/instructions/:iid` | como acima | `200` |

`times` é uma lista de 1 a 12 horários `HH:MM` sem repetição; `category` é uma de `curativo`, `alimentacao`, `atividade`, `higiene`, `alerta`, `medicacao`. Id e versão são do servidor (o corpo não os escolhe), e o paciente recebe `403` em todas.

**`If-Match` é obrigatório em `PATCH` e `DELETE`.** Sem ele a resposta é `428`; com um valor que não é inteiro positivo, `400`; com uma versão que já mudou, `409` com o item atual em `current`, e nada é gravado. A conferência é do próprio `UPDATE ... WHERE version = $n`, então duas edições sobre a mesma versão não passam as duas. Regravar os mesmos valores não sobe a versão.

**Horários contam como conteúdo da medicação** (migração `017`). Eles ficam em `medication_times`, outra tabela; sem tratamento, trocar só os horários não mexeria na linha da medicação e a versão não subiria. A medicação ganhou `times_signature` (os horários em ordem, separados por vírgula), e como a coluna faz parte da linha, mudar os horários sobe a versão. O app grava a assinatura junto com a medicação (por isso desliga, só na transação, o gatilho de `medication_times` com `app.skip_times_sync`; sem isso cada horário inserido subiria a versão); o gatilho existe como rede de segurança para SQL direto. As doses já tomadas dos horários que ficam são mantidas, e um horário novo nasce não tomado. A aderência do paciente é recalculada ao criar e ao apagar.

Em tempo real, `medication.changed` e `instruction.changed` (com `change` igual a `created`, `updated` ou `deleted`) chegam à equipe e ao paciente dono, sem o conteúdo.

### Cadastro de paciente e equipe (fase 2, área 3b)

| Chamada | Corpo | Resposta |
| --- | --- | --- |
| `POST /api/patients` | `{ name, email, password, age?, gender?, phone?, cpf?, procedure?, surgeryDate?, dischargeDate?, hospital?, avatar?, clientId?, professionalIds? }` | `201 { patient }` (`200` se o `clientId` se repetir) |
| `PATCH /api/patients/:id` | só os campos a mudar; `If-Match: <versão>` | `200 { patient }` |
| `DELETE /api/patients/:id` | `If-Match: <versão>` | `200 { deleted, id }` |
| `PUT /api/patients/:id/password` | `{ password }` | `200 { id }` |
| `PUT /api/patients/:id/care-team` | `{ professionalIds }` (**só o admin**) | `200 { careTeam }` |

O servidor decide id, versão, status (`estavel`), sinais, dia de pós-operatório (dias desde `surgeryDate`, meio-dia de São Paulo) e o avatar padrão; `status`, `currentPain`, `id`, `version` e `postOpDay` enviados no corpo são ignorados. Datas são `AAAA-MM-DD`, o avatar é vazio, `https` ou uma imagem JPEG, PNG ou WebP de até 512 KB, e a senha tem de 8 a 128 caracteres. A senha no corpo do `PATCH` é ignorada: ela só muda por `PUT .../password`, que também encerra as sessões do paciente. E-mail já usado responde `409`.

Quem cria entra na equipe como cirurgião (gatilho do banco). O admin cria sem equipe, ou com `professionalIds` (o primeiro é o cirurgião, os demais são equipe). `PUT .../care-team` substitui a equipe: lista vazia deixa o paciente sem equipe, e então só o admin o vê; um profissional que não existe responde `404`, e um que não é admin responde `403`. `PATCH` e `DELETE` seguem as regras de `If-Match` das medicações (`428`, `400`, `409` com o item atual).

### Profissionais, administradores e status (fase 2, áreas 4 e 5)

Só o **admin** cadastra profissionais e administradores. `POST /api/professionals` e `POST /api/admins` (`{ name, email, password, ... }`, mais `role`, `crmCoren`, `specialty` e `avatar` para o profissional), `PATCH` e `DELETE` em `/:id` com `If-Match` (as mesmas regras `428`, `400` e `409` com o item atual das demais entidades; a migração `019` deu `version` aos administradores) e `PUT /:id/password`. Id, versão e posição são do servidor; e-mail repetido responde `409`; trocar a senha ou apagar a conta encerra as sessões dela.

Apagar um **profissional** leva a equipe dele junto, e os pacientes em que ele era o único membro ficam sem equipe (só o admin os vê). A resposta traz `patientsWithoutTeam` com os ids, para o admin saber a quem atribuir uma equipe. Apagar o **último administrador** responde `409`; um lock serializa duas exclusões simultâneas, que de outro modo passariam as duas.

`PUT /api/patients/:id/status` com `{ status }` (`estavel`, `atencao` ou `critico`) é da equipe com acesso ao paciente (`403` para o paciente, `404` para quem não o vê). Não tem `If-Match`: a equipe e o recálculo do check-in (pela dor e pela temperatura) escrevem o status, e vale o último. Ela **não** registra evento na linha do tempo: o front indexa `timelineKinds[event.type]`, e um tipo novo quebraria a tela; isso fica para a fase 3, junto com o tipo no front. Apagar um paciente agora também encerra as sessões dele.

### Administrador inicial

O primeiro administrador é criado por `app_bootstrap_admin` (migração `014`), uma função `SECURITY DEFINER` chamada com o papel `vivace_api`. Ela só cria quando **não existe nenhum administrador**, de forma atômica (duas chamadas simultâneas não criam duas contas) e nunca altera uma conta existente nem a senha dela. O servidor a chama uma vez na subida e memoiza o sucesso; antes ela rodava a cada login, abrindo uma conexão de dono do banco só para perguntar se já havia admin. A conversão de uma senha antiga em texto plano para `scrypt` passa por `app_set_credential`, o mesmo caminho de escrita das senhas do `PUT`.

### Token, navegador e cabeçalhos de segurança

O token de sessão só vale no cabeçalho `Authorization: Bearer`. `?token=` na URL foi removido de todas as rotas, inclusive `/api/events`: na URL ele ia parar em log de proxy, histórico e `Referer`. Como o `EventSource` não manda cabeçalho, o front lê o stream de eventos com `fetch` (`src/app/sse-parser.ts` interpreta o formato) e reconecta sozinho com espera crescente, de 1 a 30 segundos. Um front antigo, ainda aberto com `EventSource`, recebe `401` no stream e cai na sincronização periódica até ser recarregado.

No navegador, "Lembrar neste dispositivo" vem desmarcado, e só o token vai para o `localStorage`, e apenas quando a pessoa marca essa opção. O prontuário, os cadastros e a marca de alteração pendente ficam em `sessionStorage`: somem quando a aba fecha, e o logout (ou um `401`) apaga tudo na hora, fecha o stream, devolve o estado ao de demonstração do bundle e avisa o servidor com o token para a sessão ser apagada lá também. O cache antigo do `localStorage` é removido na primeira carga. Uma resposta que chega de uma sessão que já não é a atual é ignorada.

Toda resposta da API leva `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` e `Referrer-Policy: no-referrer`. O front na Vercel recebe, pelo `vercel.json`, uma `Content-Security-Policy` (sem script inline nem `eval`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy` e `Permissions-Policy`. A CSP lista a API em `connect-src`, e **a URL da API em `vercel.json` precisa acompanhar `VIVACE_API_URL`**: o `npm run build:vercel` falha com uma mensagem clara quando elas divergem, em vez de publicar um site que o navegador impede de falar com a API. As imagens externas liberadas são as de `images.unsplash.com` e `ui-avatars.com`.

### Limite de tentativas de login

O `POST /api/auth/login` conta as falhas por endereço IP e por conta, separadamente. Ao passar de `VIVACE_LOGIN_MAX_ATTEMPTS` (padrão: 5), a resposta vira `429` com o cabeçalho `Retry-After` e a tentativa seguinte só é aceita depois de `VIVACE_LOGIN_LOCKOUT_MS` (padrão: 15 minutos). As falhas somam dentro de uma janela de `VIVACE_LOGIN_WINDOW_MS` (padrão: 15 minutos) e um login bem-sucedido zera os contadores.

Limitar pela conta impede que a força bruta distribuída por vários endereços passe, mas também permite que alguém tranque o acesso de um usuário legítimo com `VIVACE_LOGIN_MAX_ATTEMPTS` tentativas.

As duas dimensões são independentes, e a diferença é deliberada: trocar de endereço não escapa de um bloqueio por conta, mas um endereço novo começa com a contagem zerada. A chave é `ip:<endereço>` e `conta:<papel>:<id>`, na tabela `login_attempts`. A chave de conta usa a conta **resolvida**, e não o texto digitado: o login casa o paciente por prefixo de e-mail, então `mari`, `maria` e `mariana.souza@email.com` são a mesma conta e dividem as mesmas tentativas. Um identificador que não existe cai na chave `conta:?:<texto>`. O casamento por prefixo trata `%` e `_` como texto literal e só vale quando o prefixo é único (migração `013`).

**Endereço do cliente.** Atrás de um proxy, o `X-Forwarded-For` só é confiável no fim da lista, onde o proxy acrescenta o endereço de quem falou com ele; o começo é escrito pelo cliente. Por isso `VIVACE_TRUST_PROXY_HOPS` diz quantos proxies de confiança existem na frente da API, e o endereço é lido contando essa quantidade da direita. Com `0` (padrão) o cabeçalho é ignorado e vale o endereço do socket. **Na hospedagem (Render) é preciso definir esse valor**, senão todos os usuários aparecem com o mesmo IP do proxy e dividem a mesma cota e o mesmo bloqueio. Identificador acima de 200 caracteres e senha acima de 1024 são recusados com `400`.

Os contadores vivem no Postgres, na tabela `login_attempts`, e não na memória do processo. A consequência prática é que **o bloqueio sobrevive a um reinício da API e vale igual entre réplicas**: com um `Map` em memória, reiniciar o servidor liberava todo mundo, e duas réplicas dividiam a mesma contagem pela metade, de modo que cinco tentativas em cada uma entravam como uma. A contagem é gravada por `app_record_login_failure`, um único `INSERT ... ON CONFLICT` que atualiza as três colunas de uma vez, então requisições simultâneas para a mesma chave se serializam no índice e nenhuma falha se perde.

O prazo é decidido por `now()` no banco, e não pelo relógio do Node, para que o TTL e o bloqueio valham igual em qualquer réplica. As tabelas de sessão e de tentativa **não têm RLS**, e isso é uma decisão consciente: a consulta que descobre quem é o chamador acontece antes de existir sessão, então ainda não há papel para uma policy avaliar. Um RLS aqui exigiria uma policy que liberasse a leitura por token, o que equivale a não ter RLS, com uma camada a mais para manter.

### Sessão

O token de login vira uma linha em `sessions`, com papel, usuário, nome e `expires_at`. A expiração é **absoluta**: `expires_at` é gravado no login e nunca reescrito. Com TTL deslizante, cada requisição autenticada reescrevia o vencimento, e no banco isso seria um `UPDATE` por request — trocando uma leitura em memória por uma escrita no caminho quente. A consequência é que uma sessão que fica em uso não se renova sozinha: depois de 8 horas ela cai, e o usuário entra de novo.

A linha é procurada pelo **hash** do token, e não pelo token. A tabela guarda `token_hash` (sha256) e nunca o valor que o cliente manda no cabeçalho. Sem isso, `sessions` era um cofre de credencial: qualquer leitura da base — `pg_dump`, réplica, backup, injeção em outra tabela — entregava de uma vez todas as sessões válidas das últimas 8 horas, prontas para ser reapresentadas. É o mesmo argumento que levou a senha para `account_credentials` na `006`, e ele só não tinha sido aplicado aqui.

sha256 e não scrypt de propósito: o token tem 256 bits do CSPRNG e não existe dicionário, então não há o que forçar. Um scrypt aqui custaria ~100ms em toda requisição autenticada para proteger algo que não sofre ataque de força bruta.

A verificação de validade está no próprio SQL (`expires_at > now()`), então uma sessão vencida nunca chega a existir para o Node. Apagar as linhas vencidas é tarefa de um varredor periódico, que faz `DELETE` indexado a cada `VIVACE_LOGIN_WINDOW_MS`; nenhuma query de leitura depende de a limpeza ter rodado. `POST /api/auth/logout` apaga a linha, e o token deixa de valer imediatamente, inclusive depois de um restart.

### Limite de requisições

O bloqueio do login não protege o resto da API: um token válido, mesmo vazado, fazia chamadas sem limite. Hoje existe cota **por sessão e por IP**, em janela fixa (`VIVACE_RATE_WINDOW_MS`, padrão 60s), com `VIVACE_RATE_SESSION_MAX` (120) e `VIVACE_RATE_IP_MAX` (300). Estourar devolve `429` com `Retry-After`.

A cota por IP é de propósito bem maior que a de sessão: um consultório inteiro sai por um único endereço NAT, e um teto apertado derrubaria todo mundo atrás do mesmo roteador junto. O risco conhecido é o oposto do bloqueio de login — o limite de IP também é um vetor de negação de serviço, e um atacante atrás do mesmo NAT pode trancar a equipe. É a troca padrão, e o valor é configurável.

A cota por IP vale inclusive para o login, e isso é o que fecha o flood de `scrypt`. O bloqueio por tentativas só conta **falhas**, então um flood de senhas certas — ou de requisições malformadas, que nem chegam a comparar senha — continuaria comprando ~100ms de CPU por requisição sem teto. A checagem roda antes de qualquer trabalho, então um `429` ali custa uma subtração.

O `OPTIONS` do preflight é a única rota que não conta, porque o navegador o manda sozinho e não deve gastar cota de ninguém. Token inválido não gasta cota de sessão, porque a autenticação responde `401` antes de contar; a cota de IP, essa sim, se aplica.

A chave da cota de sessão é o resumo do token apresentado, e não o `userId`: um token descartado e reapresentado recomeça a contagem em vez de deburdenar a sessão que ele finge ser.

**A cota é por processo e não sobrevive a um restart.** Resetar o limite custa o mesmo que reiniciar a API. Um limite distribuído de verdade exigiria uma escrita por requisição, que é exatamente o caminho quente que o TTL absoluto da sessão decidiu não tocar. Para ambiente com mais de um processo, o teto efetivo é o configurado vezes o número de réplicas.

### Origem das requisições

O CORS compara a origem por **string inteira**, com scheme, host e porta. A versão anterior aceitava a porta que quisesse, porque comparava só o hostname: em desenvolvimento isso é inofensivo, e o mesmo código em produção liberaria qualquer porta do domínio real — um atacante que sirva a página em `http://localhost:9999` leria a resposta da API.

A lista é a fonte da verdade e é montada no boot: o frontend nas portas que ele atende, o IP da própria máquina na porta do frontend (é o que faz o check-in no celular funcionar sem configurar origem a cada mudança de rede) e o que vier de `VIVACE_ALLOWED_ORIGINS`. Nada é derivado do cabeçalho `Host` do pedido, porque `Host` é controlado por quem faz a requisição.

### Tempo de resposta do login

A resposta é a mesma (`401`, "Usuário ou senha inválidos") exista ou não a conta, e o servidor gasta o mesmo tempo nos dois casos: quando o usuário não existe, ou quando a senha ainda está em texto plano, roda um `scrypt` de descarte para compensar o `scrypt` que a verificação real não faria. Sem isso, um usuário inexistente responderia em milissegundos e o `scrypt` levaria dezenas, o que permite enumerar quem tem cadastro medindo a latência.

O `429` de bloqueio também gasta um `scrypt` de descarte, pelo mesmo motivo. Ele não responde antes de verificar a senha, e antes da correção respondia em poucos milissegundos, o que denunciava pelo tempo que a conta existe e está bloqueada, desfazendo o que o `scrypt` de descarte existe para impedir. O teste `429 gasta scrypt` mede isso e falha se o `scrypt` voltar a faltar.

## Validar

```bash
npm run lint
npm run build
```

## Escopo

Esta versão é demonstrativa. A API exige autenticação por token, senha com `scrypt` e limite de tentativas por IP e por conta, e o acesso por registro é controlado por RLS no banco. Ainda faltam criptografia em repouso, trilha de auditoria, renovação de token, e as sessões e o rate limit continuam em memória, então um reinício libera todo mundo. Nada disso deve ser usado com dados reais de pacientes.
