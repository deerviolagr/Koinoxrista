# API E2E

The suite is intentionally serial and uses a real PostgreSQL database. Before
running it, apply migrations and seed the same database used by the API:

```bash
export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/polykatoikia_e2e?schema=public'
pnpm exec prisma migrate deploy --schema=apps/api/prisma/schema.prisma
(cd apps/api && pnpm exec prisma db seed --schema=prisma/schema.prisma)
```

Start the API separately on port 3000, then run:

```bash
pnpm nx run api-e2e:e2e
```

`E2E_API_URL`/`E2E_HOST` and `E2E_PORT` may override the default
`http://127.0.0.1:3000/api`. The test target raises only the local rate-limit
budgets; it does not reset or drop the database. The suite uses the seeded demo
accounts and cleans the rows it creates. No PSP or push credentials are needed:
the API uses its mock Viva adapter and console push sender when credentials are
absent.
