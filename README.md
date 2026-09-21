# tsudoi

> Lightweight event roster and check-in software for organizers and attendees.

tsudoi manages venue-based rosters, advance registration, walk-in check-in, QR tickets, participant self-service, and privacy-first organizer communication on Cloudflare.

## Codebase health

CI records Worker, UI, and test line counts on every push to `main`. Dashboard data and charts are committed in [`stats/`](stats/).

![Codebase size](stats/codebase-growth.svg)
![Unit test coverage](stats/coverage-trend.svg)

Snapshot: [`stats/stats.md`](stats/stats.md)

---

## Current implementation

- Multi-tenant organizations, events, venues, and role-scoped API tokens
- Configurable registration fields and roster data model
- Individual ticket tokens and atomic duplicate-safe check-in
- Attendee Passkey registration and session issuance
- E2EE message ciphertext, key-envelope, and encrypted attachment storage boundaries

See the full product and technical requirements in [`docs/specification.md`](docs/specification.md).

## Configuration and deployment

`wrangler.jsonc` is a public template. It contains no account-specific resource IDs or production domains. The default environment is intended for local development and the Deploy to Cloudflare button; `staging` and `production` are named environments with separate resource names.

Before deploying `staging` or `production`, copy `.env.<environment>.example` to `.env.<environment>.local` and fill in the account, resource, domain, and verified sender values. The local file is ignored by git. `RP_ID` must be the hostname used by `APP_ORIGIN`.

Resource IDs are intentionally omitted from the public template. The deploy wrapper generates an ignored, environment-specific Wrangler config from the local env file. Leave an ID empty to let Wrangler provision a resource, or provide an existing resource ID. Routes and verified email senders are also supplied by the local env file.

```bash
# Local
npm run db:migrate:local
npm run dev

# Deploy after creating .env.<environment>.local
npm run deploy:staging
npm run db:migrate:staging
npm run deploy:production
npm run db:migrate:production
```

Apply the remote migration after the first deployment has provisioned the selected D1 database. The Deploy to Cloudflare button continues to use the public template; environment-specific deploys use the local wrapper.

## Local development

```bash
npm install
npm --prefix web install
npm run db:migrate:local
npm run build
npm run dev
```

Local bindings use Wrangler's local storage. Do not put API tokens, private keys, or other secrets in `wrangler.jsonc`; use Wrangler secrets or ignored `.dev.vars` files instead.

## Health dashboard

```bash
npm run stats:save
```

All dashboard and chart labels are English to match this README.
