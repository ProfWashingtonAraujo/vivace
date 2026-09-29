# VIVACE

Plataforma Angular para acompanhamento pós-operatório, com experiências separadas para equipe profissional, paciente e administração.

## Tecnologias

- Angular 21 com componentes standalone e Signals
- Angular Aria para abas e acordeões acessíveis
- Signal Forms no formulário de login
- Highcharts Angular para evolução de dor e temperatura
- TypeScript em modo estrito
- Tailwind CSS 4
- Persistência demonstrativa compartilhada na rede local, com contingência em `localStorage`

## Funcionalidades

- Painel profissional com triagem, alertas e prontuário clínico
- Portal do paciente com check-in, medicamentos, mensagens e envio de fotos
- Painel administrativo com CRUD de profissionais e pacientes
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

Verifique se as portas estão livres antes de iniciar:

```bash
ss -tln | grep -E ':(3000|3001)'
```

Se a `VIVACE_API_PORT` estiver ocupada por outro servidor, o check-in no celular vai exibir "não foi sincronizado": o frontend cai no servidor alheio, que responde 404 em `/api/state`, e o salvamento é descartado. Use outra porta em `VIVACE_API_PORT`.

## Validar

```bash
npm run lint
npm run build
```

## Escopo

Esta versão é demonstrativa. Autenticação, criptografia, notificações e armazenamento clínico em servidor ainda precisam ser implementados antes de qualquer uso com dados reais de pacientes.
