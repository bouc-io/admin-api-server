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

Interactive docs are available at `/api-docs` when `NODE_ENV !== production`.

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
| `NODE_ENV` | `development` | `development` enables `/api-docs`; `production` disables it |
| `LOG_LEVEL` | `info` | Pino level: `trace`/`debug`/`info`/`warn`/`error` |
| `DATABASE_URL` | `postgresql://admin:admin@localhost:5432/admindb` | Postgres connection string |
| `ENCRYPTION_KEY` | `<32-byte key>` | Encrypts stored LLM provider API keys |
| `KEYCLOAK_ADMIN_URL` / `KEYCLOAK_REALM` | `https://sso.pik8s.internal` / `users` | Keycloak admin API for org/user sync |
| `AGENT_API_URL` / `MEMORY_API_URL` / `CHATBOT_API_URL` | `https://api.pik8s.internal` | Downstream service endpoints |
| `OLLAMA_URL` | `https://api.pik8s.internal/ollama` | LLM endpoint for provider tests |
| `ALLOW_SELF_SIGNED_CERTS` | `true` | Accept self-signed certs (local/dev clusters) |

See [`.env.example`](./.env.example) for the full reference.

## License

[Elastic License 2.0](./LICENSE) — source-available; not OSI open source.
