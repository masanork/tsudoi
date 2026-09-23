import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [environment, ...wranglerArgs] = process.argv.slice(2);
if (!environment || wranglerArgs.length === 0) {
  console.error("Usage: node scripts/wrangler-env.mjs <environment> <wrangler command and args>");
  process.exit(2);
}

const envPaths = [`.env.${environment}.local`, `.env.${environment}`];
const envPath = envPaths.find((path) => existsSync(path));
if (!envPath) {
  console.error(`Missing ${envPaths[0]}. Copy .env.${environment}.example and fill in the deployment values.`);
  process.exit(2);
}

const values = parseDotEnv(readFileSync(envPath, "utf8"));
const source = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
const selected = source.env?.[environment];
if (!selected) {
  console.error(`Environment '${environment}' is not defined in wrangler.jsonc.`);
  process.exit(2);
}

const config = { ...source, ...selected };
delete config.env;
config.name = values.WORKER_NAME || config.name;
if (values.CLOUDFLARE_ACCOUNT_ID) config.account_id = values.CLOUDFLARE_ACCOUNT_ID;
config.vars = {
  ...config.vars,
  ...(values.APP_ORIGIN ? { APP_ORIGIN: values.APP_ORIGIN } : {}),
  ...(values.RP_ID ? { RP_ID: values.RP_ID } : {}),
  ...(values.RP_NAME ? { RP_NAME: values.RP_NAME } : {}),
  ...(values.OIDC_ISSUER ? { OIDC_ISSUER: values.OIDC_ISSUER } : {}),
  ...(values.OIDC_CLIENT_ID ? { OIDC_CLIENT_ID: values.OIDC_CLIENT_ID } : {}),
  ...(values.OIDC_KEY_ID ? { OIDC_KEY_ID: values.OIDC_KEY_ID } : {}),
  ...(values.EMAIL_FROM ? { EMAIL_FROM: values.EMAIL_FROM } : {}),
};

const database = config.d1_databases?.[0];
if (database) {
  if (values.D1_DATABASE_NAME) database.database_name = values.D1_DATABASE_NAME;
  if (values.D1_DATABASE_ID) database.database_id = values.D1_DATABASE_ID;
  else delete database.database_id;
}
const bucket = config.r2_buckets?.[0];
if (bucket && values.R2_BUCKET_NAME) bucket.bucket_name = values.R2_BUCKET_NAME;
const kv = config.kv_namespaces?.[0];
if (kv) {
  if (values.KV_NAMESPACE_ID) kv.id = values.KV_NAMESPACE_ID;
  else delete kv.id;
}
if (values.QUEUE_NAME && config.queues) {
  for (const producer of config.queues.producers ?? []) producer.queue = values.QUEUE_NAME;
  for (const consumer of config.queues.consumers ?? []) consumer.queue = values.QUEUE_NAME;
}
if (values.EMAIL_SENDER && config.send_email?.[0]) config.send_email[0].allowed_sender_addresses = [values.EMAIL_SENDER];
if (values.ROUTE_PATTERN) config.routes = [{ pattern: values.ROUTE_PATTERN, custom_domain: true }];
else delete config.routes;

const outputPath = resolve(`.wrangler.${environment}.generated.json`);
writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
try {
  const result = spawnSync("npx", ["wrangler", "--config", outputPath, ...wranglerArgs], {
    stdio: "inherit",
    env: { ...process.env, ...values },
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  unlinkSync(outputPath);
  process.exit(status);
} finally {
  if (existsSync(outputPath)) unlinkSync(outputPath);
}

function parseDotEnv(contents) {
  const result = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

function parseJsonc(contents) {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < contents.length; index += 1) {
    const char = contents[index];
    const next = contents[index + 1];
    if (lineComment) { if (char === "\n") { lineComment = false; output += char; } continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; index += 1; } continue; }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; output += char; }
    else if (char === "/" && next === "/") { lineComment = true; index += 1; }
    else if (char === "/" && next === "*") { blockComment = true; index += 1; }
    else output += char;
  }
  return JSON.parse(output.replace(/,\s*([}\]])/g, "$1"));
}
