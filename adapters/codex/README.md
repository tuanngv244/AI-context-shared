# Codex adapter

Use `sce run codex [arguments]` as the portable lifecycle wrapper and configure the same `/mcp` endpoint in your installed client. Run `codex --version` and `codex mcp add --help` before configuring. No Codex native hook schema is assumed. The wrapper observes start/end and Git metadata; tool-level capture requires an explicitly configured hook or `sce hook tool-completed`. It does not inspect transcripts. `sce sync` pulls durable deltas; call it at safe synchronization points. No background process can inject context into an independent agent.
