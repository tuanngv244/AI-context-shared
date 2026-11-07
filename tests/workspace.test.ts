import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFile,
  mkdtemp,
  writeFile,
  mkdir,
  appendFile,
  symlink,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import pg from 'pg';
import { createPgConfig } from '@electric-sql/pglite/node-postgres';
import { WorkspaceService, memoryInstructions } from '../packages/workspace/src/service.js';
import { Engine, type Tx } from '../packages/core/src/index.js';
import { SessionObserver } from '../packages/observer/src/index.js';
import { RepositoryResolver } from '../packages/observer/src/repositories.js';
import { assistantSummary } from '../packages/observer/src/parser.js';
import type { Principal } from '../packages/contracts/src/index.js';
const org = '11111111-1111-4111-8111-111111111111',
  otherOrg = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const owner: Principal = {
  orgId: org,
  subject: 'owner',
  permissions: ['read', 'write', 'coordinate', 'manage'],
};
let db: PGlite,
  pool: pg.Pool,
  workspace: WorkspaceService,
  engine: Engine,
  root: string,
  repoA: any,
  repoB: any;
const tx: Tx = async (p, fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sce_app');
    await client.query(
      "SELECT set_config('sce.org_id',$1,true),set_config('sce.subject',$2,true)",
      [p.orgId, p.subject],
    );
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};
before(async () => {
  db = new PGlite({ extensions: { vector } });
  pool = new pg.Pool({ ...createPgConfig(db), max: 1 });
  for (const name of [
    '001_initial.sql',
    '002_workspace_memory.sql',
    '003_retention.sql',
    '004_manual_history_cleanup.sql',
  ])
    await db.exec(
      (await readFile('packages/db/migrations/' + name, 'utf8')).replace(
        'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
        '',
      ),
    );
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Local'),($2,'Other')", [
    org,
    otherOrg,
  ]);
  await pool.query(
    "INSERT INTO organization_memberships(org_id,subject,role) VALUES($1,'owner','admin'),($2,'other','admin')",
    [org, otherOrg],
  );
  root = await realpath(await mkdtemp(resolve(tmpdir(), 'sce-memory-')));
  workspace = new WorkspaceService(tx);
  engine = new Engine(tx);
  repoA = await workspace.register(
    owner,
    {
      name: 'project-A',
      remoteUrl: 'https://example.invalid/A',
      localPath: resolve(root, 'project-A'),
      defaultBranch: 'main',
    },
    30,
  );
  repoB = await workspace.register(
    owner,
    {
      name: 'project-B',
      remoteUrl: 'https://example.invalid/B',
      localPath: resolve(root, 'project-B'),
      defaultBranch: 'main',
    },
    30,
  );
  await mkdir(resolve(root, 'project-A'));
  await mkdir(resolve(root, 'project-B'));
});
after(async () => {
  await pool?.end();
  await db?.close();
});
test('registers repositories with automatic project and membership, duplicate add is idempotent', async () => {
  const duplicate = await workspace.register(
    owner,
    {
      name: 'project-A',
      remoteUrl: 'https://example.invalid/A',
      localPath: resolve(root, 'project-A'),
      defaultBranch: 'main',
    },
    30,
  );
  assert.equal(duplicate.repo_id, repoA.repo_id);
  const list = await workspace.catalog(owner);
  assert.equal(list.length, 2);
  assert.ok(list.every((r) => r.memory_count === 0));
  await assert.rejects(
    () =>
      workspace.register(
        { ...owner, permissions: ['read'] },
        { name: 'bad', remoteUrl: 'x', localPath: null, defaultBranch: 'main' },
        30,
      ),
    /Access denied/,
  );
  await assert.rejects(
    () =>
      workspace.register(
        { ...owner, subject: 'stranger' },
        { name: 'bad', remoteUrl: 'x', localPath: null, defaultBranch: 'main' },
        30,
      ),
    /Access denied/,
  );
});
const checkpoint = {
  repository: 'project-A',
  provider: 'codex',
  externalSessionId: 'codex-one',
  summary: 'Implemented refresh cookie validation; tests pending',
  branch: 'feat/auth',
  pendingWork: ['Add refresh tests'],
  idempotencyKey: 'memory-1',
};
test('Codex and Claude share history by name/cwd without IDs; another project can recall A', async () => {
  await engine.call(owner, 'context_checkpoint', checkpoint);
  await engine.call(owner, 'context_checkpoint', {
    ...checkpoint,
    provider: 'claude',
    externalSessionId: 'claude-two',
    summary: 'Reviewed cookie contract; domain remains unresolved',
    blockers: ['Confirm cookie domain'],
    idempotencyKey: 'memory-2',
  });
  const recall = await engine.call(owner, 'context_recall', { repository: 'project-A' });
  assert.equal(recall.history.length, 2);
  assert.deepEqual(
    new Set(recall.history.map((h: any) => h.provider)),
    new Set(['codex', 'claude']),
  );
  assert.equal(recall.history[0].status, 'proposed');
  const byCwd = await engine.call(owner, 'context_recall', {
    cwd: resolve(root, 'project-A/src'),
    branch: 'main',
  });
  assert.equal(byCwd.history.length, 2);
  assert.ok(byCwd.history.every((h: any) => h.branchCompatible === false));
  const global = await engine.call(owner, 'context_recall', {});
  assert.equal(global.repositories.length, 2);
  assert.equal(global.history.length, 2);
  const b = await engine.call(owner, 'context_recall', { repository: 'project-B' });
  assert.equal(b.history.length, 0);
  const fromBToA = await engine.call(owner, 'context_recall', {
    repository: 'project-A',
    query: 'cookie',
  });
  assert.equal(fromBToA.history.length, 2);
  assert.ok(memoryInstructions.startsWith('SCE'));
  assert.ok(memoryInstructions.includes('BEFORE scanning code'));
});
test('memory retry is idempotent and mismatched retries fail; secrets redacted before persistence', async () => {
  const retry = await engine.call(owner, 'context_checkpoint', checkpoint);
  assert.equal(retry.duplicate, true);
  await assert.rejects(
    () => engine.call(owner, 'context_checkpoint', { ...checkpoint, summary: 'Different claim' }),
    /Idempotency/,
  );
  await engine.call(owner, 'context_checkpoint', {
    ...checkpoint,
    idempotencyKey: 'secret',
    summary: 'token=do-not-store-this-secret',
  });
  const raw = (
    await pool.query('SELECT summary FROM session_memories WHERE summary LIKE $1', ['token=%'])
  ).rows[0];
  assert.equal(raw.summary, 'token=[REDACTED]');
});
test('cross-tenant and repo-limited history cannot leak through catalog, recall or direct SQL', async () => {
  const other = { ...owner, orgId: otherOrg, subject: 'other' };
  assert.deepEqual(await workspace.catalog(other), []);
  await assert.rejects(
    () => engine.call(other, 'context_recall', { repository: 'project-A' }),
    /not registered/,
  );
  await assert.rejects(
    () => engine.call(other, 'context_checkpoint', checkpoint),
    /not registered/,
  );
  const leaked = await tx(
    other,
    async (client) => (await client.query('SELECT * FROM session_memories')).rows,
  );
  assert.equal(leaked.length, 0);
  await pool.query(
    "INSERT INTO memberships(org_id,project_id,subject,permissions,repo_ids) VALUES($1,$2,'limited',ARRAY['read'],ARRAY[$3::uuid])",
    [org, repoB.project_id, repoB.repo_id],
  );
  const limited = { ...owner, subject: 'limited', permissions: ['read'] };
  assert.equal((await workspace.catalog(limited)).length, 1);
  assert.equal((await engine.call(limited, 'context_recall', {})).history.length, 0);
  await assert.rejects(
    () => engine.call(limited, 'context_recall', { repository: 'project-A' }),
    /not registered/,
  );
});
test('pause blocks new manual checkpoints but retains historical memory', async () => {
  await workspace.toggle(owner, repoA.repo_id, false);
  await assert.rejects(
    () => engine.call(owner, 'context_checkpoint', { ...checkpoint, idempotencyKey: 'paused' }),
    /paused/,
  );
  assert.ok(
    (await engine.call(owner, 'context_recall', { repository: 'project-A' })).history.length > 0,
  );
  await workspace.toggle(owner, repoA.repo_id, true);
});
test('parsers capture supported assistant text only, never tools, user messages or reasoning', () => {
  const codex = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Done; token=secret' }],
    },
  };
  assert.equal(assistantSummary('codex', codex), 'Done; token=[REDACTED]');
  assert.equal(
    assistantSummary('codex', { ...codex, payload: { ...codex.payload, phase: 'commentary' } }),
    undefined,
  );
  assert.equal(
    assistantSummary('codex', { ...codex, payload: { ...codex.payload, role: 'user' } }),
    undefined,
  );
  assert.equal(
    assistantSummary('codex', {
      type: 'response_item',
      payload: { type: 'reasoning', content: [{ type: 'text', text: 'private reasoning' }] },
    }),
    undefined,
  );
  const claude = {
    type: 'assistant',
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'private' },
        { type: 'text', text: 'Claude final result' },
      ],
    },
  };
  assert.equal(assistantSummary('claude', claude), 'Claude final result');
  assert.equal(assistantSummary('claude', { ...claude, isSidechain: true }), undefined);
});
test('host observer imports two providers, survives restart and partial writes, skips unobserved repositories', async () => {
  const logs = resolve(root, 'logs');
  await mkdir(logs);
  const a = resolve(logs, 'codex.jsonl'),
    b = resolve(logs, 'claude.jsonl'),
    ignored = resolve(logs, 'ignored.jsonl');
  const timestamp = new Date().toISOString();
  const meta = {
    type: 'session_meta',
    payload: {
      id: 'auto-codex',
      cwd: resolve(root, 'project-A'),
      git: { branch: 'feat/auto', commit_hash: 'abcdef1234567' },
    },
  };
  const output = {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Automatic history from Codex' }],
    },
  };
  await writeFile(a, JSON.stringify(meta) + '\n' + JSON.stringify(output) + '\n');
  await writeFile(
    b,
    JSON.stringify({
      timestamp,
      type: 'assistant',
      cwd: resolve(root, 'project-A'),
      sessionId: 'auto-claude',
      gitBranch: 'feat/claude',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Automatic history from Claude' }],
      },
    }) + '\n',
  );
  await writeFile(
    ignored,
    JSON.stringify({ ...meta, payload: { ...meta.payload, id: 'unobserved', cwd: root } }) +
      '\n' +
      JSON.stringify(output) +
      '\n',
  );
  let observer = new SessionObserver(pool, []);
  let watches = await workspace.catalog(owner);
  await observer.importFile({ provider: 'codex', path: a }, watches);
  await observer.importFile({ provider: 'claude', path: b }, watches);
  await observer.importFile({ provider: 'codex', path: ignored }, watches);
  let count = Number(
    (await pool.query("SELECT count(*) FROM session_memories WHERE summary LIKE 'Automatic%'"))
      .rows[0].count,
  );
  assert.equal(count, 2);
  observer = new SessionObserver(pool, []);
  await observer.importFile({ provider: 'codex', path: a }, watches);
  assert.equal(
    Number(
      (await pool.query("SELECT count(*) FROM session_memories WHERE summary LIKE 'Automatic%'"))
        .rows[0].count,
    ),
    2,
  );
  const appended = JSON.stringify({
    ...output,
    payload: {
      ...output.payload,
      content: [{ type: 'output_text', text: 'Automatic second turn' }],
    },
  });
  await appendFile(a, appended.slice(0, 40));
  await observer.importFile({ provider: 'codex', path: a }, watches);
  assert.equal(
    Number(
      (await pool.query("SELECT count(*) FROM session_memories WHERE summary LIKE 'Automatic%'"))
        .rows[0].count,
    ),
    2,
  );
  await appendFile(a, appended.slice(40) + '\n');
  await observer.importFile({ provider: 'codex', path: a }, watches);
  assert.equal(
    Number(
      (await pool.query("SELECT count(*) FROM session_memories WHERE summary LIKE 'Automatic%'"))
        .rows[0].count,
    ),
    3,
  );
  await workspace.toggle(owner, repoA.repo_id, false);
  await appendFile(a, JSON.stringify(output) + '\n');
  await observer.importFile({ provider: 'codex', path: a }, watches);
  assert.equal(
    Number(
      (await pool.query("SELECT count(*) FROM session_memories WHERE summary LIKE 'Automatic%'"))
        .rows[0].count,
    ),
    3,
  );
  await workspace.toggle(owner, repoA.repo_id, true);
});
test('observer skips oversized tool lines and keeps later final answers', async () => {
  const logs = resolve(root, 'oversized.jsonl');
  const header = {
    type: 'session_meta',
    payload: { id: 'large-output-session', cwd: resolve(root, 'project-A') },
  };
  const tool = {
    type: 'response_item',
    payload: { type: 'function_call_output', output: 'x'.repeat(3 * 1024 * 1024) },
  };
  const answer = {
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Answer after large tool output' }],
    },
  };
  await writeFile(logs, [header, tool, answer].map((v) => JSON.stringify(v)).join('\n') + '\n');
  const observer = new SessionObserver(pool, []),
    watches = await workspace.catalog(owner);
  for (let i = 0; i < 4; i++) await observer.importFile({ provider: 'codex', path: logs }, watches);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM session_memories WHERE summary=$1', [
        'Answer after large tool output',
      ])
    ).rows[0].n,
    1,
  );
});
test('local name resolution reads Git metadata only and rejects paths or symlinks outside workspace', async () => {
  const workspaceRoot = resolve(root, 'discovery');
  await mkdir(workspaceRoot);
  const safe = resolve(workspaceRoot, 'safe');
  await mkdir(safe);
  execFileSync('git', ['init', '--quiet', safe]);
  const outside = await mkdtemp(resolve(tmpdir(), 'sce-outside-'));
  execFileSync('git', ['init', '--quiet', outside]);
  await symlink(outside, resolve(workspaceRoot, 'escaped'));
  const resolver = new RepositoryResolver([workspaceRoot]);
  assert.ok((await resolver.candidates()).includes('safe'));
  assert.equal((await resolver.resolve('safe')).localPath, safe);
  await assert.rejects(() => resolver.resolve('escaped'), /Không tìm thấy/);
  await assert.rejects(() => resolver.resolve('../discovery'), /Không tìm thấy/);
});
test('two Codex sessions and two Claude sessions in B can read each other without scanning code', async () => {
  for (const [provider, id] of [
    ['codex', 'codex-B-1'],
    ['codex', 'codex-B-2'],
    ['claude', 'claude-B-1'],
    ['claude', 'claude-B-2'],
  ]) {
    await engine.call(owner, 'context_checkpoint', {
      repository: 'project-B',
      provider,
      externalSessionId: id,
      summary: `Shared work from ${id}`,
      idempotencyKey: id,
    });
  }
  const recall = await engine.call(owner, 'context_recall', { repository: 'project-B' });
  assert.equal(recall.history.length, 4);
  assert.equal(new Set(recall.history.map((h: any) => h.session_id)).size, 4);
  assert.ok(
    (await engine.call(owner, 'context_recall', { repository: 'project-A' })).history.length > 0,
  );
});
test('UI API adds repo by name, lists it, pauses it and rejects bad registration input', async () => {
  const { buildApp } = await import('../apps/api/src/app.js');
  const resolver = new RepositoryResolver([resolve(root, 'discovery')]);
  const app = buildApp(engine, async () => owner, { repositoryResolver: resolver });
  try {
    const names = await app.inject({ method: 'GET', url: '/v1/repositories/candidates' });
    assert.ok(names.json().names.includes('safe'));
    const added = await app.inject({
      method: 'POST',
      url: '/v1/repositories',
      payload: { name: 'safe', historyDays: 7 },
    });
    assert.equal(added.statusCode, 200, added.body);
    assert.ok(added.json().repo_id);
    const list = await app.inject({ method: 'GET', url: '/v1/repositories' });
    assert.ok(list.json().repositories.some((r: any) => r.name === 'safe'));
    const pause = await app.inject({
      method: 'PATCH',
      url: `/v1/repositories/${added.json().repo_id}`,
      payload: { enabled: false },
    });
    assert.equal(pause.json().enabled, false);
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/repositories',
      payload: { name: '../../outside' },
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await app.close();
  }
});
test('real MCP discovery includes recall workflow instructions and named-repo checkpoint/read', async () => {
  const { buildApp } = await import('../apps/api/src/app.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const app = buildApp(engine, async () => owner);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as any;
  const client = new Client({ name: 'workspace-mcp-test', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)),
    );
    assert.ok(client.getInstructions()?.includes('BEFORE scanning code'));
    const names = await client.listTools();
    assert.ok(names.tools.some((t) => t.name === 'context_recall'));
    const result = await client.callTool({
      name: 'context_recall',
      arguments: { repository: 'project-A' },
    });
    assert.ok(!result.isError);
    assert.ok(JSON.parse((result.content as any)[0].text).history.length > 0);
  } finally {
    await client.close();
    await app.close();
  }
});

test('long Vietnamese summaries remain readable under the default recall budget', async () => {
  await engine.call(owner, 'context_checkpoint', {
    ...checkpoint,
    summary: 'Quyết định và việc còn lại. '.repeat(180),
    idempotencyKey: 'long-summary',
  });
  const result = await engine.call(owner, 'context_recall', {
    repository: 'project-A',
    query: 'quyết',
  });
  assert.ok(result.history.length > 0);
  assert.equal(result.history[0].summaryTruncated, true);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.history)) < 5000);
});
test('retention deletes expired session history but keeps fresh memory and durable decisions', async () => {
  const { runRetention } = await import('../packages/retention/src/index.js');
  const c = await workspace.register(
    owner,
    {
      name: 'retention-C',
      remoteUrl: 'https://example.invalid/retention',
      localPath: null,
      defaultBranch: 'main',
    },
    7,
  );
  const fresh = await engine.call(owner, 'context_checkpoint', {
    repository: 'retention-C',
    provider: 'codex',
    externalSessionId: 'retention-session',
    summary: 'Fresh memory',
    idempotencyKey: 'fresh',
  });
  await pool.query(
    "INSERT INTO session_memories(project_id,repo_id,session_id,source_key,summary,occurred_at) VALUES($1,$2,$3,'expired-source','Expired history',now()-interval '8 days')",
    [c.project_id, c.repo_id, fresh.sessionId],
  );
  const decision = await engine.call(owner, 'context_publish', {
    projectId: c.project_id,
    repoId: c.repo_id,
    sessionId: fresh.sessionId,
    kind: 'decision',
    content: 'Permanent architecture decision',
    branch: 'main',
    idempotencyKey: 'permanent',
  });
  const stats = await runRetention(pool);
  assert.ok(stats.memories >= 1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM session_memories WHERE repo_id=$1 AND source_key='expired-source'",
        [c.repo_id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM session_memories WHERE id=$1', [fresh.id]))
      .rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM context_records WHERE id=$1', [decision.id]))
      .rows[0].n,
    1,
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const replay = await workspace.checkpoint(
      client,
      {
        projectId: c.project_id,
        repoId: c.repo_id,
        provider: 'codex',
        externalSessionId: 'retention-session',
        machineId: 'test',
        sourceKey: 'expired-source',
        summary: 'Expired history',
        occurredAt: new Date(Date.now() - 8 * 86400000).toISOString(),
      },
      'host-observer',
    );
    assert.equal(replay.skipped, true);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
});
test('count and byte limits prune oldest memory immediately, refuse oversized entries and prevent replay', async () => {
  const c = (await workspace.catalog(owner)).find((r) => r.name === 'retention-C');
  await pool.query('UPDATE repository_watches SET max_memories=3 WHERE repo_id=$1', [c.repo_id]);
  for (let i = 0; i < 5; i++)
    await engine.call(owner, 'context_checkpoint', {
      repository: c.name,
      provider: 'claude',
      externalSessionId: 'quota-session',
      summary: `Quota memory ${i}`,
      idempotencyKey: `quota-${i}`,
    });
  let rows = (
    await pool.query(
      'SELECT * FROM session_memories WHERE repo_id=$1 ORDER BY occurred_at DESC,source_key DESC',
      [c.repo_id],
    )
  ).rows;
  assert.equal(rows.length, 3);
  assert.ok(rows.some((r) => r.summary === 'Quota memory 4'));
  assert.ok(!rows.some((r) => r.summary === 'Quota memory 0'));
  const pruned = (
    await pool.query(
      'SELECT memory_pruned_at,memory_pruned_key FROM repository_watches WHERE repo_id=$1',
      [c.repo_id],
    )
  ).rows[0];
  assert.ok(pruned.memory_pruned_at);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const replay = await workspace.checkpoint(
      db,
      {
        projectId: c.project_id,
        repoId: c.repo_id,
        provider: 'codex',
        externalSessionId: 'quota-replay',
        machineId: 'test',
        sourceKey: pruned.memory_pruned_key,
        summary: 'Old replay',
        occurredAt: new Date(new Date(pruned.memory_pruned_at).getTime() - 1000).toISOString(),
      },
      'host-observer',
    );
    assert.equal(replay.skipped, true);
    await db.query('COMMIT');
  } finally {
    db.release();
  }
  await pool.query(
    'UPDATE repository_watches SET max_memories=100,max_memory_bytes=5000 WHERE repo_id=$1',
    [c.repo_id],
  );
  for (let i = 0; i < 2; i++)
    await engine.call(owner, 'context_checkpoint', {
      repository: c.name,
      provider: 'codex',
      externalSessionId: 'byte-session',
      summary: `Bytes ${i} ` + 'x'.repeat(3800),
      idempotencyKey: `bytes-${i}`,
    });
  const size = (
    await pool.query(
      'SELECT sum(content_bytes)::int AS bytes FROM session_memories WHERE repo_id=$1',
      [c.repo_id],
    )
  ).rows[0].bytes;
  assert.ok(size <= 5000);
  assert.ok(size > 0);
  await assert.rejects(
    () =>
      engine.call(owner, 'context_checkpoint', {
        repository: c.name,
        provider: 'codex',
        externalSessionId: 'oversized',
        summary: 'x'.repeat(6000),
        idempotencyKey: 'too-large',
      }),
    /storage limit/,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT sum(content_bytes)::int AS bytes FROM session_memories WHERE repo_id=$1',
        [c.repo_id],
      )
    ).rows[0].bytes,
    size,
  );
});
test('maintenance preserves pending events, expires old cursors, deletes orphan sessions and is repeatable', async () => {
  const { runRetention, retentionScheduler } = await import('../packages/retention/src/index.js');
  const c = (await workspace.catalog(owner)).find((r) => r.name === 'retention-C');
  const accepted = await engine.ingest(owner, {
    projectId: c.project_id,
    repoId: c.repo_id,
    eventType: 'session.checkpoint',
    idempotencyKey: 'processed-expired',
    payload: { summary: 'Old event' },
  });
  const pending = await engine.ingest(owner, {
    projectId: c.project_id,
    repoId: c.repo_id,
    eventType: 'session.checkpoint',
    idempotencyKey: 'pending-expired',
    payload: { summary: 'Do not lose accepted event' },
  });
  await pool.query(
    "UPDATE outbox_events SET created_at=now()-interval '40 days',processed_at=now() WHERE event_id=$1",
    [accepted.id],
  );
  await pool.query(
    "UPDATE outbox_events SET created_at=now()-interval '40 days' WHERE event_id=$1",
    [pending.id],
  );
  await pool.query("UPDATE context_events SET created_at=now()-interval '40 days' WHERE id=$1", [
    accepted.id,
  ]);
  await pool.query(
    "INSERT INTO audit_logs(project_id,subject,action,created_at) VALUES($1,'test','old.audit',now()-interval '40 days')",
    [c.project_id],
  );
  const orphan = (
    await pool.query(
      "INSERT INTO sessions(project_id,provider,external_session_id,machine_id,last_seen_at) VALUES($1,'codex','orphan-old','test',now()-interval '40 days') RETURNING id",
      [c.project_id],
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO session_repositories(project_id,session_id,repo_id,branch) VALUES($1,$2,$3,'main')",
    [c.project_id, orphan, c.repo_id],
  );
  const first = await runRetention(pool);
  assert.ok(first.outbox >= 1);
  assert.ok(first.audits >= 1);
  assert.ok(first.sessions >= 1);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM outbox_events WHERE event_id=$1', [
        pending.id,
      ])
    ).rows[0].n,
    1,
  );
  const floor = (
    await pool.query('SELECT cursor FROM delta_retention_floors WHERE project_id=$1', [
      c.project_id,
    ])
  ).rows[0].cursor;
  await assert.rejects(
    () =>
      engine.call(owner, 'context_get_changes', {
        projectId: c.project_id,
        cursor: (BigInt(floor) - 1n).toString(),
      }),
    /Cursor expired/,
  );
  const reset = await engine.call(owner, 'context_get_changes', {
    projectId: c.project_id,
    cursor: '0',
  });
  assert.equal(reset.resyncRequired, true);
  assert.ok(BigInt(reset.cursor) >= BigInt(floor));
  const again = await runRetention(pool);
  assert.equal(again.outbox, 0);
  assert.equal(again.sessions, 0);
  const sweep = retentionScheduler(pool, 0, true);
  await sweep(); // Exercises VACUUM outside a transaction on local PostgreSQL.
});
test('retention function cannot be invoked against another tenant through scoped runtime SQL', async () => {
  await assert.rejects(
    () =>
      tx({ ...owner, orgId: otherOrg, subject: 'other' }, (db) =>
        db.query('SELECT sce_prune_memories($1)', [repoA.repo_id]),
      ),
    /Access denied/,
  );
});
test('bulk history above ten thousand records is trimmed to the default repository limit', async (t) => {
  const c = await workspace.register(
    owner,
    {
      name: 'volume-history',
      remoteUrl: 'https://example.invalid/volume',
      localPath: null,
      defaultBranch: 'main',
    },
    30,
  );
  const first = await engine.call(owner, 'context_checkpoint', {
    repository: 'volume-history',
    provider: 'codex',
    externalSessionId: 'bulk-session',
    summary: 'Latest retained state',
    idempotencyKey: 'bulk-start',
  });
  await pool.query(
    `INSERT INTO session_memories(project_id,repo_id,session_id,source_key,summary,occurred_at)
   SELECT $1,$2,$3,'bulk:'||lpad(g::text,8,'0'),'Historical item '||g::text||' '||repeat('x',100),now()-interval '1 hour'+g*interval '1 millisecond' FROM generate_series(1,12000) g`,
    [c.project_id, c.repo_id, first.sessionId],
  );
  const client = await pool.connect();
  let removed;
  try {
    await client.query('BEGIN');
    removed = (await client.query('SELECT sce_prune_memories($1) AS n', [c.repo_id])).rows[0].n;
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const result = (
    await pool.query(
      'SELECT count(*)::int AS n,sum(content_bytes)::bigint AS bytes FROM session_memories WHERE repo_id=$1',
      [c.repo_id],
    )
  ).rows[0];
  assert.equal(removed, 2001);
  assert.equal(result.n, 10000);
  assert.ok(BigInt(result.bytes) <= 104857600n);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM session_memories WHERE id=$1', [first.id]))
      .rows[0].n,
    1,
  );
  t.diagnostic(
    'Seeded 12,001 session memories; retained the newest 10,000 without removing latest state. This is a storage-policy test, not a production throughput benchmark.',
  );
});
test('manual cleanup previews and deletes only old session memory in the selected repository', async () => {
  const repo = await workspace.register(
    owner,
    {
      name: 'cleanup-demo',
      remoteUrl: 'https://example.invalid/cleanup',
      localPath: null,
      defaultBranch: 'main',
    },
    90,
  );
  const fresh = await engine.call(owner, 'context_checkpoint', {
    repository: 'cleanup-demo',
    provider: 'codex',
    externalSessionId: 'cleanup-session',
    summary: 'Fresh session history',
    idempotencyKey: 'fresh-cleanup',
  });
  await pool.query(
    "INSERT INTO session_memories(project_id,repo_id,session_id,source_key,summary,occurred_at) VALUES($1,$2,$3,'old-cleanup','Old session history',now()-interval '40 days')",
    [repo.project_id, repo.repo_id, fresh.sessionId],
  );
  const decision = await engine.call(owner, 'context_publish', {
    projectId: repo.project_id,
    repoId: repo.repo_id,
    sessionId: fresh.sessionId,
    kind: 'decision',
    content: 'Keep this decision',
    branch: 'main',
    idempotencyKey: 'keep-decision',
  });
  const beforeOther = (
    await pool.query('SELECT count(*)::int AS n FROM session_memories WHERE repo_id=$1', [
      repoA.repo_id,
    ])
  ).rows[0].n;
  const preview = await workspace.clearOld(owner, repo.repo_id, {
    olderThanDays: 30,
    preview: true,
  });
  assert.equal(preview.eligibleCount, 1);
  assert.ok(Number(preview.eligibleBytes) > 0);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM session_memories WHERE repo_id=$1', [
        repo.repo_id,
      ])
    ).rows[0].n,
    2,
  );
  await assert.rejects(
    () =>
      workspace.clearOld(owner, repo.repo_id, {
        olderThanDays: 30,
        preview: false,
        cutoff: preview.cutoff,
        confirmation: 'wrong',
      }),
    /confirmation/,
  );
  const cleared = await workspace.clearOld(owner, repo.repo_id, {
    olderThanDays: 30,
    preview: false,
    cutoff: preview.cutoff,
    confirmation: 'cleanup-demo',
  });
  assert.equal(cleared.eligibleCount, 1);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM session_memories WHERE id=$1', [fresh.id]))
      .rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM context_records WHERE id=$1', [decision.id]))
      .rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM session_memories WHERE repo_id=$1', [
        repoA.repo_id,
      ])
    ).rows[0].n,
    beforeOther,
  );
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const replay = await workspace.checkpoint(
      db,
      {
        projectId: repo.project_id,
        repoId: repo.repo_id,
        provider: 'claude',
        externalSessionId: 'late-import',
        machineId: 'test',
        sourceKey: 'unknown-old-source',
        summary: 'Old history not previously imported',
        occurredAt: new Date(Date.now() - 35 * 86400000).toISOString(),
      },
      'host-observer',
    );
    assert.equal(replay.skipped, true);
    await db.query('COMMIT');
  } finally {
    db.release();
  }
  await assert.rejects(
    () =>
      workspace.clearOld({ ...owner, orgId: otherOrg, subject: 'other' }, repo.repo_id, {
        olderThanDays: 30,
        preview: true,
      }),
    /Access denied/,
  );
  await assert.rejects(
    () =>
      workspace.clearOld({ ...owner, permissions: ['read', 'write'] }, repo.repo_id, {
        olderThanDays: 30,
        preview: true,
      }),
    /Access denied/,
  );
});
test('cleanup API requires preview cutoff and repository confirmation before deleting', async () => {
  const { buildApp } = await import('../apps/api/src/app.js');
  const app = buildApp(engine, async () => owner);
  const repo = (await workspace.catalog(owner)).find((r) => r.name === 'cleanup-demo');
  try {
    const malformed = await app.inject({
      method: 'POST',
      url: `/v1/repositories/${repo.repo_id}/cleanup`,
      payload: { olderThanDays: 30, preview: false },
    });
    assert.equal(malformed.statusCode, 400);
    const preview = await app.inject({
      method: 'POST',
      url: `/v1/repositories/${repo.repo_id}/cleanup`,
      payload: { olderThanDays: 30, preview: true },
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().eligibleCount, 0);
    const future = await app.inject({
      method: 'POST',
      url: `/v1/repositories/${repo.repo_id}/cleanup`,
      payload: {
        olderThanDays: 30,
        preview: false,
        confirmation: repo.name,
        cutoff: new Date().toISOString(),
      },
    });
    assert.equal(future.statusCode, 400);
  } finally {
    await app.close();
  }
});
