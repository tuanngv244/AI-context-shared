import type pg from 'pg';
export async function processEvent(db: pg.PoolClient, id: string) {
  // Project lock precedes row locks, consistently with gateway writers.
  const meta = (await db.query('SELECT project_id FROM outbox_events WHERE id=$1', [id])).rows[0];
  if (!meta) return;
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [meta.project_id]);
  const row = (await db.query('SELECT * FROM outbox_events WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (row.processed_at) return;
  if (row.event_type === 'code.changed' && row.repo_id) {
    const changed = await db.query(
      "UPDATE context_records SET status='stale' WHERE project_id=$1 AND repo_id=$2 AND branch=$3 AND status IN ('proposed','verified_on_branch') RETURNING id",
      [row.project_id, row.repo_id, row.payload.payload?.branch],
    );
    if (changed.rows.length) {
      const payload = JSON.stringify({
        recordIds: changed.rows.map((r) => r.id),
        reason: 'code.changed',
        branch: row.payload.payload?.branch,
      });
      const event = (
        await db.query(
          "INSERT INTO context_events(project_id,repo_id,event_type,idempotency_key,payload) VALUES($1,$2,'context.stale',$3,$4) ON CONFLICT(project_id,idempotency_key) DO NOTHING RETURNING id",
          [row.project_id, row.repo_id, `worker:stale:${row.id}`, payload],
        )
      ).rows[0];
      if (event)
        await db.query(
          "INSERT INTO outbox_events(project_id,repo_id,event_id,event_type,payload) VALUES($1,$2,$3,'context.stale',$4)",
          [row.project_id, row.repo_id, event.id, payload],
        );
    }
  }
  // Code/CI text from a normal client never promotes a claim to verified.
  await db.query('UPDATE outbox_events SET processed_at=now() WHERE id=$1', [row.id]);
}
