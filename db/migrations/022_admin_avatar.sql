-- Foto do administrador, como a do profissional: '' (sem foto), https curto ou imagem em
-- data URL. A validacao e do servidor (lib/people.mjs). Entra no conteudo versionado.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS avatar text NOT NULL DEFAULT '';
