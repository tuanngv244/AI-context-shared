import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  toolSchemas,
  eventSchema,
  type Principal,
  type ToolName,
} from '../../contracts/src/index.js';
import { AccessError, redact, requirePermission } from '../../security/src/index.js';
import { transaction } from '../../db/src/index.js';
import { WorkspaceService } from '../../workspace/src/service.js';
import { memorySchemas, type MemoryToolName } from '../../workspace/src/contracts.js';
export type Tx = <T>(p: Principal, fn: (db: pg.PoolClient) => Promise<T>) => Promise<T>;
export function branchCompatible(
  record: {
    repo_id?: string | null;
    branch?: string | null;
    status: string;
    commit_sha?: string | null;
  },
  branch: string,
  sha?: string,
) {
  return (
    !record.repo_id ||
    (record.branch === branch && (!sha || !record.commit_sha || record.commit_sha === sha))
  );
}
export function pack(items: any[], budget: number) {
  let used = 0;
  const selected = [];
  for (const item of items) {
    const cost = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (used + cost > budget) continue;
    used += cost;
    selected.push(item);
  }
  return { items: selected, truncated: selected.length < items.length };
}
export class Engine {
  workspace: WorkspaceService;
  constructor(private tx: Tx = transaction) {
    this.workspace = new WorkspaceService(tx);
  }
  async authorize(db: pg.PoolClient, p: Principal, projectId: string, permission: string) {
    requirePermission(p, permission);
    const m = (
      await db.query(
        'SELECT permissions,repo_ids FROM memberships WHERE project_id=$1 AND org_id=$2 AND subject=$3',
        [projectId, p.orgId, p.subject],
      )
    ).rows[0];
    if (!m?.permissions.includes(permission)) throw new AccessError();
    return m as { permissions: string[]; repo_ids: string[] | null };
  }
  async repository(db: pg.PoolClient, projectId: string, id: string) {
    if (
      !(
        await db.query('SELECT id FROM repositories WHERE project_id=$1 AND id=$2', [projectId, id])
      ).rowCount
    )
      throw new AccessError();
  }
  async reference(db: pg.PoolClient, table: 'sessions' | 'tasks', projectId: string, id?: string) {
    if (
      id &&
      !(await db.query(`SELECT id FROM ${table} WHERE project_id=$1 AND id=$2`, [projectId, id]))
        .rowCount
    )
      throw new AccessError();
  }
  async event(db: pg.PoolClient, input: any, eventType: string, payload: any) {
    // Serialize writers within each project so committed cursor order cannot skip a slow transaction.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [input.projectId]);
    const previous = (
      await db.query(
        'SELECT id,event_type,payload FROM context_events WHERE project_id=$1 AND idempotency_key=$2',
        [input.projectId, input.idempotencyKey],
      )
    ).rows[0];
    if (previous) {
      if (
        previous.event_type !== eventType ||
        JSON.stringify(previous.payload) !== JSON.stringify(payload)
      ) {
        // jsonb key order differs; compare canonical JSON inside PostgreSQL.
        const same = (
          await db.query(
            'SELECT payload=$3::jsonb AS same FROM context_events WHERE project_id=$1 AND idempotency_key=$2',
            [input.projectId, input.idempotencyKey, JSON.stringify(payload)],
          )
        ).rows[0]?.same;
        if (previous.event_type !== eventType || !same)
          throw Object.assign(new Error('Idempotency key reused with different payload'), {
            statusCode: 409,
          });
      }
      return { id: previous.id, duplicate: true };
    }
    const event = (
      await db.query(
        'INSERT INTO context_events(project_id,repo_id,session_id,event_type,idempotency_key,payload) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
        [
          input.projectId,
          input.repoId ?? null,
          input.sessionId ?? null,
          eventType,
          input.idempotencyKey,
          JSON.stringify(payload),
        ],
      )
    ).rows[0];
    await db.query(
      'INSERT INTO outbox_events(project_id,repo_id,event_id,event_type,payload) VALUES($1,$2,$3,$4,$5)',
      [input.projectId, input.repoId ?? null, event.id, eventType, JSON.stringify(payload)],
    );
    return { ...event, duplicate: false };
  }
  async ingest(p: Principal, raw: unknown) {
    const x = redact(eventSchema.parse(raw));
    return this.tx(p, async (db) => {
      const m = await this.authorize(db, p, x.projectId, 'write');
      if (x.repoId) await this.repository(db, x.projectId, x.repoId);
      else if (m.repo_ids !== null) throw new AccessError();
      await this.reference(db, 'sessions', x.projectId, x.sessionId);
      const e = await this.event(db, x, x.eventType, x);
      if (!e.duplicate && x.eventType === 'session.started') {
        if (!x.payload.provider || !x.payload.externalSessionId || !x.payload.machineId)
          throw Object.assign(new Error('Session identity required'), { statusCode: 400 });
        const s = (
          await db.query(
            "INSERT INTO sessions(project_id,provider,external_session_id,machine_id) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,provider,machine_id,external_session_id) DO UPDATE SET last_seen_at=now(),status='active' RETURNING id",
            [x.projectId, x.payload.provider, x.payload.externalSessionId, x.payload.machineId],
          )
        ).rows[0];
        if (x.repoId && x.payload.branch)
          await db.query(
            'INSERT INTO session_repositories(project_id,session_id,repo_id,branch,head_sha) VALUES($1,$2,$3,$4,$5) ON CONFLICT(session_id,repo_id) DO UPDATE SET branch=EXCLUDED.branch,head_sha=EXCLUDED.head_sha',
            [x.projectId, s.id, x.repoId, x.payload.branch, x.payload.headSha ?? null],
          );
      }
      if (
        !e.duplicate &&
        x.payload.provider &&
        x.payload.externalSessionId &&
        x.payload.machineId
      ) {
        await db.query(
          'UPDATE sessions SET last_seen_at=now(),status=$5 WHERE project_id=$1 AND provider=$2 AND external_session_id=$3 AND machine_id=$4',
          [
            x.projectId,
            x.payload.provider,
            x.payload.externalSessionId,
            x.payload.machineId,
            x.eventType === 'session.ended' ? 'ended' : 'active',
          ],
        );
      }
      if (!e.duplicate && x.sessionId)
        await db.query(
          'UPDATE sessions SET last_seen_at=now(),status=$3 WHERE project_id=$1 AND id=$2',
          [x.projectId, x.sessionId, x.eventType === 'session.ended' ? 'ended' : 'active'],
        );
      await this.audit(db, p, x.projectId, 'event.ingest');
      return e;
    });
  }
  async audit(db: pg.PoolClient, p: Principal, projectId: string, action: string) {
    await db.query('INSERT INTO audit_logs(project_id,subject,action) VALUES($1,$2,$3)', [
      projectId,
      p.subject,
      action,
    ]);
  }
  async call(p: Principal, name: ToolName, raw: unknown): Promise<any> {
    if (Object.hasOwn(memorySchemas, name))
      return this.workspace.call(p, name as MemoryToolName, raw);
    const x: any = redact(toolSchemas[name].parse(raw));
    return this.tx(p, async (db) => {
      const permission =
        name === 'context_claim_task'
          ? 'coordinate'
          : ['context_publish', 'context_handoff', 'context_ack_changes'].includes(name)
            ? 'write'
            : 'read';
      const m = await this.authorize(db, p, x.projectId, permission);
      for (const id of x.repositoryIds ?? []) await this.repository(db, x.projectId, id);
      if (x.repoId) await this.repository(db, x.projectId, x.repoId);
      await this.reference(db, 'sessions', x.projectId, x.sessionId);
      await this.reference(db, 'tasks', x.projectId, x.taskId);
      if (
        m.repo_ids !== null &&
        (['context_handoff', 'context_get_task', 'context_claim_task'].includes(name) ||
          (name === 'context_publish' && !x.repoId))
      )
        throw new AccessError();
      await this.audit(db, p, x.projectId, name);
      if (name === 'context_publish') {
        const e = await this.event(db, x, 'context.proposed', x);
        if (e.duplicate) return { eventId: e.id, duplicate: true };
        const r = (
          await db.query(
            'INSERT INTO context_records(id,project_id,repo_id,session_id,task_id,kind,content,branch,commit_sha,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
            [
              e.id,
              x.projectId,
              x.repoId ?? null,
              x.sessionId ?? null,
              x.taskId ?? null,
              x.kind,
              x.content,
              x.branch ?? null,
              x.commitSha ?? null,
              JSON.stringify(x.evidence),
            ],
          )
        ).rows[0];
        return r;
      }
      if (name === 'context_handoff') {
        const e = await this.event(db, x, 'handoff.created', x);
        if (e.duplicate) return { id: e.id, duplicate: true };
        return (
          await db.query(
            'INSERT INTO handoffs(id,project_id,task_id,session_id,summary,pending_work,blockers) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [
              e.id,
              x.projectId,
              x.taskId,
              x.sessionId,
              x.summary,
              JSON.stringify(x.pendingWork),
              JSON.stringify(x.blockers),
            ],
          )
        ).rows[0];
      }
      if (name === 'context_get_task')
        return {
          task: (
            await db.query('SELECT * FROM tasks WHERE project_id=$1 AND id=$2', [
              x.projectId,
              x.taskId,
            ])
          ).rows[0],
          handoffs: (
            await db.query(
              'SELECT * FROM handoffs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 50',
              [x.projectId, x.taskId],
            )
          ).rows,
          leases: (
            await db.query(
              'SELECT * FROM task_leases WHERE project_id=$1 AND task_id=$2 AND expires_at>now()',
              [x.projectId, x.taskId],
            )
          ).rows,
        };
      if (name === 'context_claim_task') {
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [x.projectId]);
        const conflicts = (
          await db.query(
            'SELECT * FROM task_leases WHERE project_id=$1 AND repo_id=$2 AND session_id<>$3 AND expires_at>now()',
            [x.projectId, x.repoId, x.sessionId],
          )
        ).rows.filter((lease: any) =>
          lease.resources.some((a: string) =>
            x.resources.some(
              (b: string) =>
                a === b ||
                a.startsWith(b.replace(/\/$/, '') + '/') ||
                b.startsWith(a.replace(/\/$/, '') + '/'),
            ),
          ),
        );
        const lease = (
          await db.query(
            "INSERT INTO task_leases(project_id,task_id,session_id,repo_id,owner,branch,resources,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8::int*interval '1 second') ON CONFLICT(task_id,session_id) DO UPDATE SET resources=EXCLUDED.resources,branch=EXCLUDED.branch,repo_id=EXCLUDED.repo_id,expires_at=EXCLUDED.expires_at RETURNING *",
            [
              x.projectId,
              x.taskId,
              x.sessionId,
              x.repoId,
              p.subject,
              x.branch,
              x.resources,
              x.ttlSeconds,
            ],
          )
        ).rows[0];
        await this.event(db, { ...x, idempotencyKey: randomUUID() }, 'task.updated', {
          taskId: x.taskId,
          leaseId: lease.id,
        });
        return { lease, conflicts, advisory: true };
      }
      const repoIds = x.repositoryIds?.length ? x.repositoryIds : (m.repo_ids ?? null);
      const scopeHash = createHash('sha256')
        .update(
          JSON.stringify([
            x.projectId,
            repoIds?.slice().sort() ?? null,
            x.branch,
            x.headSha ?? null,
          ]),
        )
        .digest('hex');
      const retentionFloor =
        (
          await db.query('SELECT cursor::text FROM delta_retention_floors WHERE project_id=$1', [
            x.projectId,
          ])
        ).rows[0]?.cursor ?? '0';
      const cursor = (
        await db.query(
          'SELECT GREATEST(COALESCE(max(id),0),$3::bigint)::text AS cursor FROM outbox_events WHERE project_id=$1 AND (repo_id IS NULL OR $2::uuid[] IS NULL OR repo_id=ANY($2))',
          [x.projectId, repoIds, retentionFloor],
        )
      ).rows[0].cursor;
      if (
        ['context_get_changes', 'context_ack_changes'].includes(name) &&
        x.cursor !== '0' &&
        BigInt(x.cursor) < BigInt(retentionFloor)
      )
        throw Object.assign(
          new Error(
            'Cursor expired by retention. Reload context with context_bootstrap or context_recall before resuming delta sync.',
          ),
          { statusCode: 410 },
        );
      if (name === 'context_ack_changes') {
        if (BigInt(x.cursor) > BigInt(cursor))
          throw Object.assign(new Error('Cursor exceeds visible log'), { statusCode: 400 });
        await db.query(
          'INSERT INTO delta_cursors(project_id,subject,scope_hash,cursor) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,subject,scope_hash) DO UPDATE SET cursor=GREATEST(delta_cursors.cursor,EXCLUDED.cursor)',
          [x.projectId, p.subject, scopeHash, x.cursor],
        );
        return { cursor: x.cursor };
      }
      if (name === 'context_get_changes') {
        const rows = (
          await db.query(
            'SELECT id::text AS cursor,event_type,repo_id,created_at FROM outbox_events WHERE project_id=$1 AND id>$2 AND (repo_id IS NULL OR $3::uuid[] IS NULL OR repo_id=ANY($3)) ORDER BY id LIMIT $4',
            [
              x.projectId,
              BigInt(x.cursor) < BigInt(retentionFloor) ? retentionFloor : x.cursor,
              repoIds,
              x.limit,
            ],
          )
        ).rows;
        return {
          changes: rows,
          cursor:
            rows.at(-1)?.cursor ??
            (BigInt(x.cursor) < BigInt(retentionFloor) ? retentionFloor : x.cursor),
          retentionFloor,
          resyncRequired: x.cursor === '0' && retentionFloor !== '0',
          hasMore: rows.length === x.limit,
          scopeHash,
        };
      }
      const rows = (
        await db.query(
          `SELECT id,project_id,repo_id,session_id,task_id,kind,content,status,branch,commit_sha,evidence,version,created_at FROM context_records WHERE project_id=$1 AND (repo_id IS NULL OR $2::uuid[] IS NULL OR repo_id=ANY($2)) AND (repo_id IS NULL OR branch=$3) AND (superseded_by IS NULL) AND (valid_to IS NULL OR valid_to>now()) AND ($4::text IS NULL OR commit_sha IS NULL OR commit_sha=$4) AND ($5::uuid IS NULL OR id=$5) AND ($6::text='' OR search_document @@ plainto_tsquery('simple',$6)) ORDER BY created_at DESC LIMIT $7`,
          [
            x.projectId,
            repoIds,
            x.branch,
            x.headSha ?? null,
            x.id ?? null,
            x.query ?? '',
            x.limit ?? 100,
          ],
        )
      ).rows;
      if (name === 'context_get') {
        if (!rows[0])
          throw Object.assign(new Error('Record unavailable in scope'), { statusCode: 404 });
        return { ...rows[0], untrusted: true };
      }
      if (name === 'context_search') return { items: rows, cursor, untrusted: true };
      let candidates = rows;
      if (x.taskId && m.repo_ids === null) {
        const handoffs = (
          await db.query(
            'SELECT id,summary AS content,pending_work,blockers,session_id,created_at FROM handoffs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 5',
            [x.projectId, x.taskId],
          )
        ).rows;
        candidates = [
          ...handoffs.map((h) => ({ ...h, kind: 'handoff', task_id: x.taskId })),
          ...rows,
        ];
      }
      const packed = pack(candidates, x.tokenBudget - 80);
      const sections: { [key: string]: any[] } = {
        architecture: [],
        decisions: [],
        activeTasks: [],
        relatedChanges: [],
        warnings: [],
      };
      for (const item of packed.items) {
        const key =
          item.kind === 'handoff'
            ? 'activeTasks'
            : ['convention', 'fact'].includes(item.kind)
              ? 'architecture'
              : item.kind === 'decision'
                ? 'decisions'
                : 'relatedChanges';
        sections[key].push({ ...item, untrusted: true });
      }
      return {
        snapshotId: randomUUID(),
        cursor,
        generatedAt: new Date().toISOString(),
        scope: {
          projectId: x.projectId,
          repositories: repoIds ?? [],
          branch: x.branch,
          headSha: x.headSha,
        },
        sections,
        truncated: packed.truncated,
        budgetMethod: 'UTF-8 bytes, conservative bound on content tokens',
        untrusted: true,
      };
    });
  }
  async dashboard(p: Principal, projectId: string) {
    return this.tx(p, async (db) => {
      const m = await this.authorize(db, p, projectId, 'read');
      if (m.repo_ids !== null) throw new AccessError();
      await this.audit(db, p, projectId, 'dashboard.read');
      const result: any = {};
      for (const table of [
        'sessions',
        'tasks',
        'context_records',
        'handoffs',
        'task_leases',
        'audit_logs',
      ])
        result[table] = (
          await db.query(`SELECT * FROM ${table} WHERE project_id=$1 LIMIT 100`, [projectId])
        ).rows;
      result.memories = (
        await db.query(
          'SELECT sm.id,sm.summary,sm.pending_work,sm.blockers,sm.branch,sm.commit_sha,sm.occurred_at,s.provider FROM session_memories sm JOIN sessions s ON s.id=sm.session_id WHERE sm.project_id=$1 ORDER BY sm.occurred_at DESC LIMIT 100',
          [projectId],
        )
      ).rows;
      result.events = (
        await db.query(
          'SELECT id,event_type,created_at FROM context_events WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',
          [projectId],
        )
      ).rows;
      result.processing = (
        await db.query(
          'SELECT count(*) FILTER(WHERE processed_at IS NULL)::int AS pending,EXTRACT(EPOCH FROM now()-min(created_at) FILTER(WHERE processed_at IS NULL)) AS lag_seconds FROM outbox_events WHERE project_id=$1',
          [projectId],
        )
      ).rows[0];
      return result;
    });
  }
}
