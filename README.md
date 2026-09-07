# admin-api-server

Admin backend for the **bouc.io AI assistant platform**. Manages global and
org-level instructions, LLM providers & model assignments, organizations, MCP
server configs, and system settings. Its config is fetched at run time by
`agent-api-server` (LLM assignments) and consumed by `monochrome-admin-ui`.

Part of the [bouc.io AI platform](../../../documentation/getting-started/README.md#ai-assistant-platform).

## Role in the platform

`admin-api-server` owns the `/v1/admin/*` surface, guarded by `ADMIN_PORTAL_ROLES`
(Keycloak `realm_access.roles` or OAuth2-Proxy injected headers; see
`src/lib/roles.ts`). The internal `/v1/config/*` routes are unauthenticated for
service-to-service use (e.g. `agent-api-server` resolving LLM assignments).

## API overview

Interactive docs are served at `/api-docs` unconditionally, and the raw spec at
`/openapi.json`. Neither path is routed at the edge: access is gated by Istio and oauth2-proxy,
not by `NODE_ENV`. `apidocs-api-server` reads the spec in-mesh and aggregates it at
`api.<domain>/v1/api-docs`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness / readiness (unguarded) |
| CRUD | `/v1/admin/instructions` | Global / org instructions |
| CRUD | `/v1/admin/llm-providers` | LLM provider configs |
| CRUD | `/v1/admin/llm-assignments` | Per-phase model assignments |
| CRUD | `/v1/admin/organizations` | Organizations |
| CRUD | `/v1/admin/mcp-servers` | External MCP server configs |
| GET/PUT | `/v1/admin/system` | System settings |
| GET | `/v1/config/*` | Internal service-to-service config (unauthenticated) |

Mutating routes are validated with zod (`src/middleware/validate.ts`); errors
return the platform-standard `{ error: { code, message, details? } }` shape.

## Prerequisites

- Node.js 20+, npm
- PostgreSQL 14+ (Prisma-managed schema)

## Local development

```bash
npm install
cp .env.example .env        # then edit values
npm run db:generate         # Prisma client
npm run db:migrate          # dev migrations
npm run dev                 # nodemon
npm run build               # tsc → dist/
npm test                    # vitest
```

## Environment variables

| Variable | Example | Purpose |
|---|---|---|
| `PORT` | `3002` | HTTP listen port |
| `NODE_ENV` | `development` | Standard Node environment flag; it does NOT gate `/api-docs` |
| `LOG_LEVEL` | `info` | Pino level: `trace`/`debug`/`info`/`warn`/`error` |
| `DATABASE_URL` | `postgresql://admin:admin@localhost:5432/admindb` | Postgres connection string |
| `ENCRYPTION_KEY` | `<32-byte key>` | Encrypts stored LLM provider API keys |
| `KEYCLOAK_ADMIN_URL` / `KEYCLOAK_REALM` | `https://sso.pik8s.internal` / `users` | Keycloak admin API for org/user sync |
| `AGENT_API_URL` / `MEMORY_API_URL` / `CHATBOT_API_URL` | `https://api.pik8s.internal` | Downstream service endpoints |
| `OLLAMA_URL` | `https://api.pik8s.internal/ollama` | LLM endpoint for provider tests |
| `ALLOW_SELF_SIGNED_CERTS` | `true` | Accept self-signed certs (local/dev clusters) |

See [`.env.example`](./.env.example) for the full reference.

## Quality Gates

```bash
npm run lint          # ESLint (flat config)
npm run lint:fix      # auto-fix what is mechanically fixable
npm run format:check  # prettier, check only
npm run format        # prettier, write
npm run build         # tsc
npm test              # vitest, unit tests only
npm run test:ci       # vitest + coverage, writes junit.xml and coverage/
```

CI runs `lint` and `unit-test` from the shared `bouc-io/ci-templates` project.

- **Lint uses a warning ratchet.** ESLint *errors* always fail the build. Warnings are
  capped by `max_warnings` in `.gitlab-ci.yml`, currently **27** (25 no-explicit-any, 2 no-unused-vars). When you
  clean some up, lower the number. Never raise it, and never silence a rule repo-wide to
  get green.
- **Formatting is enforced.** `format:check` gates, using prettier defaults with no config
  file.

Two things to know before you ever run a bulk reformat here:

- **Prettier needs two passes.** It breaks some method chains across lines on the first
  pass and collapses them back on the second, so a single
  `npm run format` can leave `format:check` failing.
- **Prettier can wrap a statement out from under an `eslint-disable-next-line`.** That is
  why the suppressions in this repo use block `/* eslint-disable rule */ ... /* eslint-enable rule */`
  pairs, which survive re-wrapping. Keep them that way.

## License

[Elastic License 2.0](./LICENSE) — source-available; not OSI open source.
