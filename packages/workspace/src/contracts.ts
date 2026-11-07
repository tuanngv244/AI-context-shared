import { z } from 'zod';
export const addRepositorySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[\p{L}\p{N}_.-]+$/u)
      .refine((x) => x !== '.' && x !== '..', 'Use a repository name'),
    historyDays: z.number().int().min(1).max(3650).default(30),
  })
  .strict();
export const memorySchemas = {
  context_repositories: z.object({}).strict(),
  context_recall: z
    .object({
      repository: z.string().trim().min(1).max(120).optional(),
      cwd: z.string().min(1).max(2000).optional(),
      query: z.string().max(2000).default(''),
      branch: z.string().max(256).optional(),
      limit: z.number().int().min(1).max(50).default(12),
      tokenBudget: z.number().int().min(500).max(16000).default(5000),
    })
    .strict(),
  context_checkpoint: z
    .object({
      repository: z.string().min(1).max(120).optional(),
      cwd: z.string().min(1).max(2000).optional(),
      provider: z.enum(['codex', 'claude']),
      externalSessionId: z.string().min(1).max(200),
      summary: z.string().min(1).max(16000),
      pendingWork: z.array(z.string().max(2000)).max(50).default([]),
      blockers: z.array(z.string().max(2000)).max(50).default([]),
      branch: z.string().max(256).optional(),
      commitSha: z
        .string()
        .regex(/^[a-f0-9]{7,64}$/)
        .optional(),
      idempotencyKey: z.string().min(1).max(200),
    })
    .strict()
    .refine((x) => x.repository || x.cwd, 'Supply repository or cwd'),
};
export type MemoryToolName = keyof typeof memorySchemas;

export const cleanupSchema = z
  .object({
    olderThanDays: z.number().int().min(1).max(3650).default(30),
    preview: z.boolean().default(true),
    cutoff: z.string().datetime().optional(),
    confirmation: z.string().min(1).max(120).optional(),
  })
  .strict()
  .refine(
    (x) => x.preview || !!(x.cutoff && x.confirmation),
    'Preview and confirm the repository before deleting history',
  );
