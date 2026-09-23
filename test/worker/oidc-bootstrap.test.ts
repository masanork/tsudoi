import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/index";

afterEach(() => vi.unstubAllGlobals());

describe("OIDC first administrator", () => {
  it("requires the bootstrap code and creates one owner only after verified OIDC", async () => {
    const rpKeys = await generateKeyPair("ES256", { extractable: true });
    const opKeys = await generateKeyPair("ES256", { extractable: true });
    const clientId = crypto.randomUUID();
    const issuer = "https://mikaki.tossa.app";
    const origin = "https://tsudoi.example.com";
    const testEnv = Object.assign(Object.create(env), {
      APP_ORIGIN: origin, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_KEY_ID: "rp-key",
      OIDC_PRIVATE_JWK: JSON.stringify(await exportJWK(rpKeys.privateKey)), OIDC_BOOTSTRAP_TOKEN: "a-long-random-bootstrap-code",
    }) as Cloudflare.Env;
    const discovery = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` };
    const publicJwk = { ...await exportJWK(opKeys.publicKey), kid: "op-key", alg: "ES256", use: "sig" };
    const authTime = Math.floor(Date.now() / 1000) - 5;
    let nonce = "";
    let subject = "pairwise-first-owner";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return Response.json(discovery);
      if (url.endsWith("/jwks")) return Response.json({ keys: [publicJwk] });
      if (url.endsWith("/token")) {
        const idToken = await new SignJWT({ nonce, sid: "first-sid", auth_time: authTime })
          .setProtectedHeader({ alg: "ES256", kid: "op-key" }).setIssuer(issuer).setAudience(clientId).setSubject(subject)
          .setIssuedAt().setExpirationTime("5m").sign(opKeys.privateKey);
        return Response.json({ id_token: idToken });
      }
      if (url.endsWith("/session/check")) return Response.json({ active: true, sub: subject, auth_time: authTime, expires_at: Math.floor(Date.now() / 1000) + 3600, lease_ttl: 300, app_idle_timeout: 3600 });
      throw new Error(`unexpected URL: ${url}`);
    }));

    const start = (bootstrapToken: string) => app.request(`${origin}/api/oidc/login/start`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ bootstrapToken }),
    }, testEnv);
    expect((await start("wrong")).status).toBe(403);
    const started = await start("a-long-random-bootstrap-code");
    expect(started.status).toBe(200);
    const { authorizationUrl } = await started.json<{ authorizationUrl: string }>();
    const authorize = new URL(authorizationUrl);
    nonce = authorize.searchParams.get("nonce")!;
    const state = authorize.searchParams.get("state")!;
    const browserCookie = started.headers.get("set-cookie")!.split(";")[0];
    const callbackUrl = new URL(`${origin}/api/oidc/callback`);
    callbackUrl.search = new URLSearchParams({ iss: issuer, state, code: "test-code" }).toString();
    const callback = await app.request(callbackUrl.toString(), { headers: { cookie: browserCookie } }, testEnv);
    expect(callback.status).toBe(303);
    expect(callback.headers.get("set-cookie")).toContain("tsudoi_organizer=");
    const organizerCookie = callback.headers.get("set-cookie")!.split(";")[0];
    const organizerSession = await app.request(`${origin}/api/session`, { headers: { cookie: organizerCookie } }, testEnv);
    expect(organizerSession.status).toBe(200);
    await expect(organizerSession.json()).resolves.toMatchObject({ role: "owner" });
    const owner = await env.DB.prepare("SELECT m.role, i.subject FROM organization_members m JOIN oidc_identities i ON i.user_id = m.user_id").first();
    expect(owner).toEqual({ role: "owner", subject: "pairwise-first-owner" });
    expect((await app.request(callbackUrl.toString(), { headers: { cookie: browserCookie } }, testEnv)).status).toBe(400);

    subject = "another-person";
    const next = await start("");
    expect(next.status).toBe(200);
    const nextUrl = new URL((await next.json<{ authorizationUrl: string }>()).authorizationUrl);
    nonce = nextUrl.searchParams.get("nonce")!;
    callbackUrl.search = new URLSearchParams({ iss: issuer, state: nextUrl.searchParams.get("state")!, code: "second-code" }).toString();
    const unlinked = await app.request(callbackUrl.toString(), { headers: { cookie: next.headers.get("set-cookie")!.split(";")[0] } }, testEnv);
    expect(unlinked.headers.get("location")).toBe("/?oidc=unlinked");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM organization_members").first()).toEqual({ count: 1 });
  });
});
