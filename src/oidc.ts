import { createRemoteJWKSet, importJWK, jwtVerify, SignJWT } from "jose";

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const ISSUER = "https://mikaki.tossa.app";

type OidcEnv = { APP_ORIGIN: string; OIDC_PRIVATE_JWK?: string; OIDC_CLIENT_ID?: string; OIDC_KEY_ID?: string; OIDC_ISSUER?: string };
type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
export type OidcConfig = { issuer: string; clientId: string; kid: string; privateJwk: JsonWebKey; redirectUri: string };
export type CheckedSession = { sub: string; authTime: number; parentExpiresAt: number; leaseExpiresAt: number; idleTimeout: number };

export function oidcConfigured(env: OidcEnv): boolean {
  try {
    const origin = new URL(env.APP_ORIGIN);
    return Boolean(env.OIDC_CLIENT_ID && env.OIDC_KEY_ID && env.OIDC_PRIVATE_JWK && env.OIDC_ISSUER === ISSUER && origin.protocol === "https:" && origin.origin === env.APP_ORIGIN);
  } catch { return false; }
}

export function oidcConfig(env: OidcEnv): OidcConfig {
  if (!oidcConfigured(env)) throw new Error("oidc_not_configured");
  const privateJwk = JSON.parse(env.OIDC_PRIVATE_JWK!) as JsonWebKey;
  if (privateJwk.kty !== "EC" || privateJwk.crv !== "P-256" || !privateJwk.d) throw new Error("invalid_oidc_private_key");
  return { issuer: ISSUER, clientId: env.OIDC_CLIENT_ID!, kid: env.OIDC_KEY_ID!, privateJwk, redirectUri: `${env.APP_ORIGIN}/api/oidc/callback` };
}

export async function discover(config: OidcConfig): Promise<Discovery> {
  const response = await fetch(`${config.issuer}/.well-known/openid-configuration`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("oidc_discovery_failed");
  const body = await response.json() as Discovery;
  if (body.issuer !== config.issuer) throw new Error("oidc_issuer_mismatch");
  for (const endpoint of [body.authorization_endpoint, body.token_endpoint, body.jwks_uri]) {
    if (typeof endpoint !== "string" || new URL(endpoint).origin !== config.issuer) throw new Error("oidc_endpoint_mismatch");
  }
  return body;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...hash)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function assertion(config: OidcConfig, audience: string): Promise<string> {
  const key = await importJWK(config.privateJwk, "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: config.kid, typ: "JWT" })
    .setIssuer(config.clientId).setSubject(config.clientId).setAudience(audience)
    .setJti(crypto.randomUUID()).setIssuedAt().setExpirationTime("60s")
    .sign(key);
}

export async function exchangeCode(config: OidcConfig, discovery: Discovery, code: string, verifier: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code", code, redirect_uri: config.redirectUri,
    code_verifier: verifier, client_id: config.clientId,
    client_assertion_type: ASSERTION_TYPE,
    client_assertion: await assertion(config, discovery.token_endpoint),
  });
  const response = await fetch(discovery.token_endpoint, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
    redirect: "manual", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("oidc_token_exchange_failed");
  const tokens = await response.json() as { id_token?: unknown };
  if (typeof tokens.id_token !== "string") throw new Error("oidc_id_token_missing");
  return tokens.id_token;
}

export async function verifyIdToken(config: OidcConfig, discovery: Discovery, idToken: string, nonce: string): Promise<{ sub: string; sid: string; authTime: number }> {
  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri), { timeoutDuration: 10_000 });
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: config.issuer, audience: config.clientId, algorithms: ["RS256", "ES256"],
    clockTolerance: 30, maxTokenAge: "5m",
  });
  if (payload.nonce !== nonce || typeof payload.sub !== "string" || !payload.sub || typeof payload.sid !== "string" || !payload.sid ||
    typeof payload.auth_time !== "number" || payload.auth_time > Math.floor(Date.now() / 1000) + 30 ||
    (payload.azp !== undefined && payload.azp !== config.clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId)) throw new Error("oidc_id_token_invalid");
  return { sub: payload.sub, sid: payload.sid, authTime: payload.auth_time };
}

export async function checkSession(config: OidcConfig, sid: string, expectedSub: string, expectedAuthTime: number): Promise<CheckedSession | null> {
  const endpoint = `${config.issuer}/session/check`;
  const startedAt = Math.floor(Date.now() / 1000);
  const response = await fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: config.clientId, client_assertion_type: ASSERTION_TYPE, client_assertion: await assertion(config, endpoint), sid }),
    redirect: "manual", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("oidc_session_check_failed");
  const result = await response.json() as { active?: unknown; sub?: unknown; auth_time?: unknown; expires_at?: unknown; lease_ttl?: unknown; app_idle_timeout?: unknown };
  if (result.active === false) return null;
  if (result.active !== true || result.sub !== expectedSub || result.auth_time !== expectedAuthTime ||
    !Number.isSafeInteger(result.expires_at) || !Number.isSafeInteger(result.lease_ttl) || !Number.isSafeInteger(result.app_idle_timeout) ||
    Number(result.lease_ttl) <= 0 || Number(result.app_idle_timeout) <= 0) throw new Error("oidc_session_check_invalid");
  const parentExpiresAt = Number(result.expires_at);
  const leaseExpiresAt = Math.min(parentExpiresAt, startedAt + Number(result.lease_ttl));
  if (leaseExpiresAt <= Math.floor(Date.now() / 1000)) return null;
  return { sub: expectedSub, authTime: expectedAuthTime, parentExpiresAt, leaseExpiresAt, idleTimeout: Number(result.app_idle_timeout) };
}
