import { z } from 'zod';
import { memorySchemas } from '../../workspace/src/contracts.js';
export const uuid = z.string().uuid();
export const scope = {
  projectId: uuid,
  repositoryIds: z.array(uuid).max(100).default([]),
  branch: z.string().min(1).max(256).default('main'),
  headSha: z
    .string()
    .regex(/^[a-f0-9]{7,64}$/)
    .optional(),
};
export const publishSchema = z
  .object({
    projectId: uuid,
    repoId: uuid.optional(),
    sessionId: uuid.optional(),
    taskId: uuid.optional(),
    kind: z.enum(['fact', 'decision', 'finding', 'proposal', 'convention', 'contract']),
    content: z.string().min(1).max(32000),
    branch: z.string().max(256).optional(),
    commitSha: z
      .string()
      .regex(/^[a-f0-9]{7,64}$/)
      .optional(),
    evidence: z
      .array(
        z.object({
          type: z.enum(['git', 'ci', 'test', 'human', 'agent']),
          reference: z.string().max(2000),
        }),
      )
      .max(50)
      .default([]),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict()
  .refine((x) => !x.repoId || !!x.branch, 'Repository claims require a branch');
export const eventSchema = z
  .object({
    projectId: uuid,
    repoId: uuid.optional(),
    sessionId: uuid.optional(),
    idempotencyKey: z.string().min(1).max(200),
    eventType: z.enum([
      'session.started',
      'session.heartbeat',
      'session.ended',
      'code.changed',
      'code.committed',
      'session.checkpoint',
    ]),
    payload: z
      .object({
        provider: z.enum(['claude', 'codex']).optional(),
        externalSessionId: z.string().max(200).optional(),
        machineId: z.string().max(200).optional(),
        branch: z.string().max(256).optional(),
        headSha: z
          .string()
          .regex(/^[a-f0-9]{7,64}$/)
          .optional(),
        files: z.array(z.string().max(1000)).max(500).optional(),
        summary: z.string().max(16000).optional(),
      })
      .strict(),
  })
  .strict();
export const toolSchemas = {
  ...memorySchemas,
  context_publish: publishSchema,
  context_search: z
    .object({
      ...scope,
      query: z.string().max(2000).default(''),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  context_bootstrap: z
    .object({
      ...scope,
      taskId: uuid.optional(),
      tokenBudget: z.number().int().min(100).max(16000).default(3000),
      lastCursor: z.string().regex(/^\d+$/).optional(),
    })
    .strict(),
  context_get: z.object({ ...scope, id: uuid }).strict(),
  context_get_changes: z
    .object({
      ...scope,
      cursor: z.string().regex(/^\d+$/).default('0'),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  context_ack_changes: z.object({ ...scope, cursor: z.string().regex(/^\d+$/) }).strict(),
  context_handoff: z
    .object({
      projectId: uuid,
      taskId: uuid,
      sessionId: uuid,
      summary: z.string().min(1).max(16000),
      pendingWork: z.array(z.string().max(2000)).max(100).default([]),
      blockers: z.array(z.string().max(2000)).max(100).default([]),
      idempotencyKey: z.string().min(1).max(200),
    })
    .strict(),
  context_get_task: z.object({ ...scope, taskId: uuid }).strict(),
  context_claim_task: z
    .object({
      projectId: uuid,
      taskId: uuid,
      sessionId: uuid,
      repoId: uuid,
      branch: z.string().min(1).max(256),
      resources: z.array(z.string().min(1).max(1000)).min(1).max(100),
      ttlSeconds: z.number().int().min(30).max(3600).default(300),
    })
    .strict(),
};
export type ToolName = keyof typeof toolSchemas;
export type Principal = { subject: string; orgId: string; permissions: string[] };
