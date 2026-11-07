import { randomUUID, createHash } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Spool } from './spool.js';
import { redact } from './redact.js';
const [command, arg, ...args] = process.argv.slice(2);
const path = process.env.SCE_SPOOL_PATH ?? join(homedir(), '.sce', 'spool.sqlite');
let spool: Spool;
try {
  spool = new Spool(path);
} catch {
  console.error('SCE spool unavailable.');
  process.exit(command === 'hook' ? 0 : 1);
}
function git(...args: string[]) {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: 1500, maxBuffer: 1024 * 1024 });
  return r.status === 0 ? r.stdout.trim() : undefined;
}
async function request(path: string, body: any) {
  const url = new URL(path, process.env.SCE_URL ?? 'http://127.0.0.1:8787');
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('Remote SCE requires HTTPS');
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${process.env.SCE_TOKEN ?? ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok)
    throw Object.assign(new Error('SCE request failed'), { status: response.status });
  return response.json() as Promise<any>;
}
async function flush(limit = 100) {
  await spool.flush(
    async (body) => {
      await request('/v1/events', body);
    },
    Date.now(),
    limit,
  );
}
async function readInput() {
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value) > 128 * 1024) throw new Error('Hook input too large');
  }
  return value ? JSON.parse(value) : {};
}
async function main() {
  if (command === 'status') {
    console.log(JSON.stringify(spool.status()));
    return;
  }
  if (command === 'flush') {
    await flush();
    console.log(JSON.stringify(spool.status()));
    return;
  }
  if (command === 'sync') {
    const projectId = process.env.SCE_PROJECT_ID;
    const key = `cursor:${projectId}:${process.env.SCE_REPO_ID ?? ''}`;
    const delta = await request('/v1/tools/context_get_changes', {
      projectId,
      repositoryIds: process.env.SCE_REPO_ID ? [process.env.SCE_REPO_ID] : [],
      cursor: spool.get(key) ?? '0',
    });
    console.log(JSON.stringify({ untrusted: true, ...delta }));
    spool.set(key, delta.cursor);
    return;
  }
  if (command === 'run') {
    if (!['codex', 'claude'].includes(arg)) throw new Error('Usage: sce run codex|claude [args]');
    await capture('session-start', { provider: arg, session_id: randomUUID() });
    await flush(1);
    const result = spawnSync(arg, args, { stdio: 'inherit' });
    await capture('stop', { provider: arg });
    await flush(1);
    process.exitCode = result.status ?? 1;
    return;
  }
  if (command === 'hook') {
    await capture(arg, await readInput());
    await flush(1);
    return;
  }
  console.log(
    'sce hook <session-start|prompt-submit|tool-completed|pre-compact|post-compact|stop> | flush | sync | status | run codex|claude [args]',
  );
}
async function capture(event: string, input: any) {
  const eventType: Record<string, string> = {
    'session-start': 'session.started',
    'prompt-submit': 'session.heartbeat',
    'tool-completed': 'code.changed',
    'pre-compact': 'session.checkpoint',
    'post-compact': 'session.checkpoint',
    stop: 'session.ended',
  };
  if (!eventType[event]) throw new Error('Unknown lifecycle event');
  const provider = input.provider === 'codex' ? 'codex' : 'claude';
  const key = `session:${process.env.SCE_PROJECT_ID}:${provider}:${git('rev-parse', '--show-toplevel') ?? process.cwd()}`;
  const externalSessionId = String(input.session_id ?? spool.get(key) ?? randomUUID());
  if (event === 'session-start') spool.set(key, externalSessionId);
  const branch = git('branch', '--show-current') || 'detached';
  const headSha = git('rev-parse', 'HEAD');
  const body = redact({
    projectId: process.env.SCE_PROJECT_ID,
    repoId: process.env.SCE_REPO_ID || undefined,
    sessionId: process.env.SCE_SESSION_ID || undefined,
    idempotencyKey: randomUUID(),
    eventType: eventType[event],
    payload: {
      provider,
      externalSessionId,
      machineId: createHash('sha256').update(hostname()).digest('hex'),
      branch,
      headSha,
      files: (git('diff', '--name-only', 'HEAD') ?? '').split('\n').filter(Boolean),
    },
  });
  if (!body.projectId) throw new Error('SCE_PROJECT_ID is required');
  spool.enqueue(body.idempotencyKey, body);
}
try {
  await main();
} catch {
  console.error('SCE unavailable; use sce status to inspect pending capture.');
  if (command !== 'hook') process.exitCode = 1;
} finally {
  spool.close();
}
