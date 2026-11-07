import { pool, closeDatabase } from './index.js';
export const ids = {
  org: '11111111-1111-4111-8111-111111111111',
  project: '22222222-2222-4222-8222-222222222222',
  repo: '33333333-3333-4333-8333-333333333333',
  session: '44444444-4444-4444-8444-444444444444',
  task: '55555555-5555-4555-8555-555555555555',
};
const db = await pool.connect();
try {
  await db.query('BEGIN');
  await db.query('INSERT INTO organizations(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [
    ids.org,
    'Local development',
  ]);
  await db.query(
    "INSERT INTO organization_memberships(org_id,subject,role) VALUES($1,'local-owner','admin') ON CONFLICT DO NOTHING",
    [ids.org],
  );
  await db.query('INSERT INTO projects(id,org_id,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
    ids.project,
    ids.org,
    'Demo project',
  ]);
  await db.query(
    "INSERT INTO memberships(org_id,project_id,subject,permissions) VALUES($1,$2,'local-owner',ARRAY['read','write','coordinate']) ON CONFLICT DO NOTHING",
    [ids.org, ids.project],
  );
  await db.query(
    "INSERT INTO repositories(id,project_id,remote_url) VALUES($1,$2,'https://example.invalid/demo.git') ON CONFLICT DO NOTHING",
    [ids.repo, ids.project],
  );
  await db.query(
    "INSERT INTO sessions(id,project_id,provider,external_session_id,machine_id) VALUES($1,$2,'codex','demo','local') ON CONFLICT DO NOTHING",
    [ids.session, ids.project],
  );
  await db.query(
    "INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Cross-agent context handoff') ON CONFLICT DO NOTHING",
    [ids.task, ids.project],
  );
  await db.query('COMMIT');
  console.log('Demo fixtures ready');
} catch (e) {
  await db.query('ROLLBACK');
  throw e;
} finally {
  db.release();
  await closeDatabase();
}
