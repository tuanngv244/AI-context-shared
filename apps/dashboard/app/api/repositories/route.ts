import { NextRequest } from 'next/server';
export const dynamic = 'force-dynamic';
async function proxy(req: NextRequest) {
  const query = req.nextUrl.searchParams;
  const repoId = query.get('repoId');
  if (repoId && !/^[a-f0-9-]{36}$/i.test(repoId))
    return Response.json({ error: 'Invalid repository' }, { status: 400 });
  const path =
    req.method === 'POST' && query.get('action') === 'cleanup'
      ? `/v1/repositories/${repoId}/cleanup`
      : req.method === 'PATCH'
        ? `/v1/repositories/${repoId}`
        : query.get('candidates') === '1'
          ? '/v1/repositories/candidates'
          : '/v1/repositories';
  if ((req.method === 'PATCH' || query.get('action') === 'cleanup') && !repoId)
    return Response.json({ error: 'Repository required' }, { status: 400 });
  try {
    const result = await fetch(
      `${process.env.SCE_API_INTERNAL_URL ?? 'http://127.0.0.1:8787'}${path}`,
      {
        method: req.method,
        headers: {
          authorization: req.headers.get('authorization') ?? '',
          'content-type': 'application/json',
        },
        body: ['POST', 'PATCH'].includes(req.method) ? await req.text() : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      },
    );
    return new Response(await result.text(), {
      status: result.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return Response.json(
      { error: 'SCE chưa sẵn sàng. Kiểm tra terminal npm run dev.' },
      { status: 503 },
    );
  }
}
export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
