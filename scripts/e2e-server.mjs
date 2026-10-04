import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

// Each test run gets a fresh local DB; never use a staging/production config.
mkdirSync(".wrangler/e2e", { recursive: true });
const state = mkdtempSync(resolve(".wrangler/e2e/run-"));
const cli = resolve("node_modules/wrangler/bin/wrangler.js");
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run("npm", ["run", "build"]);
run(process.execPath, [cli, "d1", "migrations", "apply", "DB", "--local", "--persist-to", state]);
const server = spawn(process.execPath, [cli, "dev", "--local", "--persist-to", state,
  "--ip", "127.0.0.1", "--port", "4173", "--var", "APP_ORIGIN:http://localhost:4173", "--var", "RP_ID:localhost"], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("error", (error) => { console.error(error.message); process.exit(1); });
server.on("exit", (code) => process.exit(code ?? 0));
