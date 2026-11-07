import type pg from 'pg';
/** Memory limits are per repo; durable decisions/contracts are deliberately not deleted here. */
export async function pruneMemory(db: pg.PoolClient, repoId: string) {
  return Number(
    (await db.query('SELECT sce_prune_memories($1) AS removed', [repoId])).rows[0].removed,
  );
}
export async function runRetention(pool: pg.Pool) {
  const totals = { memories: 0, outbox: 0, events: 0, audits: 0, sessions: 0 };
  const repos = (
    await pool.query(
      'SELECT repo_id,project_id FROM repository_watches ORDER BY last_retention_at NULLS FIRST LIMIT 100',
    )
  ).rows;
  for (const repo of repos) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const locked = (
        await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked', [
          repo.project_id,
        ])
      ).rows[0].locked;
      if (locked) totals.memories += await pruneMemory(db, repo.repo_id);
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  }
  // Process bounded batches per project. Only processed outbox rows are eligible; pending jobs are durable.
  const projects = (await pool.query('SELECT id FROM projects ORDER BY id')).rows;
  for (const project of projects) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const locked = (
        await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked', [
          project.id,
        ])
      ).rows[0].locked;
      if (!locked) {
        await db.query('COMMIT');
        continue;
      }
      const deleted = (
        await db.query(
          `WITH candidates AS (
      SELECT id FROM (SELECT id,created_at,row_number() OVER(ORDER BY id DESC) AS position FROM outbox_events WHERE project_id=$1 AND processed_at IS NOT NULL) ranked WHERE created_at<now()-interval '30 days' OR position>100000 ORDER BY id LIMIT 5000
    ) DELETE FROM outbox_events o USING candidates c WHERE o.id=c.id RETURNING o.id`,
          [project.id],
        )
      ).rows;
      totals.outbox += deleted.length;
      if (deleted.length) {
        const floor = deleted
          .reduce((n, row) => (BigInt(row.id) > n ? BigInt(row.id) : n), 0n)
          .toString();
        await db.query(
          `INSERT INTO delta_retention_floors(project_id,cursor) VALUES($1,$2)
    ON CONFLICT(project_id) DO UPDATE SET cursor=GREATEST(delta_retention_floors.cursor,EXCLUDED.cursor),updated_at=now()`,
          [project.id, floor],
        );
      }
      totals.events +=
        (
          await db.query(
            `DELETE FROM context_events e WHERE e.id IN (
    SELECT c.id FROM context_events c WHERE c.project_id=$1 AND c.created_at<now()-interval '30 days'
    AND NOT EXISTS(SELECT 1 FROM outbox_events o WHERE o.event_id=c.id)
    AND NOT EXISTS(SELECT 1 FROM context_records r WHERE r.id=c.id)
    AND NOT EXISTS(SELECT 1 FROM handoffs h WHERE h.id=c.id)
    ORDER BY c.created_at LIMIT 5000)`,
            [project.id],
          )
        ).rowCount ?? 0;
      totals.audits +=
        (
          await db.query(
            `DELETE FROM audit_logs WHERE id IN (
    SELECT id FROM (SELECT id,created_at,row_number() OVER(ORDER BY created_at DESC,id DESC) AS position
      FROM audit_logs WHERE project_id=$1) ranked WHERE created_at<now()-interval '30 days' OR position>100000 ORDER BY id LIMIT 5000)`,
            [project.id],
          )
        ).rowCount ?? 0;
      await db.query(
        "DELETE FROM task_leases WHERE project_id=$1 AND expires_at<now()-interval '30 days'",
        [project.id],
      );
      const orphaned = (
        await db.query(
          `SELECT s.id FROM sessions s WHERE s.project_id=$1 AND s.last_seen_at<now()-interval '30 days'
    AND NOT EXISTS(SELECT 1 FROM session_memories m WHERE m.session_id=s.id)
    AND NOT EXISTS(SELECT 1 FROM context_records r WHERE r.session_id=s.id)
    AND NOT EXISTS(SELECT 1 FROM context_events e WHERE e.session_id=s.id)
    AND NOT EXISTS(SELECT 1 FROM handoffs h WHERE h.session_id=s.id)
    AND NOT EXISTS(SELECT 1 FROM task_leases l WHERE l.session_id=s.id) LIMIT 1000`,
          [project.id],
        )
      ).rows.map((r) => r.id);
      if (orphaned.length) {
        await db.query('DELETE FROM session_repositories WHERE session_id=ANY($1::uuid[])', [
          orphaned,
        ]);
        totals.sessions +=
          (await db.query('DELETE FROM sessions WHERE id=ANY($1::uuid[])', [orphaned])).rowCount ??
          0;
      }
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  }
  return totals;
}
export function retentionScheduler(pool: pg.Pool, intervalMs = 60000, localVacuum = false) {
  let lastRun = 0,
    lastVacuum = 0;
  return async () => {
    if (Date.now() - lastRun < intervalMs) return;
    const totals = await runRetention(pool);
    lastRun = Date.now();
    if (localVacuum && Date.now() - lastVacuum > 3600000) {
      await pool.query(
        'VACUUM (ANALYZE) session_memories,context_events,outbox_events,audit_logs,sessions,session_repositories,task_leases',
      );
      lastVacuum = Date.now();
    }
    return totals;
  };
}
