import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
export class Spool {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS spool(id TEXT PRIMARY KEY,body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS local_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);",
    );
  }
  enqueue(id: string, body: unknown) {
    const size = this.db
      .prepare('SELECT count(*) AS n,coalesce(sum(length(body)),0) AS bytes FROM spool')
      .get() as any;
    if (size.n >= 10000 || size.bytes >= 50 * 1024 * 1024) throw new Error('Spool limit reached');
    this.db
      .prepare('INSERT OR IGNORE INTO spool(id,body,created_at) VALUES(?,?,?)')
      .run(id, JSON.stringify(body), Date.now());
  }
  async flush(send: (body: any) => Promise<void>, now = Date.now(), limit = 100) {
    const rows = this.db
      .prepare(
        "SELECT * FROM spool WHERE state IN ('pending','retrying') AND next_at<=? ORDER BY created_at LIMIT ?",
      )
      .all(now, limit) as any[];
    for (const row of rows) {
      try {
        await send(JSON.parse(row.body));
        this.db.prepare('DELETE FROM spool WHERE id=?').run(row.id);
      } catch (e: any) {
        const permanent = e?.status >= 400 && e?.status < 500 && ![408, 429].includes(e.status);
        const attempts = row.attempts + 1;
        this.db
          .prepare('UPDATE spool SET state=?,attempts=?,next_at=? WHERE id=?')
          .run(
            permanent ? 'dead' : 'retrying',
            attempts,
            now +
              Math.min(3600000, 1000 * 2 ** Math.min(attempts, 12)) +
              Math.floor(Math.random() * 1000),
            row.id,
          );
        if (!permanent) break;
      }
    }
  }
  status() {
    return this.db
      .prepare('SELECT state,count(*) AS count,min(created_at) AS oldest FROM spool GROUP BY state')
      .all();
  }
  get(key: string) {
    return (this.db.prepare('SELECT value FROM local_state WHERE key=?').get(key) as any)?.value;
  }
  set(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO local_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  close() {
    this.db.close();
  }
}
