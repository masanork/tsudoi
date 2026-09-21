import { applyD1Migrations, env } from "cloudflare:test";

declare const __TSUDOI_D1_MIGRATIONS__: Parameters<typeof applyD1Migrations>[1];

await applyD1Migrations(env.DB, __TSUDOI_D1_MIGRATIONS__);
