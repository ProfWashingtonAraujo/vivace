import pg from 'pg';

const defaultUrl = 'postgres://vivace_api:vivace@127.0.0.1:55432/vivace';
const migrationUrl = 'postgres://vivace:vivace@127.0.0.1:55432/vivace';

export const apiUrl = () => process.env.DATABASE_URL ?? defaultUrl;
export const migrationUrlOf = () => process.env.MIGRATION_DATABASE_URL ?? migrationUrl;

// O papel da aplicacao. Precisa ser vivace_api e nao o dono: policies de RLS
// nao se aplicam ao dono da tabela, entao conectar como dono testaria um
// caminho que nunca sera o de producao.
export const createPool = (connectionString = apiUrl()) => new pg.Pool({ connectionString, max: 5 });

// Tarefas administrativas (import, migracoes) precisam de privilegio de dono
// para TRUNCATE e CREATE. Continuam sob um contexto admin explicito, porque com
// FORCE ROW LEVEL SECURITY as policies valem inclusive para o dono.
export const createMigrationPool = () => new pg.Pool({ connectionString: migrationUrlOf(), max: 2 });

// A identidade viaja em GUCs locais a transacao. Precisa ser BEGIN/set_config/
// COMMIT no mesmo client: se a transacao fechar antes do set_config, ou se o
// client voltar ao pool no meio, o estado vaza para a proxima requisicao.
export const withSession = async (pool, session, action) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.role', session.role ?? '']);
    await client.query('SELECT set_config($1, $2, true)', ['app.user_id', session.userId ?? '']);
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

export const asAdmin = (pool, action) => withSession(pool, { role: 'admin', userId: 'adm-1' }, action);
