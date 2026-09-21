import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["test/worker/**"], coverage: { provider: "v8", reporter: ["text", "json-summary", "lcov"], include: ["web/src/lib/e2ee.ts"], thresholds: { lines: 100, functions: 100, statements: 90, branches: 60 } } } });
