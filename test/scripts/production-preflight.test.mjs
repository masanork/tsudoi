import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { runPreflight } from "../../scripts/production-preflight.mjs";

const cliPath = fileURLToPath(new URL("../../scripts/production-preflight.mjs", import.meta.url));

let server;
let origin;
let responses;

before(async () => {
  server = createServer((request, response) => {
    const configured = responses[request.url];
    if (!configured) { response.writeHead(404).end(); return; }
    response.writeHead(configured.status ?? 200, configured.headers ?? {});
    response.end(typeof configured.body === "function" ? configured.body(request) : configured.body ?? "");
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  origin = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 10_000 });

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function successfulResponses() {
  return {
    "/api/health": { headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) },
    "/": { headers: { "content-type": "text/html" }, body: '<html><link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script></html>' },
    "/assets/app.css": { headers: { "content-type": "text/css" }, body: "body{}" },
    "/assets/app.js": { headers: { "content-type": "text/javascript" }, body: "console.log('ok')" },
    "/.well-known/oauth-protected-resource/mcp": { headers: { "content-type": "application/json" }, body: JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }) },
    "/.well-known/oauth-authorization-server": { headers: { "content-type": "application/json" }, body: JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token` }) },
    "/mcp": { status: 401, headers: { "www-authenticate": `Bearer realm="tsudoi", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }, body: JSON.stringify({ error: "unauthorized" }) },
  };
}

test("passes the deployed read-only endpoint checks and records only safe metadata", { timeout: 10_000 }, async () => {
  responses = successfulResponses();
  const report = await runPreflight(origin, { deploymentVersion: "version-id", commit: "abc123" });
  assert.equal(report.passed, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.deploymentVersion, "version-id");
  assert.equal(report.deploymentVersionSource, "operator_supplied");
  assert.equal(report.gitCommit, "abc123");
  assert.equal(report.gitCommitSource, "operator_supplied");
  assert.equal(report.deploymentIdentityVerified, false);
  assert.deepEqual(report.checks.map((check) => check.name), ["health", "spa", "static_asset_1", "static_asset_2", "oauth_protected_resource", "oauth_authorization_server", "mcp_requires_authentication"]);
  assert.equal(JSON.stringify(report).includes("unauthorized"), false);
});

test("reports a failed security check without including response body contents", { timeout: 10_000 }, async () => {
  responses = successfulResponses();
  responses["/mcp"] = { status: 200, headers: { "www-authenticate": "Bearer" }, body: "sensitive response body" };
  const report = await runPreflight(origin, { commit: "abc123" });
  assert.equal(report.passed, false);
  const securityCheck = report.checks.find((check) => check.name === "mcp_requires_authentication");
  assert.equal(securityCheck.ok, false);
  assert.equal(JSON.stringify(report).includes("sensitive response body"), false);
});

test("rejects cross-origin OAuth metadata and challenge URLs and checks every referenced CSS asset", { timeout: 10_000 }, async () => {
  responses = successfulResponses();
  responses["/.well-known/oauth-protected-resource/mcp"] = {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: ["https://attacker.example"] }),
  };
  responses["/mcp"] = {
    status: 401,
    headers: { "www-authenticate": `Bearer resource_metadata="https://attacker.example/.well-known/oauth-protected-resource/mcp?next=${origin}/.well-known/oauth-protected-resource/mcp"` },
    body: "unauthorized",
  };
  responses["/assets/app.css"] = { status: 404, body: "missing" };
  const report = await runPreflight(origin, { commit: "candidate" });
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((check) => check.name === "oauth_protected_resource").error, "metadata_mismatch");
  assert.equal(report.checks.find((check) => check.name === "mcp_requires_authentication").error, "missing_bearer_challenge");
  assert.equal(report.checks.find((check) => check.name === "static_asset_1").error, "http_404");
  assert.equal(report.checks.find((check) => check.name === "static_asset_2").ok, true);
});

test("CLI entry point returns zero for a passing origin and one for a failed origin", { timeout: 10_000 }, async () => {
  responses = successfulResponses();
  const success = await runCli(["--origin", origin, "--commit", "operator-candidate"]);
  assert.equal(success.code, 0);
  const successReport = JSON.parse(success.stdout);
  assert.equal(successReport.gitCommit, "operator-candidate");
  assert.equal(successReport.gitCommitSource, "operator_supplied");
  assert.equal(successReport.deploymentIdentityVerified, false);

  responses["/mcp"] = { status: 200, body: "not authorized correctly" };
  const failure = await runCli(["--origin", origin]);
  assert.equal(failure.code, 1);
  const failureReport = JSON.parse(failure.stdout);
  assert.equal(failureReport.passed, false);
  assert.equal(failureReport.gitCommit.length, 40);
  assert.equal(failureReport.gitCommitSource, "local_checkout");
  assert.equal(failureReport.deploymentIdentityVerified, false);
  assert.equal(failure.stdout.includes("not authorized correctly"), false);
});

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("preflight CLI process timed out after 5 seconds"));
    }, 5_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
