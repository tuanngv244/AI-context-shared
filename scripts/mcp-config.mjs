#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const packagedNode = resolve(
  root,
  'node_modules',
  'node',
  'bin',
  process.platform === 'win32' ? 'node.exe' : 'node',
);
const command = existsSync(packagedNode) ? packagedNode : process.execPath;
const bridge = resolve(root, 'scripts', 'mcp-bridge.mjs');
const token = resolve(root, '.local', 'dev-token');
const server = {
  command,
  args: [bridge],
  env: { SCE_URL: process.env.SCE_URL ?? 'http://127.0.0.1:8787/mcp', SCE_TOKEN_FILE: token },
};
if (process.argv[2] === 'claude')
  console.log(JSON.stringify({ mcpServers: { sce: server } }, null, 2));
else
  console.log(
    `[mcp_servers.sce]\ncommand = ${JSON.stringify(command)}\nargs = [${JSON.stringify(bridge)}]\nstartup_timeout_sec = 20\n\n[mcp_servers.sce.env]\nSCE_URL = ${JSON.stringify(server.env.SCE_URL)}\nSCE_TOKEN_FILE = ${JSON.stringify(token)}\n`,
  );
