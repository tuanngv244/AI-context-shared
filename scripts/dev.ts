import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, dirname, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { SessionObserver } from '../packages/observer/src/index.js';
import { RepositoryResolver } from '../packages/observer/src/repositories.js';
import { spawn } from 'node:child_process';
import { retentionScheduler } from '../packages/retention/src/index.js';

const localDir = resolve(process.env.SCE_DEV_DIR ?? '.local');
const apiPort = Number(process.env.API_PORT ?? 8787);
const dashboardPort = Number(process.env.DASHBOARD_PORT ?? 3000);
await mkdir(localDir, { recursive: true, mode: 0o700 });
const tokenPath = resolve(localDir, 'dev-token');
try {
  await writeFile(tokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
} catch (error: any) {
  if (error.code !== 'EEXIST') throw error;
}
await chmod(tokenPath, 0o600);
Object.assign(process.env, {
  SCE_LOCAL_DB: resolve(localDir, 'postgres'),
  AUTH_MODE: 'local',
  SCE_LOCAL_TOKEN: (await readFile(tokenPath, 'utf8')).trim(),
  SCE_LOCAL_ORG_ID: '11111111-1111-4111-8111-111111111111',
  SCE_ALLOWED_ORIGIN: `http://localhost:${dashboardPort}`,
  SCE_API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
  NEXT_TELEMETRY_DISABLED: '1',
});
function setup(file: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', file], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${file} exited ${code}`)),
    );
  });
}
await setup('packages/db/src/migrate.ts');
await setup('packages/db/src/seed.ts');
const { pool, closeDatabase } = await import('../packages/db/src/index.js');
const { processEvent } = await import('../packages/events/src/process.js');
const { buildApp } = await import('../apps/api/src/app.js');
const resolver = new RepositoryResolver(
  (process.env.SCE_WORKSPACE_ROOTS ?? dirname(process.cwd())).split(delimiter),
);
const sweepRetention = retentionScheduler(pool, 60000, true);
const observer = new SessionObserver(pool, [
  {
    provider: 'codex',
    path:
      process.env.SCE_CODEX_SESSIONS_DIR ??
      resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex'), 'sessions'),
  },
  {
    provider: 'codex',
    path:
      process.env.SCE_CODEX_ARCHIVED_DIR ??
      (process.env.SCE_CODEX_SESSIONS_DIR
        ? resolve(process.env.SCE_CODEX_SESSIONS_DIR, 'archived')
        : resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex'), 'archived_sessions')),
  },
  {
    provider: 'claude',
    path:
      process.env.SCE_CLAUDE_SESSIONS_DIR ??
      resolve(process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'), 'projects'),
  },
]);
const app = buildApp(undefined, undefined, { repositoryResolver: resolver });
let dashboard: ReturnType<typeof spawn> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let processing: Promise<void> | undefined;
let stopping = false;
async function processPending() {
  await sweepRetention().catch(() => console.error('History retention retrying next cycle.'));
  await observer
    .scan()
    .catch(() =>
      console.error('Local session observer retrying; inspect repository status on the dashboard.'),
    );
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const rows = (
      await db.query(
        'SELECT id FROM outbox_events WHERE processed_at IS NULL ORDER BY id LIMIT 100',
      )
    ).rows;
    for (const row of rows) {
      await processEvent(db, row.id);
      await db.query(
        'UPDATE outbox_events SET published_at=COALESCE(published_at,now()) WHERE id=$1',
        [row.id],
      );
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Local event processing failed; retrying next interval.');
  } finally {
    db.release();
  }
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  const dashboardStopped =
    dashboard && dashboard.exitCode === null
      ? new Promise<void>((resolve) => {
          dashboard!.once('exit', () => resolve());
          dashboard!.kill('SIGTERM');
        })
      : Promise.resolve();
  await app.close();
  await processing;
  await closeDatabase();
  await dashboardStopped;
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
try {
  await app.listen({ host: '127.0.0.1', port: apiPort });
  timer = setInterval(() => {
    if (!processing)
      processing = processPending().finally(() => {
        processing = undefined;
      });
  }, 3000);
  dashboard = spawn(
    process.execPath,
    [
      resolve('node_modules/next/dist/bin/next'),
      'dev',
      'apps/dashboard',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(dashboardPort),
    ],
    { stdio: 'inherit', env: process.env },
  );
  dashboard.on('error', (error) => {
    console.error(error.message);
    void stop(1);
  });
  dashboard.on('exit', (code) => {
    if (!stopping) void stop(code ?? 1);
  });
  console.log(
    `Local dashboard: http://localhost:${dashboardPort}\nAPI/MCP: http://127.0.0.1:${apiPort}/mcp\nDashboard token file: ${tokenPath}\nLocal dev uses persistent PGlite and an in-process event processor and watched-repo session observer (no Redis).`,
  );
} catch (error) {
  console.error(error);
  await stop(1);
}
