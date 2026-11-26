-- Versao dos administradores, como as demais entidades que a equipe edita (016).
-- Editar e apagar um administrador passam a exigir a versao lida (If-Match). O gatilho de
-- versao e o mesmo: so sobe quando o conteudo muda, ignorando `position`.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

DROP TRIGGER IF EXISTS zz_admins_bump_version ON admins;
CREATE TRIGGER zz_admins_bump_version BEFORE UPDATE ON admins
  FOR EACH ROW EXECUTE FUNCTION app_bump_version();
DROP TRIGGER IF EXISTS zz_admins_start_version ON admins;
CREATE TRIGGER zz_admins_start_version BEFORE INSERT ON admins
  FOR EACH ROW EXECUTE FUNCTION app_start_version();
