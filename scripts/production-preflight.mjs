#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 2;

export async function runPreflight(origin, { fetchImpl = fetch, deploymentVersion = null, commit = null } = {}) {
  const base = validateOrigin(origin);
  const checks = [];
  const check = async (name, path, validate, options) => {
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetchImpl(new URL(path, base), {
          ...options,
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const result = await validate(response);
        if (result.ok) {
          checks.push({ name, ok: true, status: response.status, attempts: attempt });
          return result.value;
        }
        lastError = result.reason;
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) {
        lastError = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "request_failed";
      }
    }
    checks.push({ name, ok: false, error: lastError ?? "check_failed" });
    return null;
  };

  await check("health", "/api/health", async (response) => {
    if (response.status !== 200) return { ok: false, reason: `http_${response.status}` };
    try {
      const body = await response.json();
      return body?.ok === true ? { ok: true } : { ok: false, reason: "unexpected_health_response" };
    } catch { return { ok: false, reason: "invalid_json" }; }
  });

  const html = await check("spa", "/", async (response) => {
    if (response.status !== 200) return { ok: false, reason: `http_${response.status}` };
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) return { ok: false, reason: "unexpected_content_type" };
    const body = await readLimitedText(response, 1_000_000);
    if (body === null) return { ok: false, reason: "html_too_large" };
    const assets = findLocalAssets(body, base);
    if (!assets.length) return { ok: false, reason: "no_local_static_asset_reference" };
    if (assets.length > 20) return { ok: false, reason: "too_many_local_static_assets" };
    return { ok: true, value: assets };
  });

  if (html) {
    for (let index = 0; index < html.length; index += 1) {
      const assetPath = html[index];
      await check(`static_asset_${index + 1}`, assetPath, async (response) => {
        if (response.status !== 200) return { ok: false, reason: `http_${response.status}` };
        const type = response.headers.get("content-type") ?? "";
        const extension = new URL(assetPath, base).pathname.toLowerCase().split(".").at(-1);
        return extension === "css" ? type.includes("text/css")
          ? { ok: true } : { ok: false, reason: "unexpected_asset_content_type" }
          : type.includes("javascript") ? { ok: true } : { ok: false, reason: "unexpected_asset_content_type" };
      });
    }
  }
  else checks.push({ name: "static_asset", ok: false, error: "spa_check_failed" });

  for (const [name, path, expected] of [
    ["oauth_protected_resource", "/.well-known/oauth-protected-resource/mcp", (body) => body.resource === `${base}/mcp` && Array.isArray(body.authorization_servers) && body.authorization_servers.includes(base)],
    ["oauth_authorization_server", "/.well-known/oauth-authorization-server", (body) => body.issuer === base && body.authorization_endpoint === `${base}/oauth/authorize` && body.token_endpoint === `${base}/oauth/token`],
  ]) {
    await check(name, path, async (response) => {
      if (response.status !== 200) return { ok: false, reason: `http_${response.status}` };
      try { return expected(await response.json()) ? { ok: true } : { ok: false, reason: "metadata_mismatch" }; }
      catch { return { ok: false, reason: "invalid_json" }; }
    });
  }

  await check("mcp_requires_authentication", "/mcp", async (response) => {
    if (response.status !== 401) return { ok: false, reason: `expected_401_got_${response.status}` };
    const challenge = response.headers.get("www-authenticate") ?? "";
    const resourceMetadata = challenge.match(/(?:^|,)\s*resource_metadata="([^"]+)"/i)?.[1];
    return /^Bearer\b/i.test(challenge) && resourceMetadata === `${base}/.well-known/oauth-protected-resource/mcp`
      ? { ok: true }
      : { ok: false, reason: "missing_bearer_challenge" };
  }, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "preflight", method: "initialize", params: {} }),
  });

  return {
    generatedAt: new Date().toISOString(),
    origin: base,
    deploymentVersion: deploymentVersion || null,
    deploymentVersionSource: deploymentVersion ? "operator_supplied" : "not_supplied",
    gitCommit: commit || localCommit(),
    gitCommitSource: commit ? "operator_supplied" : "local_checkout",
    deploymentIdentityVerified: false,
    readOnly: true,
    passed: checks.every((item) => item.ok),
    checks,
  };
}

function findLocalAssets(html, base) {
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)=["']([^"']+)["'][^>]*>/gi)];
  const assets = new Set();
  for (const match of refs) {
    try {
      const url = new URL(match[1], base);
      if (url.origin === base && (/\.(?:js|mjs|css)$/i.test(url.pathname))) assets.add(`${url.pathname}${url.search}`);
    } catch { /* Ignore malformed asset references. */ }
  }
  return [...assets];
}

async function readLimitedText(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

function validateOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("--origin must be an absolute URL"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("--origin must be an HTTPS origin (HTTP is allowed for localhost)");
  }
  return url.origin;
}

function localCommit() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return "unknown"; }
}

function parseArgs(args) {
  const result = { origin: null, output: null, deploymentVersion: null, commit: null };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (!["--origin", "--output", "--deployment-version", "--commit"].includes(key) || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error("Usage: node scripts/production-preflight.mjs --origin https://host [--deployment-version VALUE] [--commit SHA] [--output report.json]");
    }
    result[{ "--origin": "origin", "--output": "output", "--deployment-version": "deploymentVersion", "--commit": "commit" }[key]] = args[++index];
  }
  if (!result.origin) throw new Error("--origin is required");
  return result;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write("Read-only deployed-worker checks. Usage: node scripts/production-preflight.mjs --origin https://host [--deployment-version VALUE] [--commit SHA] [--output report.json]\n--deployment-version and --commit are operator-supplied candidate labels; neither is verified against the deployed Worker. Without --commit, gitCommit reports this local checkout's full HEAD. deploymentIdentityVerified is always false. No Wrangler config is generated or modified.\n");
      return;
    }
    const report = await runPreflight(args.origin, args);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) await writeFile(args.output, serialized, { mode: 0o600 });
    process.stdout.write(serialized);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
