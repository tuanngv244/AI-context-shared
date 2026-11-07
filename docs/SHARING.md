# Publishing on GitHub

Publish this repository directly. The source, README, screenshots, documentation, and configuration examples are maintained together under the [MIT license](../LICENSE).

## Local data

`.gitignore` excludes local databases, tokens, environment files, agent settings, logs, dependency directories, build output, and test reports. `.dockerignore` keeps local data out of Docker build contexts. Keep `.env.example` as a template; use synthetic data for tests and screenshots.

Before publishing, review the files selected for commit:

```sh
git status --short
git diff --cached
```

Ignore rules do not remove files already tracked by Git or stored in earlier commits. Review existing history separately if it previously contained private data.

## Installing from GitHub

After cloning the repository, run:

```sh
npm ci
npm run dev
```

Each installation generates its own database and token. Generate MCP settings on the machine running SCE with `npm run mcp:config`; generated paths and token files belong to that installation.
