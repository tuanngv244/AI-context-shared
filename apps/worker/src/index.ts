import { Queue, Worker } from 'bullmq';
import { retentionScheduler } from '../../../packages/retention/src/index.js';
import { processEvent } from '../../../packages/events/src/process.js';
import { pool } from '../../../packages/db/src/index.js';
const redisUrl = new URL(process.env.REDIS_URL!);
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  password: decodeURIComponent(redisUrl.password) || undefined,
  maxRetriesPerRequest: null,
};
const queue = new Queue('sce-events', { connection });
const worker = new Worker(
  'sce-events',
  async (job) => {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await processEvent(db, job.data.id);
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  },
  { connection, concurrency: 4 },
);
worker.on('failed', (job) =>
  console.error(
    JSON.stringify({ event: 'job.failed', jobId: job?.id, attempts: job?.attemptsMade }),
  ),
);
const sweepRetention = retentionScheduler(pool);
let stopped = false;
async function relay() {
  while (!stopped) {
    await sweepRetention().catch(() => console.error('{"event":"retention.retry"}'));
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const rows = (
        await db.query(
          'SELECT id FROM outbox_events WHERE published_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100',
        )
      ).rows;
      for (const row of rows) {
        await queue.add(
          'process',
          { id: row.id },
          {
            jobId: String(row.id),
            attempts: 8,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: { age: 86400 },
            removeOnFail: { age: 30 * 86400, count: 10000 },
          },
        );
        await db.query(
          'UPDATE outbox_events SET published_at=now(),attempts=attempts+1 WHERE id=$1',
          [row.id],
        );
      }
      await db.query('COMMIT');
    } catch {
      await db.query('ROLLBACK');
      console.error('{"event":"relay.retry"}');
    } finally {
      db.release();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const running = relay();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    stopped = true;
    await running;
    await worker.close();
    await queue.close();
    await pool.end();
    process.exit(0);
  });
