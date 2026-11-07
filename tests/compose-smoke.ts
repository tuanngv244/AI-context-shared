import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((x) => x && !x.startsWith('#'))
    .map((x) => {
      const n = x.indexOf('=');
      return [x.slice(0, n), x.slice(n + 1)];
    }),
);
const projectId = '22222222-2222-4222-8222-222222222222',
  repoId = '33333333-3333-4333-8333-333333333333',
  sessionId = '44444444-4444-4444-8444-444444444444',
  taskId = '55555555-5555-4555-8555-555555555555';
const client = new Client({ name: 'compose-smoke', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8787/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${env.SCE_LOCAL_TOKEN}` } },
  }),
);
async function call(name: string, args: any) {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, JSON.stringify(r));
  return JSON.parse((r.content as any)[0].text);
}
try {
  const unique = crypto.randomUUID();
  const record = await call('context_publish', {
    projectId,
    repoId,
    sessionId,
    kind: 'contract',
    branch: 'feat/smoke',
    content: `Smoke contract ${unique}`,
    idempotencyKey: unique,
  });
  assert.equal(record.status, 'proposed');
  const search = await call('context_search', { projectId, branch: 'feat/smoke', query: 'Smoke' });
  assert.ok(search.items.some((r: any) => r.id === record.id));
  const main = await call('context_search', { projectId, branch: 'main', query: unique });
  assert.equal(main.items.length, 0);
  await call('context_handoff', {
    projectId,
    sessionId,
    taskId,
    summary: `Smoke handoff ${unique}`,
    idempotencyKey: `h-${unique}`,
  });
  const task = await call('context_get_task', { projectId, taskId });
  assert.ok(task.handoffs.some((h: any) => h.summary.includes(unique)));
  const denied = await client.callTool({
    name: 'context_search',
    arguments: { projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  });
  assert.equal(denied.isError, true);
  const dashboard = await fetch('http://127.0.0.1:3000');
  assert.equal(dashboard.status, 200);
  const restarted = spawnSync(
    'docker',
    ['compose', 'restart', 'postgres', 'redis', 'api', 'worker'],
    { stdio: 'inherit' },
  );
  assert.equal(restarted.status, 0);
  let ready = false;
  for (let n = 0; n < 45; n++) {
    try {
      ready = (await fetch('http://127.0.0.1:8787/health/ready')).ok;
    } catch {}
    if (ready) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(ready, 'Services did not recover after restart');
  const restored = await call('context_get', { projectId, id: record.id, branch: 'feat/smoke' });
  assert.equal(restored.content, record.content);
  console.log('Compose MCP publish/search/handoff/isolation/dashboard/restart smoke passed');
} finally {
  await client.close();
}
