import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Spool } from '../cli/sce/src/spool.js';
test('offline spool retries with stable idempotency and survives reopen', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'sce-test-')), 'spool.sqlite');
  let spool = new Spool(path);
  spool.enqueue('stable', { idempotencyKey: 'stable', content: 'sanitized' });
  spool.enqueue('stable', { idempotencyKey: 'stable' });
  await spool.flush(async () => {
    throw new Error('offline');
  });
  assert.equal((spool.status()[0] as any).state, 'retrying');
  spool.close();
  spool = new Spool(path);
  assert.equal((spool.status()[0] as any).count, 1);
  const received: any[] = [];
  await spool.flush(async (body) => {
    received.push(body);
  }, Date.now() + 7200000);
  assert.equal(received[0].idempotencyKey, 'stable');
  assert.equal(spool.status().length, 0);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  spool.close();
});
test('permanent denied delivery is retained as dead for inspection', async () => {
  const spool = new Spool(join(mkdtempSync(join(tmpdir(), 'sce-dead-')), 'spool.sqlite'));
  spool.enqueue('denied', { idempotencyKey: 'denied' });
  await spool.flush(async () => {
    throw Object.assign(new Error('denied'), { status: 403 });
  });
  assert.equal((spool.status()[0] as any).state, 'dead');
  spool.close();
});
