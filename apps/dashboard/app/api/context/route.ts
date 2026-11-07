import { NextRequest } from 'next/server';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
  const project = req.headers.get('x-project-id');
  if (!project || !/^[a-f0-9-]{36}$/i.test(project))
    return Response.json({ error: 'Invalid project' }, { status: 400 });
  try {
    const result = await fetch(
      `${process.env.SCE_API_INTERNAL_URL ?? 'http://127.0.0.1:8787'}/v1/projects/${project}/dashboard`,
      {
        headers: { authorization: req.headers.get('authorization') ?? '' },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      },
    );
    return new Response(await result.text(), {
      status: result.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return Response.json({ error: 'Service unavailable' }, { status: 503 });
  }
}
