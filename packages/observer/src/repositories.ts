import { realpath, readdir, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
export async function gitMetadata(path: string) {
  const git = async (...args: string[]) => {
    try {
      return (
        await exec('git', ['-C', path, '-c', 'core.fsmonitor=false', ...args], {
          timeout: 2000,
          maxBuffer: 128 * 1024,
        })
      ).stdout.trim();
    } catch {
      return undefined;
    }
  };
  return {
    root: await git('rev-parse', '--show-toplevel'),
    branch: await git('symbolic-ref', '--short', 'HEAD'),
    headSha: await git('rev-parse', 'HEAD'),
    remote: await git('remote', 'get-url', 'origin'),
  };
}
export function canonicalRemote(remote: string | undefined, path: string) {
  if (remote) {
    const ssh = remote.match(/^(?:[^@\s]+@)?([\w.-]+):([^\s]+)$/);
    if (ssh && !remote.includes('://'))
      return `https://${ssh[1].toLowerCase()}/${ssh[2].replace(/\.git$/, '')}`;
    try {
      const u = new URL(remote);
      if (['https:', 'http:', 'ssh:'].includes(u.protocol))
        return `https://${u.hostname.toLowerCase()}${u.pathname.replace(/\.git$/, '').replace(/\/$/, '')}`;
    } catch {}
  }
  return 'local:' + createHash('sha256').update(path).digest('hex');
}
export function inside(path: string, root: string) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel));
}
export class RepositoryResolver {
  constructor(public roots: string[]) {}
  async resolve(name: string) {
    for (const configured of this.roots) {
      let root: string, path: string;
      try {
        root = await realpath(configured);
        path = await realpath(resolve(root, name));
      } catch {
        continue;
      }
      if (!inside(path, root)) continue;
      try {
        await stat(resolve(path, '.git'));
      } catch {
        continue;
      }
      const metadata = await gitMetadata(path);
      if (!metadata.root || (await realpath(metadata.root)) !== path) continue;
      return {
        name: basename(path),
        remoteUrl: canonicalRemote(metadata.remote, path),
        localPath: path,
        defaultBranch: metadata.branch ?? 'main',
      };
    }
    throw Object.assign(
      new Error(
        'Không tìm thấy repo trong thư mục workspace đã cấu hình. Chọn tên từ danh sách gợi ý.',
      ),
      { statusCode: 404 },
    );
  }
  async candidates() {
    const names = new Set<string>();
    for (const configured of this.roots) {
      let entries;
      try {
        entries = await readdir(configured, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        try {
          await stat(resolve(configured, entry.name, '.git'));
          names.add(entry.name);
        } catch {}
      }
    }
    return [...names].sort();
  }
}
