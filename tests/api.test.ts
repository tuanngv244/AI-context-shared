import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../apps/api/src/app.js';
import { authenticate } from '../packages/security/src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
test('HTTP authentication and origin checks reject before data access', async () => {
  process.env.AUTH_MODE = 'local';
  process.env.SCE_LOCAL_TOKEN = 'a'.repeat(40);
  process.env.SCE_LOCAL_ORG_ID = '11111111-1111-4111-8111-111111111111';
  const app = buildApp();
  const health = await app.inject({ method: 'GET', url: '/health/live' });
  assert.equal(health.statusCode, 200);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/v1/tools/context_search', payload: {} })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/tools/context_search',
        headers: { authorization: 'Bearer wrong' },
        payload: {},
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${'a'.repeat(40)}`, origin: 'https://evil.invalid' },
        payload: {},
      })
    ).statusCode,
    403,
  );
  await assert.rejects(() => authenticate('Bearer wrong'), /Invalid credentials/);
  await app.close();
});
test('official MCP client discovers all registered tools over Streamable HTTP', async () => {
  const called: any[] = [];
  const engine = {
    call: async (...args: any[]) => {
      called.push(args);
      return { items: [], untrusted: true };
    },
  };
  const app = buildApp(engine as any, async () => ({
    subject: 'test',
    orgId: 'org',
    permissions: ['read'],
  }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as any;
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)),
    );
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 12);
    const result = await client.callTool({
      name: 'context_search',
      arguments: { projectId: '22222222-2222-4222-8222-222222222222' },
    });
    assert.equal(result.isError, undefined);
    assert.equal(called[0][1], 'context_search');
  } finally {
    await client.close();
    await app.close();
  }
});
