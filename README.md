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

Requer Node.js 20.19 ou superior.

```bash
npm install
npm run dev
```

A aplicação estará disponível em `http://localhost:3000`. Outros dispositivos na mesma rede podem acessar pelo IP do computador, por exemplo `http://192.168.0.4:3000`.

O comando também inicia a API de persistência na porta `3001`. Os dados compartilhados ficam em `.data/` no computador que executa a aplicação.

## Validar

```bash
npm run lint
npm run build
```

## Escopo

Esta versão é demonstrativa. Autenticação, criptografia, notificações e armazenamento clínico em servidor ainda precisam ser implementados antes de qualquer uso com dados reais de pacientes.
