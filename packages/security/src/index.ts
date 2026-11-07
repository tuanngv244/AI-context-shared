import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Principal } from '../../contracts/src/index.js';
export function redact(value: unknown): any {
  if (typeof value === 'string')
    return value
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
        '[REDACTED]',
      )
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16})\b/g,
        '[REDACTED]',
      )
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
      .replace(
        /((?:password|passwd|secret|token|api[_-]?key|secret_access_key)["']?\s*[=:]\s*)(["'])([\s\S]*?)\2/gi,
        '$1"[REDACTED]"',
      )
      .replace(/((?:password|secret|token|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
      .replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(?:password|passwd|secret|client[_-]?secret|(?:access|refresh|auth|id)[_-]?token|token|authorization|api[_-]?key)$/i.test(
          k,
        )
          ? '[REDACTED]'
          : redact(v),
      ]),
    );
  return value;
}
export class AccessError extends Error {
  statusCode = 403;
  constructor() {
    super('Access denied');
  }
}
export function requirePermission(p: Principal, permission: string) {
  if (!p.permissions.includes(permission)) throw new AccessError();
}
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
export async function authenticate(header: string | undefined): Promise<Principal> {
  const token = header?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
  if (process.env.AUTH_MODE === 'local') {
    const secret = process.env.SCE_LOCAL_TOKEN;
    if (!secret || secret.length < 32)
      throw new Error('Local token must have at least 32 characters');
    const hash = (s: string) => createHash('sha256').update(s).digest();
    if (!timingSafeEqual(hash(secret), hash(token)))
      throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });
    return {
      subject: 'local-owner',
      orgId: process.env.SCE_LOCAL_ORG_ID!,
      permissions: ['read', 'write', 'coordinate', 'manage'],
    };
  }
  const issuer = process.env.AUTH_ISSUER_URL,
    audience = process.env.AUTH_AUDIENCE,
    uri = process.env.AUTH_JWKS_URL;
  if (!issuer || !audience || !uri || !uri.startsWith('https://'))
    throw new Error('OIDC configuration required');
  jwks ??= createRemoteJWKSet(new URL(uri));
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience,
      algorithms: ['RS256', 'ES256'],
    });
    if (!payload.sub || typeof payload.org_id !== 'string') throw new Error('Missing identity');
    return {
      subject: payload.sub,
      orgId: payload.org_id,
      permissions:
        typeof payload.scope === 'string'
          ? payload.scope
              .split(' ')
              .filter((x) => ['read', 'write', 'coordinate', 'manage'].includes(x))
          : [],
    };
  } catch {
    throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });
  }
}
