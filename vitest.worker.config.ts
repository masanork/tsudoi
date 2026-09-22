import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  define: { __TSUDOI_D1_MIGRATIONS__: JSON.stringify(migrations) },
  test: {
    include: ["test/worker/**/*.test.ts"],
    setupFiles: ["test/worker/setup.ts"],
    coverage: { provider: "istanbul", reporter: ["text", "json-summary", "lcov"], include: ["src/index.ts"] },
  },
});
