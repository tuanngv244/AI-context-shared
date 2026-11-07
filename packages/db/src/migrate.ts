import { readFile, readdir } from 'node:fs/promises';
import { pool, closeDatabase } from './index.js';
const db = await pool.connect();
try {
  await db.query('SELECT pg_advisory_lock(736233)');
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const name of (await readdir('packages/db/migrations'))
    .filter((x) => x.endsWith('.sql'))
    .sort()) {
    if ((await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount)
      continue;
    await db.query('BEGIN');
    try {
      let sql = await readFile(`packages/db/migrations/${name}`, 'utf8');
      if (process.env.SCE_LOCAL_DB)
        sql = sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '');
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      await db.query('COMMIT');
      console.log(`Applied ${name}`);
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  }
  const password = process.env.SCE_RUNTIME_PASSWORD;
  if (password) {
    if (password.length < 24)
      throw new Error('SCE_RUNTIME_PASSWORD must contain at least 24 characters');
    const literal = "'" + password.replaceAll("'", "''") + "'";
    await db.query(
      "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='sce_runtime') THEN CREATE ROLE sce_runtime LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$",
    );
    await db.query('ALTER ROLE sce_runtime PASSWORD ' + literal);
    await db.query('GRANT sce_app TO sce_runtime');
  }
  const workerPassword = process.env.SCE_WORKER_PASSWORD;
  if (workerPassword) {
    if (workerPassword.length < 24)
      throw new Error('SCE_WORKER_PASSWORD must contain at least 24 characters');
    const literal = "'" + workerPassword.replaceAll("'", "''") + "'";
    await db.query(
      "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='sce_worker') THEN CREATE ROLE sce_worker LOGIN NOSUPERUSER BYPASSRLS; END IF; END $$",
    );
    await db.query('ALTER ROLE sce_worker PASSWORD ' + literal);
    await db.query('GRANT USAGE ON SCHEMA public TO sce_worker');
    await db.query('GRANT sce_retention TO sce_worker');
    await db.query(
      'GRANT SELECT ON projects,repository_watches,context_records,handoffs TO sce_worker',
    );
    await db.query(
      'GRANT SELECT,DELETE ON session_memories,context_events,outbox_events,audit_logs,sessions,session_repositories,task_leases TO sce_worker',
    );
    await db.query('GRANT SELECT,INSERT,UPDATE ON delta_retention_floors TO sce_worker');
    await db.query(
      'GRANT SELECT,INSERT,UPDATE ON context_events,context_records,outbox_events TO sce_worker',
    );
    await db.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO sce_worker');
  }
} finally {
  await db.query('SELECT pg_advisory_unlock(736233)');
  db.release();
  await closeDatabase();
}
