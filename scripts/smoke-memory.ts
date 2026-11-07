import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
await writeFile(
  'apps/dashboard/.tsconfig-memory-smoke.json',
  await readFile('apps/dashboard/tsconfig.json'),
);
const temp = await realpath(await mkdtemp(resolve(tmpdir(), 'sce-workflow-')));
const roots = resolve(temp, 'repos'),
  logs = resolve(temp, 'codex-sessions'),
  claude = resolve(temp, 'claude-projects'),
  state = resolve(temp, 'state');
for (const dir of [roots, logs, claude]) await mkdir(dir, { recursive: true });
for (const repo of ['project-A', 'project-B']) {
  const path = resolve(roots, repo);
  await mkdir(path);
  execFileSync('git', ['init', '--quiet', path]);
}
const timestamp = new Date().toISOString();
for (const id of ['codex-A-1', 'codex-A-2'])
  await writeFile(
    resolve(logs, id + '.jsonl'),
    [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id,
          cwd: resolve(roots, 'project-A'),
          git: { branch: 'feat/history', commit_hash: 'abcdef1234567' },
        },
      }),
      JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [
            {
              type: 'output_text',
              text: `Cookie refresh work from ${id}; pending integration tests`,
            },
          ],
        },
      }),
    ].join('\n') + '\n',
  );
await writeFile(
  resolve(claude, 'claude-A.jsonl'),
  JSON.stringify({
    timestamp,
    type: 'assistant',
    cwd: resolve(roots, 'project-A'),
    sessionId: 'claude-A-1',
    gitBranch: 'feat/claude',
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Claude reviewed refresh contract; confirm cookie domain' }],
    },
  }) + '\n',
);
let child: ChildProcess | undefined;
let client: Client | undefined;
let output = '';
const api = 'http://127.0.0.1:18787',
  ui = 'http://127.0.0.1:13000';
async function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'scripts/dev.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SCE_DEV_DIR: state,
      SCE_WORKSPACE_ROOTS: roots,
      SCE_CODEX_SESSIONS_DIR: logs,
      SCE_CLAUDE_SESSIONS_DIR: claude,
      API_PORT: '18787',
      DASHBOARD_PORT: '13000',
      SCE_NEXT_DIST_DIR: '.next-memory-smoke',
      SCE_NEXT_TSCONFIG: '.tsconfig-memory-smoke.json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (b) => {
    output += b;
  });
  child.stderr?.on('data', (b) => {
    output += b;
  });
  for (let n = 0; n < 90; n++) {
    if (child.exitCode !== null) throw new Error('Local stack exited before startup');
    try {
      if ((await fetch(api + '/health/ready')).ok && (await fetch(ui)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Local stack did not become ready');
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const c = child;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      c.kill('SIGKILL');
      reject(new Error('Stack shutdown timed out'));
    }, 20000);
    c.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    c.kill('SIGTERM');
  });
}
try {
  await start();
  const token = (await readFile(resolve(state, 'dev-token'), 'utf8')).trim();
  const request = async (path: string, body?: unknown) => {
    const r = await fetch(ui + path, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const a = await request('/api/repositories', { name: 'project-A', historyDays: 30 });
  await request('/api/repositories', { name: 'project-B', historyDays: 30 });
  for (let n = 0; n < 20; n++) {
    const list = await request('/api/repositories');
    const repo = list.repositories.find((r: any) => r.name === 'project-A');
    if (repo.memory_count === 3) break;
    if (n === 19) throw new Error('Observer did not import expected summaries');
    await new Promise((r) => setTimeout(r, 1000));
  }
  client = new Client({ name: 'second-project-client', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('scripts/mcp-bridge.mjs')],
      env: {
        SCE_URL: api + '/mcp',
        SCE_TOKEN_FILE: resolve(state, 'dev-token'),
        HTTP_PROXY: 'http://127.0.0.1:1',
      },
    }),
  );
  const result = await client.callTool({
    name: 'context_recall',
    arguments: { repository: 'project-A' },
  });
  assert.ok(!result.isError);
  const memory = JSON.parse((result.content as any)[0].text);
  assert.equal(memory.history.length, 3);
  assert.deepEqual(
    new Set(memory.history.map((h: any) => h.provider)),
    new Set(['codex', 'claude']),
  );
  const dashboard = await fetch(ui + '/api/context', {
    headers: { authorization: `Bearer ${token}`, 'x-project-id': a.project_id },
  });
  assert.equal(dashboard.status, 200);
  assert.equal((await dashboard.json()).memories.length, 3);
  await client.close();
  client = undefined;
  await stop();
  await start();
  const persisted = await request('/api/repositories');
  assert.equal(persisted.repositories.find((r: any) => r.name === 'project-A').memory_count, 3);
  console.log(
    'PASS: UI proxy add repo → automatic two-Codex + Claude history → MCP bridge cross-project recall → dashboard → full local restart without duplicate memories.',
  );
  console.log('Fixture workspace: ' + temp);
} catch (error) {
  console.error(output.slice(-10000));
  throw error;
} finally {
  await client?.close();
  await stop();
}
