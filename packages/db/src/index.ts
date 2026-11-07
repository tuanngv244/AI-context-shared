import pg from 'pg';
import type { Principal } from '../../contracts/src/index.js';
const localDatabase = process.env.SCE_LOCAL_DB
  ? new (await import('@electric-sql/pglite')).PGlite(process.env.SCE_LOCAL_DB, {
      extensions: { vector: (await import('@electric-sql/pglite-pgvector')).vector },
    })
  : undefined;
const config = localDatabase
  ? {
      ...(await import('@electric-sql/pglite/node-postgres')).createPgConfig(localDatabase),
      max: 1,
    }
  : { connectionString: process.env.DATABASE_URL, max: 15 };
export const pool = new pg.Pool(config);
export async function closeDatabase() {
  await pool.end();
  await localDatabase?.close();
}
export async function transaction<T>(
  principal: Principal,
  fn: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE sce_app');
    await db.query("SELECT set_config('sce.org_id',$1,true),set_config('sce.subject',$2,true)", [
      principal.orgId,
      principal.subject,
    ]);
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
