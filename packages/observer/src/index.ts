import { opendir, open, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { WorkspaceService } from '../../workspace/src/service.js';
import { assistantSummary, metadataFromLine, type SessionMetadata } from './parser.js';
import { inside } from './repositories.js';
export class SessionObserver {
  private metadata = new Map<string, SessionMetadata>();
  private cursor = 0;
  constructor(
    private pool: pg.Pool,
    private roots: { provider: 'codex' | 'claude'; path: string }[],
  ) {}
  async files() {
    const files: { provider: 'codex' | 'claude'; path: string }[] = [];
    const walk = async (path: string, provider: 'codex' | 'claude', depth: number) => {
      if (depth > 5 || files.length >= 20000) return;
      let directory;
      try {
        directory = await opendir(path);
      } catch {
        return;
      }
      for await (const item of directory) {
        if (item.isSymbolicLink()) continue;
        const p = resolve(path, item.name);
        if (item.isDirectory()) await walk(p, provider, depth + 1);
        else if (item.isFile() && item.name.endsWith('.jsonl')) files.push({ path: p, provider });
      }
    };
    for (const root of this.roots) await walk(root.path, root.provider, 0);
    return files;
  }
  async scan() {
    const watches = (
      await this.pool.query(
        'SELECT * FROM repository_watches WHERE enabled=true AND local_path IS NOT NULL',
      )
    ).rows;
    if (!watches.length) return;
    const files = await this.files();
    // Prioritize modified files, plus a rotating bounded historical batch so old sessions aren't starved.
    const recent = await Promise.all(
      files.map(async (f) => ({ ...f, mtime: (await stat(f.path)).mtimeMs })),
    );
    recent.sort((a, b) => b.mtime - a.mtime);
    const batch = new Map<string, { provider: 'codex' | 'claude'; path: string }>();
    for (const file of recent.slice(0, 15)) batch.set(file.path, file);
    for (let i = 0; i < 40 && i < files.length; i++) {
      const file = files[(this.cursor + i) % files.length];
      batch.set(file.path, file);
    }
    this.cursor = files.length ? (this.cursor + 40) % files.length : 0;
    let failures = 0;
    for (const file of batch.values()) {
      try {
        await this.importFile(file, watches);
      } catch {
        failures++;
      }
    }
    for (const watch of watches)
      await this.pool.query(
        'UPDATE repository_watches SET last_scan_at=now(),observer_status=$2 WHERE repo_id=$1',
        [watch.repo_id, failures ? 'partial' : 'observing'],
      );
  }
  async importFile(file: { provider: 'codex' | 'claude'; path: string }, watches: any[]) {
    // Recover header metadata on restart; only read a bounded prefix before checking watched cwd.
    const handle = await open(file.path, 'r');
    try {
      const info = await handle.stat();
      const prefix = Buffer.alloc(Math.min(info.size, 256 * 1024));
      await handle.read(prefix, 0, prefix.length, 0);
      let metadata = this.metadata.get(file.path) ?? {};
      for (const raw of prefix.toString('utf8').split('\n').slice(0, 30)) {
        try {
          metadata = metadataFromLine(file.provider, JSON.parse(raw), metadata);
        } catch {}
      }
      if (!metadata.cwd || !metadata.externalSessionId) return;
      let cwd;
      try {
        cwd = await realpath(metadata.cwd);
      } catch {
        return;
      }
      const watch = watches.find((w) => inside(cwd, w.local_path));
      if (!watch) return;
      const cutoff = Date.now() - watch.history_days * 86400000;
      if (info.mtimeMs < cutoff) return;
      const key = createHash('sha256')
        .update(file.provider + ':' + file.path + ':' + watch.repo_id)
        .digest('hex');
      const state = (
        await this.pool.query(
          'SELECT byte_offset,skipping_line FROM observer_offsets WHERE source_hash=$1',
          [key],
        )
      ).rows[0];
      let offset = Number(state?.byte_offset ?? 0);
      if (offset > info.size) offset = 0;
      // At most 2 MiB/file/cycle. Complete-line boundaries preserve UTF-8 and partial writes.
      const buffer = Buffer.alloc(Math.min(info.size - offset, 2 * 1024 * 1024));
      if (!buffer.length) return;
      await handle.read(buffer, 0, buffer.length, offset);
      let consumed = 0;
      const service = new WorkspaceService(async () => {
        throw new Error('Host-only checkpoint writer');
      });
      const saveOffset = async (next: number, skipping: boolean) =>
        this.pool.query(
          'INSERT INTO observer_offsets(source_hash,byte_offset,skipping_line) VALUES($1,$2,$3) ON CONFLICT(source_hash) DO UPDATE SET byte_offset=EXCLUDED.byte_offset,skipping_line=EXCLUDED.skipping_line,updated_at=now()',
          [key, next, skipping],
        );
      let start = 0;
      if (state?.skipping_line && offset !== 0) {
        const newline = buffer.indexOf(10);
        if (newline < 0) {
          await saveOffset(offset + buffer.length, true);
          return;
        }
        start = newline + 1;
        consumed = start;
      }
      while (true) {
        const end = buffer.indexOf(10, start);
        if (end < 0) break;
        const lineOffset = offset + start;
        const raw = buffer.subarray(start, end).toString('utf8');
        consumed = end + 1;
        start = end + 1;
        let line;
        try {
          line = JSON.parse(raw);
        } catch {
          continue;
        }
        metadata = metadataFromLine(file.provider, line, metadata);
        // A session changing cwd to an unobserved repo must not leak text into its original repo.
        if (!metadata.cwd) continue;
        let messageCwd;
        try {
          messageCwd = await realpath(metadata.cwd);
        } catch {
          continue;
        }
        if (!inside(messageCwd, watch.local_path)) continue;
        const summary = assistantSummary(file.provider, line);
        if (!summary) continue;
        const occurred = line.timestamp ?? line.payload?.timestamp;
        if (!occurred || !Number.isFinite(Date.parse(occurred)) || Date.parse(occurred) < cutoff)
          continue;
        const db = await this.pool.connect();
        try {
          await db.query('BEGIN');
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            watch.project_id,
          ]);
          // Recheck watch inside transaction so pause takes effect even during a scan.
          const active = (
            await db.query('SELECT enabled FROM repository_watches WHERE repo_id=$1 FOR UPDATE', [
              watch.repo_id,
            ])
          ).rows[0];
          if (active?.enabled) {
            await service.checkpoint(
              db,
              {
                projectId: watch.project_id,
                repoId: watch.repo_id,
                provider: file.provider,
                externalSessionId: metadata.externalSessionId!,
                machineId: createHash('sha256').update(hostname()).digest('hex'),
                summary,
                branch: metadata.branch,
                commitSha: metadata.commitSha,
                sourceKey: `observer:${key}:${lineOffset}:${createHash('sha256').update(raw).digest('hex')}`,
                occurredAt: new Date(occurred).toISOString(),
              },
              'host-observer',
            );
          }
          await db.query('COMMIT');
        } catch (error) {
          await db.query('ROLLBACK');
          throw error;
        } finally {
          db.release();
        }
      }
      if (!consumed && buffer.length === 2 * 1024 * 1024) {
        // Discard oversized transcript lines without retaining their content. Continue at the next newline.
        await saveOffset(offset + buffer.length, true);
        return;
      }
      this.metadata.set(file.path, metadata);
      if (consumed) await saveOffset(offset + consumed, false);
    } finally {
      await handle.close();
    }
  }
}
