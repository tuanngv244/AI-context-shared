# API contract

All `/v1/*` and `/mcp` endpoints require `Authorization: Bearer <token>`. `Origin` is denied unless equal to `SCE_ALLOWED_ORIGIN`; non-browser clients omit it. Limit: 120 requests/minute per IP, body 128 KiB. Errors are redacted and validation errors never echo user payload.

POST `/v1/tools/<tool-name>` accepts the same JSON as MCP. POST `/mcp` uses official MCP SDK stateless Streamable HTTP JSON responses; GET returns 405. Every tool authorizes organization, membership, permission and repositories in a PostgreSQL transaction with scoped RLS settings.

| Tool                | Required inputs                                         | Optional/default inputs                                              |
| ------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| context_publish     | projectId, kind, content, idempotencyKey                | repoId (+branch required), sessionId, taskId, commitSha, evidence    |
| context_search      | projectId                                               | repositoryIds=[], branch=main, headSha, query='', limit=20           |
| context_bootstrap   | projectId                                               | repositoryIds, branch, headSha, taskId, tokenBudget=3000, lastCursor |
| context_get         | projectId, id                                           | repositoryIds, branch=main, headSha                                  |
| context_get_changes | projectId                                               | repositoryIds, branch, cursor='0', limit=50                          |
| context_ack_changes | projectId, cursor                                       | repositoryIds, branch, headSha                                       |
| context_handoff     | projectId, taskId, sessionId, summary, idempotencyKey   | pendingWork=[], blockers=[]                                          |
| context_get_task    | projectId, taskId                                       | repositoryIds, branch, headSha                                       |
| context_claim_task  | projectId, taskId, sessionId, repoId, branch, resources | ttlSeconds=300 (30–3600)                                             |

UUID inputs validated. `kind` = fact/decision/finding/proposal/convention/contract. Evidence entries `{type: git|ci|test|human|agent, reference: string}` are proposed evidence, never trusted verification. Unknown fields are rejected.

Search uses indexed PostgreSQL full-text over already authorized branch-compatible records. A nonempty repository list must all be authorized. Empty list means all authorized repositories, never all tenant data. Project-wide records remain visible to project members. Branch filters are conservative; no Git ancestry is inferred. If headSha supplied, committed facts require matching SHA; uncommitted proposed records remain explicitly proposed. Superseded/expired records are excluded; stale records preserve status.

Bootstrap packs complete items under a conservative UTF-8-byte content budget, preserving provenance. Envelope overhead is outside that budget; no model tokenizer integration is claimed. `truncated` signals candidate overflow. Task-specific handoffs appear under `activeTasks` for full-project readers. `lastCursor` is accepted for compatibility; changes are fetched separately with `context_get_changes`.

Deltas contain cursor/type/repository/time, not record bodies: re-pull context before acting. This intentionally supports notification-first synchronization. Branch is part of acknowledgment scope; deltas include any branch changes in authorized repositories so clients can invalidate broadly. Cursor is a decimal bigint string, not a JavaScript number. Acknowledgments are monotonic, keyed by subject/project/scope hash and cannot exceed the current visible cursor. Project-scoped writer advisory locks keep event commit order monotonic.

GET `/v1/notifications?projectId=<uuid>&cursor=0&repositoryIds=<comma-separated-uuids>` returns a bounded SSE `context.delta.available` response. Reconnect with returned cursor, or POST `context_get_changes` to poll. It is not a permanent Redis Pub/Sub subscription. Reconnect within the database retention window to retrieve retained events; see [retention](../RETENTION.md).

POST `/v1/events` accepts canonical `eventType`: session.started/session.heartbeat/session.ended/session.checkpoint/code.changed/code.committed; projectId, idempotencyKey required. Optional repoId/sessionId; payload whitelist: provider, externalSessionId, machineId, branch, headSha, files, summary. Session start requires provider/externalSessionId/machineId. Transaction stores redacted event + outbox exactly once. Idempotency keys must not be reused for different payloads (409). `code.committed` does not verify agent claims.

GET `/v1/projects/:projectId/dashboard` returns authorized sessions/tasks/records/handoffs/leases/audit, event metadata and pending/lag metrics. Token stays only in dashboard React memory; proxy forwards it to the internal API and disables caching. Context renders as escaped text.

## Workspace memory (v0.2)

Three additional MCP/REST tools accept names/cwd instead of UUIDs:

- `context_repositories {}` lists authorized watched repos.
- `context_recall {repository?,cwd?,query?,branch?,limit?,tokenBudget?}` returns recent session memories, provenance and branch-compatible code records. Omitting repository/cwd searches across the caller's authorized watched repos. `repository` and `cwd` are intersected, never used to bypass membership. History is labeled proposed and may span branches; code records need an explicit branch. The budget is a conservative UTF-8 content bound; envelope metadata is outside it.
- `context_checkpoint {repository? or cwd?,provider,externalSessionId,summary,pendingWork?,blockers?,branch?,commitSha?,idempotencyKey}` automatically registers the session and writes immutable memory/outbox atomically. Requires write permission and an enabled watch. Reused keys with changed payload return 409.

`GET /v1/repositories` lists watches. `GET /v1/repositories/candidates` lists local Git folder names. `POST /v1/repositories {name,historyDays?}` resolves a local folder and provisions a project/repo via an audited security-definer function. `PATCH /v1/repositories/:repoId {enabled}` pauses/resumes. Management requires the token's `manage` permission AND an organization admin membership, never merely a claimed org ID. The local owner is seeded as admin. There is no public org-admin provisioning route.

Only the host dev runtime supplies a repository resolver/observer. Production containers expose history/MCP but do not receive host mounts. Observer uses a local admin connection for durable offsets and checkpoint ingestion; HTTP runtime still runs under scoped RLS. Raw transcript lines, user prompts, tool outputs and reasoning are never persisted by the observer. Log formats are version-sensitive; Codex phase=final_answer/channel=final and supported Claude assistant-text forms are tested.

## Manual history cleanup

`POST /v1/repositories/:repoId/cleanup` accepts `{olderThanDays: 1..3650, preview: true}` and returns eligibleCount, eligibleBytes and an exact cutoff. To execute, send `preview:false`, the returned cutoff and `confirmation` equal to the repository name. Requires manage/write token permissions, organization admin role and scoped repository write membership. The operation deletes session memories only, updates the observer replay fence, emits a pruning delta and writes audit. Durable records/handoffs and pending events are preserved. Future/recent cutoffs and missing confirmation are rejected.
