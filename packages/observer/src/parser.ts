import { redact } from '../../security/src/index.js';
export type SessionMetadata = {
  cwd?: string;
  externalSessionId?: string;
  branch?: string;
  commitSha?: string;
};
export function metadataFromLine(
  provider: 'codex' | 'claude',
  line: any,
  current: SessionMetadata = {},
): SessionMetadata {
  if (provider === 'codex' && line.type === 'session_meta') {
    const p = line.payload ?? {};
    return {
      ...current,
      cwd: p.cwd,
      externalSessionId: p.id ?? p.session_id,
      branch: p.git?.branch,
      commitSha: p.git?.commit_hash,
    };
  }
  if (provider === 'codex' && line.type === 'turn_context')
    return { ...current, cwd: line.payload?.cwd ?? current.cwd };
  if (provider === 'claude')
    return {
      ...current,
      cwd: line.cwd ?? current.cwd,
      externalSessionId: line.sessionId ?? current.externalSessionId,
      branch: line.gitBranch ?? current.branch,
    };
  return current;
}
export function assistantSummary(provider: 'codex' | 'claude', line: any): string | undefined {
  let content: unknown;
  if (provider === 'codex') {
    // Only final assistant messages; never reasoning, user prompts, tool payloads or injected context.
    const p = line.payload;
    if (
      line.type !== 'response_item' ||
      p?.type !== 'message' ||
      p.role !== 'assistant' ||
      !(p.channel === 'final' || p.phase === 'final_answer')
    )
      return;
    content = p.content;
  } else {
    if (line.type !== 'assistant' || line.message?.role !== 'assistant' || line.isSidechain) return;
    // Ignore tool-use and error blocks. Some Claude log versions omit stop_reason.
    if (
      line.isApiErrorMessage ||
      line.message.content?.some((b: any) => b.type === 'tool_use') ||
      (line.message.stop_reason != null && line.message.stop_reason !== 'end_turn')
    )
      return;
    content = line.message.content;
  }
  if (!Array.isArray(content)) return;
  const text = content
    .filter(
      (x) => x && (x.type === 'text' || x.type === 'output_text') && typeof x.text === 'string',
    )
    .map((x) => x.text)
    .join('\n')
    .trim();
  if (!text) return;
  // Keep a bounded head/tail excerpt, never pretend this is an LLM-generated complete summary.
  const clean = redact(text) as string;
  const excerpt =
    clean.length > 6000
      ? clean.slice(0, 4000) + '\n[… phần giữa đã lược bớt …]\n' + clean.slice(-1800)
      : clean;
  return excerpt;
}
