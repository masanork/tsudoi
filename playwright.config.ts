import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:4173", browserName: "chromium", trace: "retain-on-failure" },
  webServer: { command: "node scripts/e2e-server.mjs", url: "http://127.0.0.1:4173/api/health", reuseExistingServer: false, timeout: 120_000 },
});
