#!/usr/bin/env node
import { mkdir, readdir, readFile, copyFile, lstat, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative, join, extname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const source = fileURLToPath(new URL('../', import.meta.url));
const finalDestination = resolve(source, 'common');
const destination = resolve(source, '.common-export-' + randomUUID());
if (existsSync(finalDestination))
  throw new Error('common already exists. Move the previous export before creating a fresh one.');

const roots = [
  'apps',
  'packages',
  'cli',
  'adapters',
  'infra',
  'tests',
  'scripts',
  'docs',
  '.github',
  '.vscode',
];
const files = [
  'README.md',
  'LICENSE',
  'package.json',
  'package-lock.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'compose.yaml',
  'playwright.config.ts',
  '.env.example',
  '.npmrc',
  '.gitignore',
  '.dockerignore',
  '.prettierignore',
  '.prettierrc.json',
];
const excluded = new Set([
  'node_modules',
  'dist',
  '.local',
  '.git',
  '.codex',
  '.claude',
  '.agents',
  '.aws',
  '.ssh',
  '.kube',
  '.sce',
  '.DS_Store',
  'test-results',
  'playwright-report',
  'coverage',
  'common',
  'AGENTS.md',
  'CLAUDE.md',
  'COMMON-MANIFEST.json',
  'next-env.d.ts',
]);
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.css', '.sql', '.yaml', '.yml']);
const skip = (name) =>
  excluded.has(name) ||
  name.startsWith('.next') ||
  name.startsWith('.tsconfig-') ||
  name.startsWith('.common-export-') ||
  (name.startsWith('.env') && name !== '.env.example');
const isSourceFile = (name) =>
  extensions.has(extname(name)) || name.startsWith('Dockerfile') || name === '.env.example';

let copied = 0;
async function copyTree(path) {
  for (const item of await readdir(resolve(source, path), { withFileTypes: true })) {
    if (skip(item.name) || item.isSymbolicLink()) continue;
    const next = join(path, item.name);
    if (item.isDirectory()) await copyTree(next);
    else if (item.isFile() && isSourceFile(item.name)) {
      await mkdir(resolve(destination, path), { recursive: true });
      await copyFile(resolve(source, next), resolve(destination, next));
      copied++;
    }
  }
}

// Check private values without printing matching text or credentials.
const privateValues = [homedir(), source.replace(/[\\/]$/, '')];
try {
  const token = (await readFile(resolve(source, '.local/dev-token'), 'utf8')).trim();
  if (token.length >= 16) privateValues.push(token);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const forbidden = [
  /\/(?:Users|home)\/[A-Za-z0-9_.-]+(?:\/|\b)/,
  /\/(?:private\/)?(?:tmp|var\/folders)\/[A-Za-z0-9_.-]+\//,
  /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\s"'<>]+/i,
  /\bnpm_[A-Za-z0-9]{30,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
async function verify(dir = '') {
  for (const item of await readdir(resolve(destination, dir), { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isSymbolicLink() || skip(item.name))
      throw new Error('Export contains an excluded file or directory.');
    if (item.isDirectory()) await verify(path);
    else {
      const text = await readFile(resolve(destination, path), 'utf8');
      if (privateValues.some((value) => value && text.includes(value)))
        throw new Error('Export rejected: installation path or local token detected.');
      if (forbidden.some((pattern) => pattern.test(text)))
        throw new Error('Export rejected: private path or credential-like literal detected.');
    }
  }
}

await mkdir(destination);
try {
  for (const root of roots) {
    if (!existsSync(resolve(source, root))) continue;
    const info = await lstat(resolve(source, root));
    if (info.isDirectory() && !info.isSymbolicLink()) await copyTree(root);
  }
  for (const file of files) {
    const info = await lstat(resolve(source, file));
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Required export file must be a regular source file.');
    await copyFile(resolve(source, file), resolve(destination, file));
    copied++;
  }
  await verify();
  await rename(destination, finalDestination);
  console.log(
    JSON.stringify({
      status: 'created',
      directory: relative(source, finalDestination),
      files: copied,
      verification: 'passed',
    }),
  );
} catch (error) {
  await rm(destination, { recursive: true, force: true });
  throw error;
}
