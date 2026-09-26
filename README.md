# PolykatoikiaOS — Koinoxrista Building Maintenance SaaS

Web SaaS for Greek apartment-building (*polykatoikia*) shared-expense management: **millismata (‰) billing**, **Viva Wallet + Stripe/MercadoPago** payments (card / IRIS / PIX / SEPA), **assembly voting**, **RFP marketplace**, **arrears automation**, and **local AI copilot**. One responsive dashboard whose navigation adapts to the signed-in role (`ADMIN` | `RESIDENT` | `PROVIDER` | `ACCOUNTANT` | `BUILDING_OWNER` | `PLATFORM_ADMIN`).

> Stack locked: **Angular 22 + NestJS 11 + PostgreSQL 16 + Prisma 6**. See [`docs/PLAN.md`](docs/PLAN.md) (phases 0–18), [`docs/FEATURE_PLAN.md`](docs/FEATURE_PLAN.md) (next 20), [`docs/INTERNATIONAL_PLAN.md`](docs/INTERNATIONAL_PLAN.md) and [`docs/AI_LOCAL_FEATURES_GR.md`](docs/AI_LOCAL_FEATURES_GR.md) for the full roadmap.

## Features

**Billing & allocation**
- **Koinoxrista engine** — categories with strategies (`MILIMES` / `UNITS` / `CUSTOM` / `RADIATORS` / `ELEVATOR_FLOORS` / `METERS` / `SQUARE_METERS` / `SHARE_FRACTION` / `HEADCOUNT`), `splitByLargestRemainder` guarantees Σ shares ≡ total. Heating by radiator count; elevator by floor (ground-floor exemption); water/heat by meter consumption.
- **Monthly invoicing & recurring** — `POST /api/invoices/run` + `RecurringExpense` templates (`POST /buildings/:id/recurring/generate`, idempotent via `lastPeriod`).
- **Annual statements & budgets** — printable `GET /api/statements` + `BudgetLine` planned-vs-actual compare.

**Payments, treasury & compliance**
- **PSP abstraction** — `Viva` (GR, card + IRIS), `Stripe`/`StripeJP` (EU/US/EU) and `MercadoPago` (BR/MX/AR/CL/CO/PE) behind `PspAdapter`; `PaymentOrder` checkout, webhook reconciliation (`POST /api/payments/webhook/:provider` with server-side re-verification), IRIS QR + deep-link.
- **Arrears & automation** — `buildArrears()` buckets, `LateFeeCharge` (FLAT/PERCENT, cap, waive), `PaymentPlan` (2–24 δόσεις), email (Resend) + SMS (≤160 chr Greek) reminders via `SchedulerService` crons (`JobRun` ledger, `JOB_SCHEDULER_ENABLED`).
- **Treasury / Reserve / Levies** — `TreasuryAccount`/`Entry`, `ReserveFund` contributions & drawdowns, `ExtraordinaryLevy` with `LevyShare` (MILIMES/UNITS/SQUARE_METERS/SHARE_FRACTION).
- **myDATA (ΑΑΔΕ, GR only)** — `MyDataInvoice` with synthetic MARKs (offline) or live `SendInvoiceDocs` + `POST /api/mydata/reconcile`; generation fails closed unless `MYDATA_VAT_RATE_BPS` is explicitly configured. Non-GR buildings do not use this adapter; live AADE validation remains external QA.
- **Bank & open-banking** — tolerant GR-bank CSV parser + `BankConnection`/`ImportedTransaction` feed (offline fixture or GoCardless skeleton), confidence-scored `suggestMatches` → `apply`.

**Governance & marketplace**
- **Voting & assemblies** — `MILLIMES_MAJORITY` | `HEADCOUNT`, `Ballot` per `unit`, immutable tally, agenda `AgendaItem`, attendance/proxy `Attendance`, live ‰ quorum meter, auto-close `*/10 * * * *` (`scheduler vote_close`), printable `πρακτικό` + **AI draft** (`GET /votes/:id/praktiko/draft` via local LLM).
- **RFP marketplace + technician directory** — `Job` (`ADMIN_RFP`|`RESIDENT_REPORT`) → `Bid` → `WorkLog` → rating; `GET /api/providers?trade=&city=&minRating=&q=`; featured slots & `JobCommission` (take-rate).
- **Announcements, meters, inspections** — `Announcement` feed with Q&A comments, `Meter`/`MeterReading`, `BuildingAsset` + `MaintenanceSchedule` → `InspectionRecord` (photo, result OK/NG).

**Platform & ops**
- **Documents** — per-building file registry (`storage.service.ts`) — `LocalDiskStorage` (default `.data/uploads`) or `S3Storage` (`STORAGE_DRIVER=s3`, SSE-AES256, bucket/prefix, fallback to disk), role-gated reads, `MAX_UPLOAD_BYTES=10MB`.
- **Multi-building & access** — `Membership` rows (user↔building↔role), header switcher (`POST /api/auth/switch-building`), per-admin `AdminPermission` matrix, `AccountantAccess` read-only seat + `απολογισμός`.
- **Public API & webhooks** — `X-Api-Key` (sha256, `ApiKey`) under `/api/public/v1` + `/api/public/v2`, `WebhookEndpoint`/`WebhookDelivery` with HMAC `X-Polyk-Signature` + retries.
- **Subscriptions & growth** — tiers `Basic €1.50 / Pro €2.25 / Premium €3.00` per unit/month, 60-day trial, annual −15%, `PlatformInvoice`, referral codes (`?ref=` → `ReferralCredit`), partner leads, shop `Product`/`ProductOrder` (stock race fixed via `updateMany … stock gte qty`).
- **Security & compliance** — `helmet`, `CORS_ORIGINS`, global `ValidationPipe`, `ThrottlerModule` per-route (`login 5/15m`, `register 3/h`, `checkout 10/m`, `webhook 100/m`, `assistant 10/day`, `api-key 60/m`), `LoginLockoutService` (423 after 5 fails), 2FA TOTP + recovery codes, `AuditLog` hash chain (`_hash/_prev` via `audit.service.ts`), GDPR export/erasure, CCPA/LGPD-ready, `GET /api/audit/verify`.
- **Notifications & PWA** — in-app `Notification` inbox + Web Push (VAPID) + `RealtimeService` (SSE `notification.created`, `vote.closed`, `assembly.attendance`), scheduler-fed `check-anomalies` → admin push, installable PWA shell.
- **Ops & observability** — scheduled billing jobs (`SchedulerService` 7 crons), `BuildingWeeklySnapshot` + `AlertRule` (`COLLECTION_RATE`/`ARREARS_WOW`/`DEFECTS_7D`/`PSP_FAILURES`), arrears **forecast** (`GET /buildings/:id/kpi/forecast` local tabular risk), Sentry (api+web), `GET /health` (db ping → degraded), GitHub Actions CI + nightly `pg_dump` backup (`backup.yml`, S3 SSE-KMS, 30-day retention, `docs/RUNBOOK.md` RTO≤2h).
- **Local AI for Greek market** — `assistant` lexical RAG with `faq.el.md` (Ν.1221/1981, Ν.4756/2020, myDATA, ρόπα), `AI_LOCAL_ONLY=true` with loopback-only compatible endpoints, request timeouts, context/question PII redaction, and a deterministic defect classifier (`POST /buildings/:id/assistant/classify-defect`). NL→SQL is intentionally unregistered/unavailable until a parameterized, allowlisted read-only implementation exists. Greek email/SMS draft and myDATA error translation remain planned/partial — see [`docs/AI_LOCAL_FEATURES_GR.md`](docs/AI_LOCAL_FEATURES_GR.md).
- **Mobile (Expo)** — `apps/mobile` (Expo 51, React Native 0.74) with `Login` (2FA), `Balance` (`/invoices/mine`, `formatMoney` with `currency/locale`), `Votes`, `Shop` (`catalog`/`orders`), `Feed` (`/feed`), tab navigation, `AsyncStorage` session restore, `@polykatoikia/mobile:test` 7 tests green.
- **International** — `Building.market`/`currency`/`pspProvider` (`market.ts` registry GR/EU/US/CA/MX/BR/AR/CL/CO/PE/JP), explicit market/currency/provider compatibility validation, zero-decimal CLP/COP/JPY support, `formatMoney(cents,{currency,locale})` + `MoneyPipe`, and `SUPPORTED_LANGUAGES=[el,en,zh,pt,ja,es]`.

## Stack

| Layer | Tech |
|---|---|
| Monorepo | Nx 23.1.1 · pnpm 10 · `nx.json` plugins (playwright/eslint/webpack/jest) |
| Frontend | Angular 22 standalone + signals + lazy routes · Tailwind 4 · Vitest · `i18n.service` (`es` added), `MoneyPipe` |
| Backend | NestJS 11 · Prisma 6 · PostgreSQL 16 (`pgvector` is a future/optional extension, not required by current lexical RAG) |
| Shared | `libs/shared` (`market.ts`, `money`, `ownership-weights`, DTOs) |
| Auth | `@nestjs/jwt` · `bcryptjs` · TOTP (`two-factor`) · `LoginLockoutService` |
| Payments | `Viva` + `Stripe`/`StripeJP` + `MercadoPago` adapters behind `PspAdapter` |
| Files | `LocalDiskStorage` / `S3Storage` (`@aws-sdk/client-s3` 3.1121) |
| AI | Ollama/local OpenAI-compatible endpoint (optional) · guarded provider routing/timeouts · lexical `faq.el.md` RAG · deterministic `assistant/defect-classifier`; embedding/pgvector and NL→SQL remain unavailable |
| Email/SMS | Resend (console fallback) · `SmsSender` HTTP gateway |
| Tests | Jest 30 (≈1137 api), Vitest 4 · Playwright e2e |
| Infra | Docker Compose (db) · Render/Railway (api) · static hosting (web) |

## Project Structure

```
apps/
  api/                 # NestJS REST API (global prefix /api, port 3000)
    prisma/
      schema.prisma    # Single source of truth — Building carries market/currency/pspProvider + 80+ models
      seed.ts          # 12-unit Thessaloniki demo (Σ millimes=1000) + second building
    src/
      auth/            # register/login/refresh/me, 2FA, switch-building, JwtStrategy, RolesGuard
      scheduler/       # 7 crons (invoice_run/recurring/late_fee/reminders/maintenance/compliance/vote_close) + JobRun ledger
      buildings/ units/ ownerships/ expense-categories/ expenses/ invoices/ recurring/ late-fees/ payment-plans/
      payments/        # Viva/Stripe/MercadoPago adapters, PaymentOrder, webhook (building-scoped), arrears
      treasury/ reserve/ payouts/ partners/ referrals/ marketplace/ shop/ suppliers/ supplier-invoices/ (Greek OCR)
      votes/ assembly/ # tally-vote, quorum, agenda, attendance, πρακτικό + AI draft
      jobs/ providers/ inspections/ maintenance/ meters/ announcements/ documents/ (S3)
      mydata/ exports/ pdf/ branding/ campaigns/ points/ permissions/ security/ (throttle/lockout) / health/
      audit/           # hash chain (_hash/_prev) + verify
      kpi/             # snapshots, rules, check-anomalies, forecastArrears
      assistant/       # lexical RAG (faq.el.md), guarded llm-provider, PII redaction, defect-classifier; NL→SQL unregistered
      common/ tenant.ts
  web/                 # Angular 22 SPA (port 4200, proxy /api → :3000)
    src/app/
      core/            # auth.service, i18n.service (es/el/en/ja/pt/zh), money.pipe, role.guard
      layout/          # NAV_GROUPS per Role (ADMIN/BUILDING_OWNER include scheduler/settings)
      pages/
        admin/         # overview, units, categories, expenses, run, arrears, votes, agenda, attendance, praktiko, jobs, directory, documents, recurring, bank-import, analytics, invites, compliance, budgets, scheduler, payouts, supplier-invoices, treasury, reserve, occupancy, transfer, import, late-fees, accountants, billing, open-banking, meters, announcements, payment-plans, branding, commissions, partners, referrals, maintenance, legal, settings (market/currency/PSP)
        balance/       # resident balance + statement + payment-plan
        resident/      # votes, defects, feed
        provider/      # provider portal
        accountant/    # home + apologismos
        auth/          # login (2FA), register
      ui/              # money.pipe, format, help-tour, vote-tally
    public/i18n/       # el/en/ja/pt/zh/es (129 keys) + sw.js PWA shell
  mobile/              # Expo 51 (@polykatoikia/mobile) — Login/Balance/Votes/Shop/Feed, tab nav, 2FA, formatMoney
  api-e2e/ web-e2e/    # Playwright
libs/
  shared/              # building, market, money, ownership-weights, period, votes, etc.
```

## Prerequisites

- Node 20+ and **pnpm** (`npm i -g pnpm` or `corepack enable pnpm`)
- Docker & Docker Compose (for local Postgres) — or any managed Postgres URL (Neon/Supabase) + optional S3 bucket + Ollama for local AI

## Quick Start

```bash
cp .env.example .env          # edit secrets (see Environment below)
docker compose up -d db       # Postgres 16 on :5432, pg_isready
pnpm install

# DB
pnpm exec prisma generate --schema=apps/api/prisma/schema.prisma
pnpm exec prisma migrate dev --schema=apps/api/prisma/schema.prisma
pnpm nx run api:seed          # or: npx prisma db seed (seed.ts → demo buildings)

# Dev servers (two terminals)
pnpm nx serve api              # http://localhost:3000/api (Swagger at /api/docs when not prod)
pnpm nx serve web              # http://localhost:4200 (proxies /api → :3000)

# Local AI (optional, Greek)
ollama serve & ollama pull meltemi:7b && ollama pull bge-m3
AI_LOCAL_ONLY=true LLM_PROVIDER=openai-compatible LLM_API_URL=http://localhost:11434/v1/chat/completions LLM_MODEL=meltemi:7b pnpm nx serve api

# Mobile
pnpm nx run @polykatoikia/mobile:start  # Expo

# Tests
pnpm nx run-many -t test --all          # 1137 tests (≈101 suites)
pnpm nx run-many -t lint --all
```

No Docker? Set `DATABASE_URL` to a managed Postgres URL and skip `docker compose up`.

Production-ish build:

```bash
pnpm nx run api:build
pnpm nx run web:build          # → dist/apps/web/browser
pnpm nx serve-static web       # preview built frontend on :4200
```

## Environment

All vars documented in [`.env.example`](.env.example):

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | `postgresql://postgres:postgres@localhost:5432/polykatoikiaos?schema=public` |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | HS256 secrets | `change-me` |
| `PSP_VIVA_BASE_URL` / `PSP_VIVA_CLIENT_ID` / `PSP_VIVA_CLIENT_SECRET` | Viva Wallet demo | `https://demo.vivapayments.com` |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `MERCADOPAGO_ACCESS_TOKEN` | International PSPs (missing → mock) | `""` |
| `BUILDING_*` via `PATCH /buildings/:id/settings` | `market` (`GR` default), `currency` (`EUR`), `pspProvider` (`viva`), `invoiceRegistrationNo` (`T+13`) | — |
| `RESEND_API_KEY` / `MAIL_FROM` | Resend; empty → console | `""` / `no-reply@polykatoikiaos.gr` |
| `APP_BASE_URL` / `WEB_APP_URL` | Public web origin | `http://localhost:4200` |
| `MYDATA_MODE` / `MYDATA_BASE_URL` / `MYDATA_USER_ID` / `MYDATA_CLIENT_SECRET` / `MYDATA_SUBSCRIPTION_KEY` / `MYDATA_VAT_RATE_BPS` | Greek-only AADE myDATA (`offline` synthetic MARKs or credentialed `live`); VAT rate is explicit | `offline` / unset VAT |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push (`npx web-push generate-vapid-keys`) | `""` |
| `SENTRY_DSN` / `SENTRY_ENVIRONMENT` | Error tracking | `""` |
| `CORS_ORIGINS` / `SWAGGER_ENABLED` | Security; Swagger auto outside prod | `http://localhost:4200` |
| `THROTTLE_LIMIT` / `THROTTLE_TTL_MS` + per-route `RATE_LOGIN_LIMIT` etc. | Global 100/min, `login 5/15m`, `register 3/h`, `checkout 10/m`, `webhook 100/m`, `assistant 10/day` | — |
| `STORAGE_DRIVER` / `DOCS_DIR` / `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_PREFIX` | Document store (`local` → `.data/uploads`, `s3` → S3/R2/MinIO SSE-AES256) | `local` |
| `SMS_MODE` / `SMS_HTTP_URL` / `SMS_HTTP_AUTH` | SMS gateway (`console` default) | `console` |
| `OPENBANKING_MODE` / `GC_SECRET_ID` / `GC_SECRET_KEY` | `offline` fixture or GoCardless | `offline` |
| `COMMISSION_RATE_BPS` / `COMMISSION_CAP_CENTS` | Marketplace take-rate (400=4%, cap €500) | `400`/`50000` |
| `POSTHOG_KEY` / `POSTHOG_HOST` | Analytics (empty → disabled) | `""` / `https://eu.i.posthog.com` |
| `LLM_PROVIDER` / `LLM_API_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_TIMEOUT_MS` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Copilot routing and hard request timeout; `LLM_TIMEOUT_MS` is an optional deployment setting; `AI_LOCAL_ONLY=true` accepts loopback/private compatible endpoints only | `auto` / `http://localhost:11434/v1/chat/completions` / `ollama` / `meltemi:7b` / `15000` |
| `AI_LOCAL_ONLY` / `PGVECTOR_ENABLED` / `EMBEDDING_MODEL` / `AI_TOKEN_BUDGET_PER_BUILDING` | Greek local guard (true = never call hosted); vector/budget flags are documented future controls and are not active RAG features | `false`/`false`/`bge-m3`/`50000` |
| `JOB_SCHEDULER_ENABLED` | Run crons on single replica only | `false` |
| `PORT` | API port | `3000` |

Frontend reads `apps/web/src/environments/environment.ts` → `apiUrl: '/api'` (proxied via `apps/web/proxies/proxy.conf.json`).

## Database & Seed

```bash
# generate client
pnpm exec prisma generate --schema=apps/api/prisma/schema.prisma

# create & apply migration
pnpm exec prisma migrate dev --name <change> --schema=apps/api/prisma/schema.prisma

# reset + reseed
pnpm exec prisma migrate reset --schema=apps/api/prisma/schema.prisma

# seed only
pnpm nx run api:seed
```

Seed (`apps/api/prisma/seed.ts:27`):

- Building **Εγνατία 12, Thessaloniki** — 12 units `Α1..Α6 / Β1..Β6` millimes `[120,120,110,110,90,90,70,70,60,60,50,50]` (Σ=1000) + radiator counts.
- Second building **Τσιμισκή 8** — 4 units `Γ1..Γ4` (multi-building switcher, `admin@demo.gr` member of both).
- Users: `admin@demo.gr` / `Admin1234!` (ADMIN), `owner@demo.gr` / `Owner1234!` (BUILDING_OWNER), `accountant@demo.gr` / `Accountant123!` (ACCOUNTANT, both buildings), `platform@demo.gr` / `Platform1234!` (PLATFORM_ADMIN), `maria@demo.gr` / `Password123!` (RESIDENT), `provider@demo.gr` / `Password123!` (PROVIDER `Υδραυλικός`), `electrician@demo.gr` / `Password123!` (PROVIDER `Ηλεκτρολόγος`).
- Categories `Καθαριότητα` (MILIMES), `Ανελκυστήρας` (MILIMES), `Ρεύμα κοινόχρηστο` (UNITS), `Θέρμανση` (RADIATORS) + expenses & shares via `splitByLargestRemainder` (`apps/api/src/prisma/split-by-largest-remainder.ts:16`).
- Invoice run via `aggregateRun` (`apps/api/src/invoices/run-invoices.ts:1`) + vote `Αντικατάσταση ανελκυστήρα` + job `Επισκευή αντλίας`.

## API Overview

Global prefix `api` (`apps/api/src/main.ts:13`). Auth `Authorization: Bearer <accessToken>` + refresh cookie. Role guards on every mutation.

| Module | Base route | Notes |
|---|---|---|
| `auth` | `/api/auth` | `POST register/login/login/2fa/refresh/switch-building/change-password/change-email`, `GET me/buildings`, `POST 2fa/*` |
| `assistant` | `/api/buildings/:id/assistant` | `POST query` (lexical RAG, 10/day, Greek), `POST classify-defect` (local `Υδραυλικά`/`high`); NL→SQL is not registered |
| `assembly` | `/api/votes/:id` | `GET agenda`, `POST agenda`, `PATCH/DELETE agenda/:id`, `GET/POST attendance`, `GET praktiko`, `GET praktiko/draft` (local LLM) |
| `buildings` | `/api/buildings` | `POST`, `GET mine`, `PATCH :id/settings` (`market/currency/pspProvider/invoiceRegistrationNo`) |
| `units` | `/api/units` | `POST/GET/PATCH/DELETE`, `squareMeters`/`shareFraction` for `SQUARE_METERS`/`SHARE_FRACTION` |
| `expense-categories` | `/api/expense-categories` | `MILIMES/UNITS/CUSTOM/RADIATORS/ELEVATOR_FLOORS/METERS/SQUARE_METERS/SHARE_FRACTION/HEADCOUNT` |
| `expenses` | `/api/expenses` | creates `Share` rows via largest-remainder |
| `invoices` | `/api/invoices` | `POST run`, `GET mine`, `GET :id`, `GET :id/pdf` (locale/currency-aware pdfkit; optional explicitly configured font) |
| `payments` | `/api/payments` | `POST checkout/:invoiceId` (psp by building), `POST webhook/:provider`, `GET arrears`, `GET invoices/mine/pdf` |
| `reminders` | `/api/reminders` | `POST run`/`POST preview` (Resend/SMS), Greek `≤160chr` |
| `exports` | `/api/exports` | `GET ledger.csv`, `GET receipt/:invoiceId` |
| `votes` | `/api/votes` | `POST`, `POST :id/ballots`, `GET :id/tally`, auto-close via scheduler |
| `jobs` | `/api/jobs` | `POST /jobs`, `POST :id/bids`, `POST :id/work-logs`, `POST buildings/:id/defects`, `POST :jobId/convert` |
| `providers` | `/api/providers` | `GET ?trade=&city=&minRating=&q=` + `GET :userId` |
| `notifications` | `/api/notifications` | `GET`, `POST read`, `POST push/subscriptions` + SSE `/realtime/events` |
| `documents` | `/api/documents` | `POST upload` (S3/local), `GET`, `GET :id/download` (stream or presigned), `DELETE` |
| `mydata` | `/api/mydata` | `POST generate`, `GET ?period=`, `GET xml`, `POST reconcile` |
| `kpi` | `/api/buildings/:id/kpi` | `GET snapshots`, `POST snapshot`, `POST backfill`, `GET/PUT rules`, `POST check-anomalies`, `GET forecast` (local risk) |
| `shop` | `/api/buildings/:id/shop` | `GET products/catalog`, `POST products`, `POST orders` (race-fixed), `GET orders` |
| `supplier-invoices` | `/api/buildings/:id/supplier-invoices` | `GET`, `POST manual`, `POST import-json`, `POST import-pdf` (OCR `ΑΦΜ`), `POST match`, `GET stats` |
| `subscriptions` | `/api/subscriptions` | tier change, `marketCurrency()` pricing, `PlatformInvoice` |
| `gdpr` | `/api/gdpr` | `GET export`, `POST delete-me` (anonymize, keep FKs) |
| `audit` | `/api/audit` | filterable + `GET verify` hash chain (`_hash/_prev`) |
| `buildings` | `/api/buildings/:id/kpi` | see `kpi` above |
| `treasury/reserve/levy` | `/api/...` | `treasury`, `reserve`, `levy` ledgers |
| `scheduler` | `/api/admin/scheduler` | `GET runs`, `POST trigger` (BUILDING_OWNER) + 7 crons |

Invariants: Σ shares = total; every table `buildingId`-scoped; `@@unique([unitId,period])` for `Invoice`; `Ballot` per `(voteId,unitId)`; audit append-only with hash verification.

## Web Routes

| Path | Guard | Page |
|---|---|---|
| `/login`, `/register` | public | `LoginPage` (2FA), `RegisterPage` (`?invite=` + `?ref=`) |
| `/admin` (+ `units/categories/expenses/run/arrears/votes/jobs/documents/subscription/audit/directory/recurring/bank-import/analytics/invites/compliance/budgets/scheduler/payouts/supplier-invoices/treasury/reserve/occupancy/transfer/import/late-fees/accountants/billing/open-banking/meters/announcements/payment-plans/branding/commissions/partners/referrals/maintenance/legal/settings`) | `ADMIN`/`BUILDING_OWNER` | `Admin*Page` (scheduler + market/currency/PSP `admin/settings`) |
| `/accountant` | `ACCOUNTANT` | `AccountantHomePage` + `apologismos` |
| `/settings/security` | authed | `SecuritySettingsPage` (password/email/2FA, session revoke) |
| `/balance` (+ `/statement`, `/plan`) | `RESIDENT` | `BalancePage` (IRIS QR + `MoneyPipe` `currency`/`locale` + `es` support) + `ResidentStatement`/`PaymentPlan` |
| `/votes`, `/feed`, `/defects` | `RESIDENT` | `ResidentVotesPage`, `ResidentFeedPage`, `ResidentDefectsPage` |
| `/provider` | `PROVIDER` | `ProviderPortalPage` |
| `/admin/scheduler` | `BUILDING_OWNER` | `AdminSchedulerPage` (JobRun ledger) |

`homeRedirectGuard` + `role.guard.ts` (`homeForRole` supports `BUILDING_OWNER`→`/admin`, `PLATFORM_ADMIN`→`/admin/billing`). `auth.interceptor.ts` 401→refresh. `MoneyPipe` (`apps/web/src/app/ui/money.pipe.ts:11`) resolves `currency` from `AuthService.currentUser()` + `LOCALE_TO_INTL[locale]`.

## Scripts (Nx)

```bash
pnpm nx show projects                    # api, web, shared, @polykatoikia/mobile, api-e2e, web-e2e
pnpm nx serve api                        # NestJS dev (webpack, NODE_ENV=development)
pnpm nx serve web                        # Angular dev server :4200
pnpm nx run @polykatoikia/mobile:start   # Expo web
pnpm nx build api && pnpm nx build web   # production builds → dist/
pnpm nx test api                         # Jest (1137 tests, 104 suites) + run per-project or…
pnpm nx run-many -t test --all           # api+web+shared+mobile
pnpm nx lint web                         # ESLint + angular-eslint
pnpm nx e2e api-e2e                      # Playwright
pnpm exec prisma studio --schema=apps/api/prisma/schema.prisma
```

## Testing

- **Unit** — split engine (largest-remainder property Σ=total), `aggregateRun`, `buildArrears`, `tallyVote`, `buildLedger`, `formatMoney` (`el-GR`/`en-US`/`pt-BR`/`es-ES`), `MoneyPipe` (building currency), `LocalDiskStorage`/`S3Storage` (fallback), `defect-classifier` (`Υδραυλικά/high`), `kpi.forecast` (tabular risk), `praktiko/draft` fallback, `AuditService` hash chain — all adjacent `*.spec.ts`.
- **Integration** — API/web/mobile/shared counts vary by concurrent worktree; run the Nx target and use its output rather than treating the historical counts above as a certification.
- **E2E** — Playwright `admin creates month → resident pays → webhook marks paid` + vote lifecycle.
- **AI golden-set** — the 50-question Greek evaluation described in `docs/AI_LOCAL_FEATURES_GR.md` is **not run in the default test target**; record it as external/staging QA rather than a passing local suite.

```bash
pnpm nx run-many -t test --all
pnpm nx e2e web-e2e
pnpm exec jest apps/api/src/assistant --no-coverage # lexical RAG + provider safety + classifier/redaction
```

## Deployment Notes

- API expects `DATABASE_URL`, `JWT_*_SECRET`, `PSP_*`, `RESEND_API_KEY`, `S3_*` in env; no hard-coded secrets. `STORAGE_DRIVER=s3` → `@aws-sdk/client-s3` SSE-AES256, `DOCS_DIR` fallback `.data/uploads`.
- Frontend static `dist/apps/web/browser` — set `apiUrl` in `environment.production.ts` if not proxied.
- Health: `pg_isready` (compose) + `GET /api/health` (db ping → `degraded`) + `GET /api/audit/verify`.
- Backups: `docker` or managed Postgres; nightly `pg_dump --format=custom` via `.github/workflows/backup.yml` (S3 SSE-KMS, 30-day retention) + monthly `transfer` JSON per building — `docs/RUNBOOK.md` RPO≤24h RTO≤2h.
- AI local: `ollama serve` + `ollama pull meltemi:7b` + `AI_LOCAL_ONLY=true`; lexical FAQ retrieval works without a vector database. `bge-m3`/`pgvector` are future optional extensions, not a shipped dependency.

## Roadmap

Phases per [`docs/PLAN.md`](docs/PLAN.md) and [`docs/FEATURE_PLAN.md`](docs/FEATURE_PLAN.md) — the core/commercial feature scaffolding is present, but implementation and external QA status varies by module; do not treat the phase labels as a certification of live integrations.

**International (`docs/INTERNATIONAL_PLAN.md`) — partial:** the shared registry now covers GR/EU/US/CA/MX/BR/AR/CL/CO/PE/JP, currency minor units (including CLP/COP/JPY), and cross-field settings validation. Live PSP rails, country-specific tax adapters, and schema-backed tax breakdowns remain follow-ups.

**AI local (`docs/AI_LOCAL_FEATURES_GR.md`) — partial:** lexical RAG, local-only URL enforcement/timeouts, PII redaction, and deterministic defect triage are implemented. pgvector embeddings, OCR/forecast quality targets, and NL→SQL are not complete; NL→SQL is deliberately unavailable/unregistered. AADE live credentials and provider sandbox flows remain external QA.

## Known schema / integration follow-ups

This change set does **not** edit Prisma schema or migrations. Before enabling non-GR tax filing or fully automated myDATA, the data layer still needs an explicit invoice VAT/net breakdown (or a validated source), market/country constraints, and an auditable e-invoice adapter boundary. Ownership `periodEnd` and any new money/tax fields also need service-layer wiring and migration review. The current myDATA path intentionally fails closed when `MYDATA_VAT_RATE_BPS` is absent. Live AADE submission/reconciliation, PSP webhooks, and any pgvector embedding store also require external credentials and staging QA; unit tests do not certify those integrations.

## License

MIT
