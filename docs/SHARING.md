# Sharing the source

Create a source snapshot from the project directory:

```sh
npm run export:common
```

The command creates `common/` with source code, migrations, synthetic tests, configuration examples, and documentation. Publish the **contents** of that directory as your GitHub repository.

The exporter excludes local databases, tokens, environment files other than `.env.example`, agent settings, session logs, dependency directories, build output, and test reports. It checks for the current installation's paths/token and recognized credential patterns before completing. It refuses to overwrite an existing export.

Documentation is copied directly from the source so exported instructions stay current. No installation history or generated audit manifest is included. The checks cannot identify every private project name or sensitive sentence; review any new fixtures and documentation before sharing.

## Installing a shared copy

```sh
npm ci
npm run dev
```

Each installation generates its own database and token. Generate MCP settings on the recipient's machine with `npm run mcp:config`; do not copy settings generated on another machine.

## Publishing from the working directory

`.gitignore` excludes runtime data and private settings, while `.dockerignore` keeps them out of Docker build contexts. Prefer the exported snapshot when sharing an installation that has already been used.

This exporter does not copy or rewrite Git history. If publishing an existing Git repository, review its history separately: ignore rules do not remove files from earlier commits. The source is distributed under the [MIT license](../LICENSE).
