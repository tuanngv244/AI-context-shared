# Configuration

Start with `npm run dev` for a local installation. It creates a token and database without a `.env` file. Set environment variables in the shell before starting the service; the local dev script does not load `.env` automatically.

## Local service

| Variable                  | Default                         | Purpose                                          |
| ------------------------- | ------------------------------- | ------------------------------------------------ |
| `SCE_WORKSPACE_ROOTS`     | Parent of the working directory | Directories containing Git repositories to watch |
| `SCE_DEV_DIR`             | `.local`                        | Persistent local database and token directory    |
| `API_PORT`                | `8787`                          | Local API and MCP port                           |
| `DASHBOARD_PORT`          | `3000`                          | Local dashboard port                             |
| `SCE_CODEX_SESSIONS_DIR`  | Client session directory        | Override the Codex session log location          |
| `SCE_CODEX_ARCHIVED_DIR`  | Client archive directory        | Override the Codex archived session location     |
| `SCE_CLAUDE_SESSIONS_DIR` | Client projects directory       | Override the Claude Code log location            |

These examples use generic relative directories; replace them with your own locations.

macOS / Linux:

```sh
SCE_WORKSPACE_ROOTS=../projects npm run dev

# Multiple workspace roots use a colon.
SCE_WORKSPACE_ROOTS=../projects:../examples npm run dev
```

Windows PowerShell:

```powershell
$env:SCE_WORKSPACE_ROOTS = "../projects;../examples"
npm run dev
```

## MCP bridge

`npm run mcp:config` prints a server entry for the default local setup. Add `-- claude` for JSON output. It references a token file instead of embedding a credential.

| Variable         | Default                                      | Purpose                         |
| ---------------- | -------------------------------------------- | ------------------------------- |
| `SCE_URL`        | `http://127.0.0.1:8787/mcp`                  | MCP endpoint used by the bridge |
| `SCE_TOKEN_FILE` | Generated entry points to `.local/dev-token` | Token file read by the bridge   |

If you change `API_PORT`, set `SCE_URL` when generating the entry. If you change `SCE_DEV_DIR`, update `SCE_TOKEN_FILE` in the generated entry to match. Regenerate paths after moving the installation. Keep generated entries private to your machine.

## Docker

Copy [`.env.example`](../.env.example) to `.env` and replace every credential placeholder. Each password must match its corresponding connection URL. Use URL-safe values or percent-encode passwords in connection URLs.

The Compose stack separates migration, API, and worker database roles. Local authentication uses a single owner. For a remote team, configure `AUTH_MODE=oidc`, `AUTH_ISSUER_URL`, `AUTH_JWKS_URL`, and `AUTH_AUDIENCE`, disable demo seeding, and provision organization/project memberships before use.

`.env` configures Compose interpolation. Host repository observation is available through the local dev runtime; the default containers have no host agent-log mounts.
