import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { checkSession, discover, oidcConfig, pkceChallenge, verifyIdToken } from "../src/oidc";

afterEach(() => vi.unstubAllGlobals());

describe("mikaki OIDC RP protocol", () => {
  it("builds S256 challenges and accepts only discovery endpoints on the pinned issuer", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const config = oidcConfig({ OIDC_ISSUER: "https://mikaki.tossa.app", OIDC_CLIENT_ID: crypto.randomUUID(), OIDC_KEY_ID: "tsudoi-test", OIDC_PRIVATE_JWK: JSON.stringify(await exportJWK(privateKey)), APP_ORIGIN: "https://tsudoi.example" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ issuer: config.issuer, authorization_endpoint: `${config.issuer}/authorize`, token_endpoint: `${config.issuer}/token`, jwks_uri: "https://attacker.example/jwks" })));
    await expect(discover(config)).rejects.toThrow("oidc_endpoint_mismatch");
  });

  it("checks the signed ID token and rejects a changed nonce", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const config = oidcConfig({ OIDC_ISSUER: "https://mikaki.tossa.app", OIDC_CLIENT_ID: crypto.randomUUID(), OIDC_KEY_ID: "tsudoi-test", OIDC_PRIVATE_JWK: JSON.stringify(await exportJWK(privateKey)), APP_ORIGIN: "https://tsudoi.example" });
    const publicJwk = { ...await exportJWK(publicKey), kid: "op-key", alg: "ES256", use: "sig" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [publicJwk] })));
    const discovery = { issuer: config.issuer, authorization_endpoint: `${config.issuer}/authorize`, token_endpoint: `${config.issuer}/token`, jwks_uri: `${config.issuer}/jwks` };
    const token = await new SignJWT({ nonce: "expected", sid: "sid-1", auth_time: Math.floor(Date.now() / 1000) - 10 })
      .setProtectedHeader({ alg: "ES256", kid: "op-key" }).setIssuer(config.issuer).setAudience(config.clientId).setSubject("pairwise-sub")
      .setIssuedAt().setExpirationTime("5m").sign(privateKey);
    await expect(verifyIdToken(config, discovery, token, "expected")).resolves.toMatchObject({ sub: "pairwise-sub", sid: "sid-1" });
    await expect(verifyIdToken(config, discovery, token, "wrong")).rejects.toThrow("oidc_id_token_invalid");
  });

  it("uses a fresh ES256 assertion for session checks and rejects a mismatched subject", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const config = oidcConfig({ OIDC_ISSUER: "https://mikaki.tossa.app", OIDC_CLIENT_ID: crypto.randomUUID(), OIDC_KEY_ID: "tsudoi-test", OIDC_PRIVATE_JWK: JSON.stringify(await exportJWK(privateKey)), APP_ORIGIN: "https://tsudoi.example" });
    const now = Math.floor(Date.now() / 1000);
    const mock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { client_assertion: string; sid: string };
      const assertion = await jwtVerify(body.client_assertion, publicKey, { issuer: config.clientId, audience: `${config.issuer}/session/check`, algorithms: ["ES256"] });
      expect(assertion.payload.sub).toBe(config.clientId);
      expect(body.sid).toBe("sid-1");
      return Response.json({ active: true, sub: "pairwise-sub", auth_time: now - 10, expires_at: now + 120, lease_ttl: 300, app_idle_timeout: 600 });
    });
    vi.stubGlobal("fetch", mock);
    const checked = await checkSession(config, "sid-1", "pairwise-sub", now - 10);
    expect(checked?.leaseExpiresAt).toBe(now + 120);
    await expect(checkSession(config, "sid-1", "other-sub", now - 10)).rejects.toThrow("oidc_session_check_invalid");
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
