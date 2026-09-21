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

## Local development

```bash
npm install
npm --prefix web install
npm run db:migrate:local
npm run build
npm run dev
```

The D1/R2/KV/Queue IDs in `wrangler.jsonc` are development placeholders. Create the Cloudflare resources and replace them before deployment.

## Health dashboard

```bash
npm run stats:save
```

All dashboard and chart labels are English to match this README.
