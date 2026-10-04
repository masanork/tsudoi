import { Hono } from "hono";
import { cors } from "hono/cors";
import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import * as QRCode from "qrcode";
import { checkIn } from "./check-in";
import { calendarDate, canonicalDate, confirmedCalendar, extractInviteToken, parseConstraints, parseScheduleSlot, pkceS256, suggestSlots } from "./schedule-protocol";

type Role = "owner" | "admin" | "staff" | "viewer";
type OrganizerAuth = { organizationId: string; scopes: string[]; actorId: string; role: Role | "api_token"; kind: "session" | "api_token" };
type AppVariables = { auth: OrganizerAuth; participantAttendeeId: string };
type JsonRecord = Record<string, unknown>;
type AppBindings = Cloudflare.Env & { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET?: string };
type AppEnv = { Bindings: AppBindings; Variables: AppVariables };
type NotificationJob =
  | { type: "ticket_link"; to: string; eventName: string; link: string; ticketUrl?: string }
  | { type: "event_announcement"; to: string; eventName: string; subject: string; message: string };

export const app = new Hono<AppEnv>();

app.use("/api/*", cors({ origin: (origin, c) => origin === c.env.APP_ORIGIN ? origin : c.env.APP_ORIGIN, credentials: true }));
app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  const browserWrite = !["GET", "HEAD", "OPTIONS"].includes(c.req.method)
    && (c.req.path.startsWith("/api/") || c.req.path.startsWith("/public/") || ["/oauth/authorize", "/oauth/session"].includes(c.req.path));
  if (browserWrite && origin && origin !== c.env.APP_ORIGIN && origin !== new URL(c.req.url).origin) return c.json({ error: "untrusted_origin" }, 403);
  const upload = c.req.path.endsWith("/attachments") && c.req.method === "PUT";
  if (Number(c.req.header("content-length") ?? "0") > (upload ? 5_000_000 : 1_000_000)) return c.json({ error: "payload_too_large" }, 413);
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Cache-Control", "no-store");
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/setup/status", async (c) => {
  const organization = await c.env.DB.prepare("SELECT id FROM organizations LIMIT 1").first();
  return c.json({ initialSetupRequired: !organization });
});

app.get("/api/session", requireOrganizer, requireSession, (c) => {
  const auth = c.get("auth");
  return c.json({ organizationId: auth.organizationId, role: auth.role, displayName: "" });
});

app.get("/api/profile", requireOrganizer, requireSession, async (c) => {
  const auth = c.get("auth");
  const profile = await c.env.DB.prepare("SELECT display_name, email_normalized, avatar_url FROM users WHERE id = ?").bind(auth.actorId).first();
  return c.json(profile ?? {});
});

app.patch("/api/profile", requireOrganizer, requireSession, async (c) => {
  const body = await jsonBody(c);
  const displayName = requiredString(body, "displayName");
  const email = optionalString(body.email)?.toLowerCase();
  const avatarUrl = optionalAvatarUrl(body.avatarUrl);
  if (!displayName || displayName.length > 100 || (email && !email.includes("@")) || (body.avatarUrl !== undefined && !avatarUrl && body.avatarUrl !== null)) return badRequest(c, "invalid profile");
  await c.env.DB.prepare("UPDATE users SET display_name = ?, email_normalized = ?, avatar_url = ? WHERE id = ?")
    .bind(displayName, email ?? null, avatarUrl ?? null, c.get("auth").actorId).run();
  return c.json({ updated: true });
});

app.post("/api/session/logout", requireOrganizer, requireSession, async (c) => {
  const token = cookieValue(c.req.header("cookie"), "tsudoi_organizer");
  if (token) await c.env.DB.prepare("UPDATE organizer_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?").bind(await sha256(token)).run();
  c.header("Set-Cookie", organizerCookie("", 0));
  return c.body(null, 204);
});

app.post("/api/session/options", async (c) => {
  const options = await generateAuthenticationOptions({ rpID: c.env.RP_ID, userVerification: "required" });
  const challengeId = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO organizer_webauthn_challenges (id, challenge, expires_at) VALUES (?, ?, datetime('now', '+5 minutes'))")
    .bind(challengeId, options.challenge).run();
  return c.json({ challengeId, options });
});

app.post("/api/session/verify", async (c) => {
  const body = await jsonBody(c);
  const challengeId = requiredString(body, "challengeId");
  const response = body.response;
  if (!challengeId || !isAuthenticationResponse(response)) return badRequest(c, "invalid authentication response");
  const challenge = await c.env.DB.prepare("SELECT id, challenge FROM organizer_webauthn_challenges WHERE id = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP")
    .bind(challengeId).first<{ id: string; challenge: string }>();
  const passkey = await c.env.DB.prepare("SELECT id, user_id, credential_id, public_key, counter, transports_json FROM passkeys WHERE credential_id = ? AND user_id IS NOT NULL")
    .bind(response.id).first<{ id: string; user_id: string; credential_id: string; public_key: ArrayBuffer; counter: number; transports_json: string }>();
  if (!challenge || !passkey) return c.json({ error: "challenge_or_credential_not_found" }, 400);
  const verification = await verifyAuthenticationResponse({
    response, expectedChallenge: challenge.challenge, expectedOrigin: c.env.APP_ORIGIN, expectedRPID: c.env.RP_ID, requireUserVerification: true,
    credential: { id: passkey.credential_id, publicKey: new Uint8Array(passkey.public_key), counter: passkey.counter, transports: parseAuthenticatorTransports(passkey.transports_json) },
  }).catch(() => null);
  if (!verification?.verified) return c.json({ error: "passkey_verification_failed" }, 400);
  const membership = await c.env.DB.prepare("SELECT organization_id, role FROM organization_members WHERE user_id = ? ORDER BY created_at LIMIT 1")
    .bind(passkey.user_id).first<{ organization_id: string; role: Role }>();
  if (!membership) return c.json({ error: "organization_membership_not_found" }, 403);
  if (!await consumeAuthChallenge(c.env.DB, "organizer_webauthn_challenges", challenge.id)) return c.json({ error: "challenge_expired" }, 400);
  const sessionToken = randomToken();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE passkeys SET counter = ? WHERE id = ?").bind(verification.authenticationInfo.newCounter, passkey.id),
    c.env.DB.prepare("INSERT INTO organizer_sessions (id, user_id, organization_id, token_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+12 hours'))")
      .bind(crypto.randomUUID(), passkey.user_id, membership.organization_id, await sha256(sessionToken)),
  ]);
  c.header("Set-Cookie", organizerCookie(sessionToken));
  return c.json({ role: membership.role, organizationId: membership.organization_id });
});

app.post("/api/setup/initial-admin/options", async (c) => {
  const body = await jsonBody(c);
  const organizationName = optionalString(body.organizationName)?.trim() || "既定ワークスペース";
  const displayName = requiredString(body, "displayName");
  const email = optionalString(body.email)?.trim().toLowerCase();
  const avatarUrl = optionalAvatarUrl(body.avatarUrl);
  if (!displayName || displayName.length > 100 || (email && !email.includes("@")) || (body.avatarUrl !== undefined && !avatarUrl)) return badRequest(c, "displayName is required");
  if (await c.env.DB.prepare("SELECT id FROM organizations LIMIT 1").first()) return c.json({ error: "initial_setup_complete" }, 409);
  const options = await generateRegistrationOptions({
    rpName: c.env.RP_NAME, rpID: c.env.RP_ID, userID: crypto.getRandomValues(new Uint8Array(16)),
    userName: email ?? displayName, userDisplayName: displayName, attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const challengeId = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO initial_admin_challenges (id, organization_name, display_name, email_normalized, avatar_url, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+5 minutes'))")
    .bind(challengeId, organizationName, displayName, email ?? null, avatarUrl ?? null, options.challenge).run();
  return c.json({ challengeId, options });
});

app.post("/api/setup/initial-admin/verify", async (c) => {
  const body = await jsonBody(c);
  const challengeId = requiredString(body, "challengeId");
  const response = body.response;
  if (!challengeId || !isRegistrationResponse(response)) return badRequest(c, "invalid registration response");
  const challenge = await c.env.DB.prepare("SELECT id, organization_name, display_name, email_normalized, avatar_url, challenge FROM initial_admin_challenges WHERE id = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP")
    .bind(challengeId).first<{ id: string; organization_name: string; display_name: string; email_normalized: string | null; avatar_url: string | null; challenge: string }>();
  if (!challenge || await c.env.DB.prepare("SELECT id FROM organizations LIMIT 1").first()) return c.json({ error: "initial_setup_unavailable" }, 409);
  const verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: c.env.APP_ORIGIN, expectedRPID: c.env.RP_ID, requireUserVerification: true });
  if (!verification.verified || !verification.registrationInfo) return c.json({ error: "passkey_verification_failed" }, 400);
  const organizationId = crypto.randomUUID(), userId = crypto.randomUUID();
  const credential = verification.registrationInfo.credential;
  const sessionToken = randomToken();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE initial_admin_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(challenge.id),
    c.env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(organizationId, challenge.organization_name),
    c.env.DB.prepare("INSERT INTO users (id, display_name, email_normalized, avatar_url) VALUES (?, ?, ?, ?)").bind(userId, challenge.display_name, challenge.email_normalized, challenge.avatar_url),
    c.env.DB.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'owner')").bind(organizationId, userId),
    c.env.DB.prepare("INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports_json, prf_capable) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), userId, credential.id, credential.publicKey, credential.counter, JSON.stringify(response.response.transports ?? []), hasPrfEnabled(response.clientExtensionResults) ? 1 : 0),
    c.env.DB.prepare("INSERT INTO organizer_sessions (id, user_id, organization_id, token_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+12 hours'))")
      .bind(crypto.randomUUID(), userId, organizationId, await sha256(sessionToken)),
  ]);
  c.header("Set-Cookie", organizerCookie(sessionToken));
  return c.json({ role: "owner", organizationId }, 201);
});

app.use("/api/organizations/*", requireOrganizer);
app.use("/api/events", requireOrganizer);
app.use("/api/events/*", requireOrganizer);
app.use("/api/tickets/*", requireOrganizer);
app.use("/api/messages/*", requireOrganizer);
app.use("/api/tokens", requireOrganizer);
app.use("/api/tokens/*", requireOrganizer);
app.use("/api/participant/*", requireParticipant);

app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(requestOrigin(c))));
app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResourceMetadata(requestOrigin(c))));
app.get("/.well-known/oauth-authorization-server", (c) => c.json(authorizationServerMetadata(requestOrigin(c))));
app.post("/oauth/register", async (c) => registerOauthClient(c));
app.get("/oauth/authorize", async (c) => renderOauthAuthorize(c));
app.post("/oauth/session", async (c) => createSchedulerSession(c));
app.post("/oauth/authorize", async (c) => approveOauthAuthorize(c));
app.post("/oauth/token", async (c) => issueOauthToken(c));
app.post("/oauth/revoke", async (c) => revokeOauthToken(c));
app.get("/mcp", (c) => { c.header("Allow", "POST"); return c.body(null, 405); });
app.post("/mcp", async (c) => handleMcpRequest(c));

app.post("/api/organizations/:organizationId/invites", requireSession, requireScope("admin"), async (c) => {
  if (!sameOrganization(c)) return forbidden(c);
  const limited = await rateLimit(c, `invite:${c.get("auth").actorId}`, 20, 3600);
  if (limited) return limited;
  const body = await jsonBody(c);
  const role = requiredString(body, "role");
  const email = optionalString(body.email)?.trim().toLowerCase();
  if (!role || !["admin", "staff", "viewer"].includes(role) || (email && !email.includes("@"))) return badRequest(c, "invalid invitation");
  const rawToken = randomToken();
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO organization_invites (id, organization_id, token_hash, role, email_normalized, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+7 days'))")
    .bind(id, c.get("auth").organizationId, await sha256(rawToken), role, email ?? null).run();
  await audit(c.env.DB, c.get("auth"), "organization.invite_created", "organization_invite", id);
  return c.json({ id, url: `${c.env.APP_ORIGIN}/invite/${rawToken}`, expiresInDays: 7 }, 201);
});

app.get("/public/invites/:token", async (c) => {
  const invite = await inviteForToken(c);
  if (!invite) return c.json({ error: "invite_unavailable" }, 404);
  const organization = await c.env.DB.prepare("SELECT name FROM organizations WHERE id = ?").bind(invite.organization_id).first<{ name: string }>();
  return c.json({ organizationName: organization?.name ?? "tsudoi", role: invite.role, email: invite.email_normalized });
});

app.post("/public/invites/:token/passkey/options", async (c) => {
  const limited = await rateLimit(c, `invite-register:${clientIp(c)}`, 30, 300);
  if (limited) return limited;
  const invite = await inviteForToken(c);
  if (!invite) return c.json({ error: "invite_unavailable" }, 404);
  const body = await jsonBody(c);
  const displayName = requiredString(body, "displayName");
  if (!displayName || displayName.length > 100) return badRequest(c, "display name is required");
  if (invite.email_normalized && await c.env.DB.prepare("SELECT id FROM users WHERE email_normalized = ?").bind(invite.email_normalized).first()) return c.json({ error: "email_already_registered" }, 409);
  const options = await generateRegistrationOptions({
    rpName: c.env.RP_NAME, rpID: c.env.RP_ID, userID: crypto.getRandomValues(new Uint8Array(16)),
    userName: invite.email_normalized ?? displayName, userDisplayName: displayName, attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const challengeId = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO invite_webauthn_challenges (id, invite_id, display_name, challenge, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+5 minutes'))")
    .bind(challengeId, invite.id, displayName, options.challenge).run();
  return c.json({ challengeId, options });
});

app.post("/public/invites/:token/passkey/verify", async (c) => {
  const invite = await inviteForToken(c);
  if (!invite) return c.json({ error: "invite_unavailable" }, 404);
  const body = await jsonBody(c);
  const challengeId = requiredString(body, "challengeId");
  const response = body.response;
  if (!challengeId || !isRegistrationResponse(response)) return badRequest(c, "invalid registration response");
  const challenge = await c.env.DB.prepare("SELECT id, display_name, challenge FROM invite_webauthn_challenges WHERE id = ? AND invite_id = ? AND expires_at > CURRENT_TIMESTAMP")
    .bind(challengeId, invite.id).first<{ id: string; display_name: string; challenge: string }>();
  if (!challenge) return c.json({ error: "challenge_expired" }, 400);
  const verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: c.env.APP_ORIGIN, expectedRPID: c.env.RP_ID, requireUserVerification: true });
  if (!verification.verified || !verification.registrationInfo) return c.json({ error: "passkey_verification_failed" }, 400);
  const userId = crypto.randomUUID();
  const sessionToken = randomToken();
  const credential = verification.registrationInfo.credential;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO users (id, email_normalized, display_name) VALUES (?, ?, ?)").bind(userId, invite.email_normalized, challenge.display_name),
      c.env.DB.prepare("INSERT INTO organization_invite_claims (invite_id, user_id) VALUES (?, ?)").bind(invite.id, userId),
      c.env.DB.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)").bind(invite.organization_id, userId, invite.role),
      c.env.DB.prepare("INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports_json, prf_capable) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), userId, credential.id, credential.publicKey, credential.counter, JSON.stringify(response.response.transports ?? []), hasPrfEnabled(response.clientExtensionResults) ? 1 : 0),
      c.env.DB.prepare("UPDATE organization_invites SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(invite.id),
      c.env.DB.prepare("INSERT INTO organizer_sessions (id, user_id, organization_id, token_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+12 hours'))")
        .bind(crypto.randomUUID(), userId, invite.organization_id, await sha256(sessionToken)),
    ]);
  } catch { return c.json({ error: "invite_unavailable" }, 409); }
  c.header("Set-Cookie", organizerCookie(sessionToken));
  return c.json({ role: invite.role, organizationId: invite.organization_id }, 201);
});

app.get("/api/tokens", requireSession, requireScope("admin"), async (c) => {
  const tokens = await c.env.DB.prepare("SELECT id, label, scopes, expires_at, revoked_at, created_at FROM api_tokens WHERE organization_id = ? ORDER BY created_at DESC")
    .bind(c.get("auth").organizationId).all();
  return c.json({ tokens: tokens.results.map((token) => ({ ...token, scopes: JSON.parse(String(token.scopes)) })) });
});

app.post("/api/tokens", requireSession, requireScope("admin"), async (c) => {
  const body = await jsonBody(c);
  const label = requiredString(body, "label");
  const scopes = body.scopes;
  const allowed = new Set(["roster:read", "roster:write", "checkin:write", "messages:write", "admin"]);
  if (!label || label.length > 100 || !Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => typeof scope !== "string" || !allowed.has(scope))) return badRequest(c, "invalid token");
  const expiresAt = optionalString(body.expiresAt);
  if (expiresAt && (Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) return badRequest(c, "invalid expiry");
  const rawToken = `tsu_${randomToken()}`;
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO api_tokens (id, organization_id, token_hash, scopes, label, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, c.get("auth").organizationId, await sha256(rawToken), JSON.stringify([...new Set(scopes)]), label, expiresAt ?? null).run();
  await audit(c.env.DB, c.get("auth"), "api_token.created", "api_token", id);
  return c.json({ id, token: rawToken }, 201);
});

app.delete("/api/tokens/:tokenId", requireSession, requireScope("admin"), async (c) => {
  const result = await c.env.DB.prepare("UPDATE api_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND revoked_at IS NULL")
    .bind(c.req.param("tokenId"), c.get("auth").organizationId).run();
  if (!result.meta.changes) return c.json({ error: "not_found" }, 404);
  await audit(c.env.DB, c.get("auth"), "api_token.revoked", "api_token", c.req.param("tokenId")!);
  return c.body(null, 204);
});

app.get("/api/organizations/:organizationId/events", requireScope("roster:read"), async (c) => {
  if (!sameOrganization(c)) return forbidden(c);
  const rows = await c.env.DB.prepare("SELECT * FROM events WHERE organization_id = ? AND archived_at IS NULL ORDER BY starts_at DESC")
    .bind(c.req.param("organizationId")).all();
  return c.json(rows.results);
});

app.get("/api/organizations/:organizationId/members", requireScope("admin"), async (c) => {
  if (!sameOrganization(c)) return forbidden(c);
  const members = await c.env.DB.prepare(`SELECT u.id, u.display_name, u.email_normalized, u.avatar_url, m.role
    FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? ORDER BY u.display_name`).bind(c.req.param("organizationId")).all();
  return c.json({ members: members.results });
});

app.get("/api/events", requireScope("roster:read"), async (c) => {
  const auth = c.get("auth");
  const rows = await c.env.DB.prepare(`SELECT * FROM events WHERE organization_id = ? AND archived_at IS NULL
    AND (? != 'staff' OR id IN (SELECT v.event_id FROM venues v JOIN venue_staff_assignments s ON s.venue_id = v.id WHERE s.user_id = ?))
    ORDER BY starts_at DESC`).bind(auth.organizationId, auth.role, auth.actorId).all();
  return c.json(rows.results);
});

app.post("/api/organizations/:organizationId/events", requireScope("admin"), async (c) => {
  if (!sameOrganization(c)) return forbidden(c);
  const body = await jsonBody(c);
  return createEvent(c, c.req.param("organizationId") ?? "", body);
});

app.post("/api/events", requireScope("admin"), async (c) => {
  const body = await jsonBody(c);
  return createEvent(c, c.get("auth").organizationId, body);
});

app.get("/api/events/:eventId/organizers", requireScope("roster:read"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const organizers = await c.env.DB.prepare(`SELECT eo.user_id, eo.role, u.display_name, u.email_normalized
    FROM event_organizers eo JOIN users u ON u.id = eo.user_id WHERE eo.event_id = ? ORDER BY eo.role, u.display_name`).bind(event.id).all();
  return c.json({ organizers: organizers.results });
});

app.post("/api/events/:eventId/organizers", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const body = await jsonBody(c), userId = requiredString(body, "userId"), role = requiredString(body, "role");
  if (!userId || !["organizer", "cohost"].includes(role ?? "")) return badRequest(c, "invalid organizer");
  const member = await c.env.DB.prepare("SELECT user_id FROM organization_members WHERE organization_id = ? AND user_id = ?").bind(event.organization_id, userId).first();
  if (!member) return c.json({ error: "organization_member_not_found" }, 404);
  await c.env.DB.prepare("INSERT INTO event_organizers (event_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(event_id, user_id) DO UPDATE SET role = excluded.role")
    .bind(event.id, userId, role).run();
  await audit(c.env.DB, c.get("auth"), "event.organizer_assigned", "event", event.id);
  return c.json({ assigned: true }, 201);
});

app.delete("/api/events/:eventId/organizers/:userId", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const organizers = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM event_organizers WHERE event_id = ? AND role = 'organizer'").bind(event.id).first<{ count: number }>();
  const target = await c.env.DB.prepare("SELECT role FROM event_organizers WHERE event_id = ? AND user_id = ?").bind(event.id, c.req.param("userId")).first<{ role: string }>();
  if (!target) return c.json({ error: "organizer_not_found" }, 404);
  if (target.role === "organizer" && (organizers?.count ?? 0) <= 1) return c.json({ error: "last_organizer" }, 409);
  await c.env.DB.prepare("DELETE FROM event_organizers WHERE event_id = ? AND user_id = ?").bind(event.id, c.req.param("userId")).run();
  await audit(c.env.DB, c.get("auth"), "event.organizer_removed", "event", event.id);
  return c.body(null, 204);
});

app.post("/api/events/:eventId/publish", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const updated = await c.env.DB.prepare("UPDATE events SET status = 'published', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft' RETURNING id, status").bind(event.id).first<{ id: string; status: string }>();
  if (!updated) return c.json({ error: "event_not_publishable" }, 409);
  await audit(c.env.DB, c.get("auth"), "event.published", "event", event.id);
  return c.json(updated);
});

app.post("/api/events/:eventId/close", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const updated = await c.env.DB.prepare("UPDATE events SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'published' RETURNING id, status").bind(event.id).first<{ id: string; status: string }>();
  if (!updated) return c.json({ error: "event_not_closable" }, 409);
  await audit(c.env.DB, c.get("auth"), "event.closed", "event", event.id);
  return c.json(updated);
});

app.delete("/api/events/:eventId", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event || event.archived_at) return c.json({ error: "not_found" }, 404);
  const attendee = await c.env.DB.prepare("SELECT id FROM attendees WHERE event_id = ? LIMIT 1").bind(event.id).first();
  if (event.status !== "draft" || attendee) {
    await c.env.DB.prepare("UPDATE events SET status = 'closed', archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND archived_at IS NULL").bind(event.id).run();
    await audit(c.env.DB, c.get("auth"), "event.archived", "event", event.id);
    return c.json({ action: "archived" });
  }
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM schedule_revisions WHERE event_id = ?").bind(event.id),
    c.env.DB.prepare("DELETE FROM schedule_invites WHERE event_id = ?").bind(event.id),
    c.env.DB.prepare("DELETE FROM schedule_participants WHERE event_id = ?").bind(event.id),
    c.env.DB.prepare("DELETE FROM scheduling_preferences WHERE event_id = ?").bind(event.id),
    c.env.DB.prepare("DELETE FROM agent_connections WHERE event_id = ?").bind(event.id),
    c.env.DB.prepare("DELETE FROM schedule_responses WHERE event_id = ?").bind(event.id),
    c.env.DB.prepare("DELETE FROM schedule_options WHERE event_id = ?").bind(event.id),
    c.env.DB.prepare("DELETE FROM form_fields WHERE event_id = ?").bind(event.id),
    c.env.DB.prepare("DELETE FROM event_organizers WHERE event_id = ?").bind(event.id),
    c.env.DB.prepare("DELETE FROM venue_staff_assignments WHERE venue_id IN (SELECT id FROM venues WHERE event_id = ?)").bind(event.id),
    c.env.DB.prepare("DELETE FROM venues WHERE event_id = ?").bind(event.id),
    c.env.DB.prepare("DELETE FROM events WHERE id = ? AND status = 'draft' AND NOT EXISTS (SELECT 1 FROM attendees WHERE event_id = ?)").bind(event.id, event.id),
  ]);
  const remaining = await c.env.DB.prepare("SELECT id FROM events WHERE id = ?").bind(event.id).first();
  if (remaining) return c.json({ error: "event_not_deletable" }, 409);
  await audit(c.env.DB, c.get("auth"), "event.deleted", "event", event.id);
  return c.json({ action: "deleted" });
});

app.get("/api/events/:eventId/schedule", requireScope("roster:read"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const timeZone = event.timezone ?? "Asia/Tokyo";
  const options = await c.env.DB.prepare(`SELECT o.id, o.starts_at, o.ends_at, o.note,
      COUNT(r.id) AS responses,
      SUM(CASE WHEN r.response = 'yes' THEN 1 ELSE 0 END) AS yes,
      SUM(CASE WHEN r.response = 'maybe' THEN 1 ELSE 0 END) AS maybe,
      SUM(CASE WHEN r.response = 'no' THEN 1 ELSE 0 END) AS no
    FROM schedule_options o LEFT JOIN schedule_responses r ON r.option_id = o.id
    WHERE o.event_id = ? GROUP BY o.id ORDER BY o.starts_at`).bind(event.id).all<{ id: string; starts_at: string; ends_at: string; note: string; responses: number; yes: number; maybe: number; no: number }>();
  const participants = await c.env.DB.prepare(`SELECT display_name, role, EXISTS(SELECT 1 FROM schedule_responses r WHERE r.event_id = schedule_participants.event_id AND r.respondent_id = schedule_participants.respondent_id) AS answered
    FROM schedule_participants WHERE event_id = ? ORDER BY joined_at`).bind(event.id).all<{ display_name: string; role: string; answered: number }>();
  return c.json({ ...scheduleSummary(event), readyToConfirm: await readyOptionIds(c.env.DB, event.id), participants: participants.results.map((participant) => ({ displayName: participant.display_name, role: participant.role, answered: Number(participant.answered) === 1 })), options: options.results.map((option) => scheduleOptionForClient(option, timeZone)) });
});

app.post("/api/events/:eventId/schedule/options", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  if (event.scheduling_enabled !== 1 || event.schedule_status === "confirmed") return c.json({ error: "schedule_not_editable" }, 409);
  const body = await jsonBody(c);
  const slot = parseScheduleSlot(body);
  const note = optionalString(body.note) ?? "";
  if (!slot || note.length > 500) return badRequest(c, "a valid date or start and end is required");
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM schedule_options WHERE event_id = ?").bind(event.id).first<{ count: number }>();
  if ((count?.count ?? 0) >= 20) return c.json({ error: "schedule_option_limit" }, 409);
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare("INSERT INTO schedule_options (id, event_id, starts_at, ends_at, note) VALUES (?, ?, ?, ?, ?)")
      .bind(id, event.id, slot.startsAt, slot.endsAt, note).run();
  } catch { return c.json({ error: "schedule_option_exists" }, 409); }
  await recordScheduleRevision(c.env.DB, event.id, "option_added", { optionId: id });
  return c.json({ id }, 201);
});

app.post("/api/events/:eventId/schedule/confirm", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  if (event.scheduling_enabled !== 1 || event.schedule_status === "confirmed") return c.json({ error: "schedule_not_confirmable" }, 409);
  const body = await jsonBody(c);
  const optionId = requiredString(body, "optionId");
  const option = await c.env.DB.prepare("SELECT id, starts_at, ends_at FROM schedule_options WHERE id = ? AND event_id = ?")
    .bind(optionId, event.id).first<{ id: string; starts_at: string; ends_at: string }>();
  if (!option) return c.json({ error: "schedule_option_not_found" }, 404);
  await c.env.DB.prepare("UPDATE events SET starts_at = ?, ends_at = ?, schedule_status = 'confirmed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(option.starts_at, option.ends_at, event.id).run();
  await recordScheduleRevision(c.env.DB, event.id, "confirmed", { optionId: option.id });
  const timeZone = event.timezone ?? "Asia/Tokyo";
  return c.json({ confirmed: true, date: canonicalDate(option.starts_at) === option.starts_at ? option.starts_at : calendarDate(option.starts_at, timeZone), calendar: confirmedCalendar({ uid: event.id, title: event.name, startsAt: option.starts_at, endsAt: option.ends_at, timeZone, url: `${c.env.APP_ORIGIN}/events/${event.id}/schedule` }) });
});

app.post("/api/events/:eventId/schedule/invites", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  if (event.scheduling_enabled !== 1 || event.schedule_status === "confirmed" || event.archived_at) return c.json({ error: "schedule_not_editable" }, 409);
  const limited = await rateLimit(c, `schedule-invite:${c.get("auth").actorId}`, 30, 3600);
  if (limited) return limited;
  const body = await jsonBody(c);
  const role = requiredString(body, "role") ?? "required";
  if (!["required", "optional"].includes(role)) return badRequest(c, "invalid invite role");
  const token = randomToken();
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO schedule_invites (id, event_id, token_hash, role, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+14 days'))")
    .bind(id, event.id, await sha256(token), role).run();
  await audit(c.env.DB, c.get("auth"), "schedule.invite_created", "schedule_invite", id);
  return c.json({ id, url: `${c.env.APP_ORIGIN}/events/${event.id}/schedule#invite=${token}`, expiresInDays: 14 }, 201);
});

app.post("/api/events/:eventId/venues", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const body = await jsonBody(c);
  const name = requiredString(body, "name");
  if (!name) return badRequest(c, "name is required");
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO venues (id, event_id, name, address, opens_at, capacity) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, event.id, name, optionalString(body.address) ?? "", optionalString(body.opensAt) ?? null, optionalInteger(body.capacity)).run();
  return c.json({ id }, 201);
});

app.get("/api/events/:eventId/venues", requireScope("roster:read"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const auth = c.get("auth");
  const venues = await c.env.DB.prepare(`SELECT v.id, v.name, v.address, v.opens_at, v.capacity FROM venues v WHERE v.event_id = ?
    AND (? != 'staff' OR EXISTS (SELECT 1 FROM venue_staff_assignments s WHERE s.venue_id = v.id AND s.user_id = ?)) ORDER BY v.created_at`)
    .bind(event.id, auth.role, auth.actorId).all();
  return c.json({ venues: venues.results });
});

app.put("/api/events/:eventId/venues/:venueId/staff/:userId", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const venue = await c.env.DB.prepare("SELECT id FROM venues WHERE id = ? AND event_id = ?")
    .bind(c.req.param("venueId"), event.id).first();
  const member = await c.env.DB.prepare("SELECT user_id FROM organization_members WHERE organization_id = ? AND user_id = ? AND role = 'staff'")
    .bind(event.organization_id, c.req.param("userId")).first();
  if (!venue || !member) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("INSERT OR IGNORE INTO venue_staff_assignments (venue_id, user_id) VALUES (?, ?)")
    .bind(c.req.param("venueId"), c.req.param("userId")!).run();
  await audit(c.env.DB, c.get("auth"), "venue.staff_assigned", "venue", c.req.param("venueId")!);
  return c.json({ assigned: true });
});

app.delete("/api/events/:eventId/venues/:venueId/staff/:userId", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("DELETE FROM venue_staff_assignments WHERE venue_id IN (SELECT id FROM venues WHERE id = ? AND event_id = ?) AND user_id = ?")
    .bind(c.req.param("venueId"), event.id, c.req.param("userId")!).run();
  await audit(c.env.DB, c.get("auth"), "venue.staff_removed", "venue", c.req.param("venueId")!);
  return c.body(null, 204);
});

app.get("/api/events/:eventId/form-fields", requireScope("roster:read"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const fields = await c.env.DB.prepare("SELECT * FROM form_fields WHERE event_id = ? AND retired_at IS NULL AND (? != 'staff' OR staff_visibility = 'visible') ORDER BY sort_order, created_at").bind(event.id, c.get("auth").role).all();
  return c.json(fields.results);
});

app.post("/api/events/:eventId/form-fields", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const body = await jsonBody(c);
  const key = requiredString(body, "key");
  const label = requiredString(body, "label");
  const type = requiredString(body, "type");
  const validTypes = ["text", "textarea", "number", "date", "single_select", "multi_select", "checkbox", "consent"];
  if (!key || !/^[a-z][a-z0-9_]{0,62}$/.test(key) || !label || !validTypes.includes(type ?? "")) return badRequest(c, "invalid field");
  const id = crypto.randomUUID();
  const options = Array.isArray(body.options) ? body.options.filter((v): v is string => typeof v === "string").slice(0, 100) : [];
  await c.env.DB.prepare(`INSERT INTO form_fields (id, event_id, field_key, label, field_type, required, options_json, staff_visibility, searchable, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, event.id, key, label, type, body.required === true ? 1 : 0, JSON.stringify(options), body.staffVisibility === "admin_only" ? "admin_only" : "visible", body.searchable === true ? 1 : 0, optionalInteger(body.sortOrder) ?? 0).run();
  return c.json({ id }, 201);
});

app.get("/api/events/:eventId/roster", requireScope("roster:read"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const auth = c.get("auth");
  const fields = await c.env.DB.prepare("SELECT id, field_key, label FROM form_fields WHERE event_id = ? AND retired_at IS NULL AND (? != 'staff' OR staff_visibility = 'visible') ORDER BY sort_order, created_at")
    .bind(event.id, auth.role).all<{ id: string; field_key: string; label: string }>();
  const q = c.req.query("q")?.trim() ?? "";
  const status = c.req.query("status") ?? "";
  const source = c.req.query("source") ?? "";
  const venueId = c.req.query("venueId") ?? "";
  const after = c.req.query("after") ?? "";
  if (q.length > 100 || !["", "active", "cancelled"].includes(status) || !["", "public_form", "walk_in", "admin"].includes(source)) return badRequest(c, "invalid roster filter");
  const attendees = await c.env.DB.prepare(`SELECT a.id, a.name, a.email_normalized, a.status, a.registration_source, a.created_at,
      t.id AS ticket_id, t.status AS ticket_status, t.checked_in_at FROM attendees a JOIN tickets t ON t.attendee_id = a.id
      WHERE a.event_id = ? AND (? = '' OR a.name LIKE ? OR a.email_normalized LIKE ?)
      AND (? = '' OR a.status = ?) AND (? = '' OR a.registration_source = ?) AND (? = '' OR a.venue_id = ?)
      AND (? = '' OR (a.created_at, a.id) < (SELECT created_at, id FROM attendees WHERE id = ? AND event_id = ?))
      AND (? != 'staff' OR a.venue_id IN (SELECT s.venue_id FROM venue_staff_assignments s WHERE s.user_id = ?))
      ORDER BY a.created_at DESC, a.id DESC LIMIT 51`)
    .bind(event.id, q, `%${q}%`, `%${q}%`, status, status, source, source, venueId, venueId, after, after, event.id, auth.role, auth.actorId)
    .all<{ id: string; name: string; email_normalized: string | null; status: string; registration_source: string; created_at: string; ticket_status: string; checked_in_at: string | null }>();
  const page = attendees.results.slice(0, 50);
  const answers = page.length ? await c.env.DB.prepare(`SELECT attendee_id, field_id, value_json FROM attendee_answers WHERE attendee_id IN (${page.map(() => "?").join(",")})`)
    .bind(...page.map((attendee) => attendee.id)).all<{ attendee_id: string; field_id: string; value_json: string }>() : { results: [] };
  const answerMap = new Map(answers.results.map((answer) => [`${answer.attendee_id}:${answer.field_id}`, answerValue(answer.value_json)]));
  await audit(c.env.DB, auth, "roster.viewed", "event", event.id);
  return c.json({ fields: fields.results.map(({ field_key, label }) => ({ field_key, label })), attendees: page.map((attendee) => ({ ...attendee, answers: Object.fromEntries(fields.results.map((field) => [field.field_key, answerMap.get(`${attendee.id}:${field.id}`) ?? null])) })), nextCursor: attendees.results.length > 50 ? page.at(-1)?.id : null });
});

app.get("/api/events/:eventId/attendees", requireScope("roster:read"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const query = c.req.query("q")?.trim();
  const status = c.req.query("status");
  const rows = await c.env.DB.prepare(`SELECT a.*, t.id AS ticket_id, t.status AS ticket_status, t.checked_in_at
    FROM attendees a JOIN tickets t ON t.attendee_id = a.id WHERE a.event_id = ?
    AND (? IS NULL OR a.status = ?) AND (? IS NULL OR a.name LIKE ? OR a.email_normalized LIKE ?)
    AND (? != 'staff' OR a.venue_id IN (SELECT venue_id FROM venue_staff_assignments WHERE user_id = ?))
    ORDER BY a.created_at DESC LIMIT 200`)
    .bind(event.id, status ?? null, status ?? null, query ?? null, query ? `%${query}%` : null, query ? `%${query}%` : null, c.get("auth").role, c.get("auth").actorId).all();
  await audit(c.env.DB, c.get("auth"), "attendees.viewed", "event", event.id);
  return c.json(rows.results);
});

app.get("/api/events/:eventId/attendees.csv", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const fields = await c.env.DB.prepare("SELECT id, label FROM form_fields WHERE event_id = ? ORDER BY sort_order, created_at").bind(event.id).all<{ id: string; label: string }>();
  const attendees = await c.env.DB.prepare("SELECT id, name, email_normalized, registration_source, status, created_at FROM attendees WHERE event_id = ? ORDER BY created_at").bind(event.id).all<{ id: string; name: string; email_normalized: string | null; registration_source: string; status: string; created_at: string }>();
  const answers = await c.env.DB.prepare("SELECT attendee_id, field_id, value_json FROM attendee_answers WHERE attendee_id IN (SELECT id FROM attendees WHERE event_id = ?)").bind(event.id).all<{ attendee_id: string; field_id: string; value_json: string }>();
  const answerMap = new Map(answers.results.map((answer) => [`${answer.attendee_id}:${answer.field_id}`, csvAnswer(answer.value_json)]));
  const header = ["Name", "Email", "Registration source", "Status", "Registered at", ...fields.results.map((field) => field.label)];
  const rows = attendees.results.map((attendee) => [attendee.name, attendee.email_normalized ?? "", attendee.registration_source, attendee.status, attendee.created_at, ...fields.results.map((field) => answerMap.get(`${attendee.id}:${field.id}`) ?? "")]);
  await audit(c.env.DB, c.get("auth"), "attendees.exported", "event", event.id);
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="tsudoi-${event.id}-attendees.csv"`);
  return c.body(`\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`);
});

app.post("/api/events/:eventId/attendees", requireScope("roster:write"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  return registerAttendee(c, event, true);
});

app.get("/api/events/:eventId/metrics", requireScope("roster:read"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const venueId = c.req.query("venueId") ?? "";
  const source = c.req.query("source") ?? "";
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!["", "public_form", "walk_in", "admin"].includes(source) || (from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to)))) return badRequest(c, "invalid metrics filter");
  if (venueId && !await c.env.DB.prepare("SELECT id FROM venues WHERE id = ? AND event_id = ?").bind(venueId, event.id).first()) return badRequest(c, "invalid venue");
  const auth = c.get("auth");
  const metrics = await c.env.DB.prepare(`SELECT
    SUM(CASE WHEN a.status = 'active' THEN 1 ELSE 0 END) AS registrations,
    SUM(CASE WHEN t.status IN ('issued','checked_in') THEN 1 ELSE 0 END) AS issued,
    SUM(CASE WHEN t.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
    SUM(CASE WHEN t.status = 'checked_in' THEN 1 ELSE 0 END) AS checked_in,
    SUM(CASE WHEN t.status = 'issued' THEN 1 ELSE 0 END) AS not_checked_in
    FROM attendees a JOIN tickets t ON t.attendee_id = a.id WHERE a.event_id = ?
    AND (? = '' OR a.venue_id = ?) AND (? = '' OR a.registration_source = ?)
    AND (? = '' OR datetime(a.created_at) >= datetime(?)) AND (? = '' OR datetime(a.created_at) < datetime(?))
    AND (? != 'staff' OR a.venue_id IN (SELECT venue_id FROM venue_staff_assignments WHERE user_id = ?))`)
    .bind(event.id, venueId, venueId, source, source, from, from, to, to, auth.role, auth.actorId).first<Record<string, number | null>>();
  const counts = Object.fromEntries(Object.entries(metrics ?? {}).map(([key, value]) => [key, value ?? 0]));
  return c.json({ ...counts, capacity: event.capacity, capacity_fill_rate: event.capacity ? Number(counts.registrations) / event.capacity : null, timezone: event.timezone ?? "Asia/Tokyo", period: { from: from || null, to: to || null } });
});

app.post("/api/events/:eventId/announcements", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const body = await jsonBody(c);
  const subject = requiredString(body, "subject"), message = requiredString(body, "message");
  if (!subject || subject.length > 160 || !message || message.length > 5000) return badRequest(c, "subject and message are required");
  const attendees = await c.env.DB.prepare("SELECT DISTINCT email_normalized FROM attendees WHERE event_id = ? AND status = 'active' AND email_normalized IS NOT NULL").bind(event.id).all<{ email_normalized: string }>();
  await Promise.all(attendees.results.map((attendee) => c.env.NOTIFICATION_QUEUE.send({ type: "event_announcement", to: attendee.email_normalized, eventName: event.name, subject, message } satisfies NotificationJob)));
  await audit(c.env.DB, c.get("auth"), "event.announcement_sent", "event", event.id);
  return c.json({ queued: attendees.results.length }, 202);
});

app.post("/api/events/:eventId/attendees/:attendeeId/ticket-link", requireScope("roster:write"), async (c) => {
  const limited = await rateLimit(c, `ticket-link:${c.get("auth").actorId}:${c.req.param("attendeeId")}`, 10, 3600);
  if (limited) return limited;
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const attendee = await c.env.DB.prepare("SELECT a.id, a.email_normalized, t.id AS ticket_id FROM attendees a JOIN tickets t ON t.attendee_id = a.id WHERE a.id = ? AND a.event_id = ? AND a.status = 'active' AND t.status = 'issued'")
    .bind(c.req.param("attendeeId"), event.id).first<{ id: string; email_normalized: string | null; ticket_id: string }>();
  if (!attendee?.email_normalized) return c.json({ error: "email_not_available" }, 400);
  const rawToken = randomToken();
  await c.env.DB.prepare("INSERT INTO magic_links (id, attendee_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, 'ticket', datetime('now', '+24 hours'))")
    .bind(crypto.randomUUID(), attendee.id, await sha256(rawToken)).run();
  const eventName = (await c.env.DB.prepare("SELECT name FROM events WHERE id = ?").bind(event.id).first<{ name: string }>())?.name ?? "Your event";
  const link = `${c.env.APP_ORIGIN}/public/magic-links/${encodeURIComponent(rawToken)}`;
  const qrToken = await issueQrToken(c.env.DB, attendee.ticket_id, "+1 year");
  const ticketUrl = `${c.env.APP_ORIGIN}/public/tickets/${attendee.ticket_id}/check-in/${qrToken}`;
  await c.env.NOTIFICATION_QUEUE.send({ type: "ticket_link", to: attendee.email_normalized, eventName, link, ticketUrl } satisfies NotificationJob);
  return c.json({ queued: true }, 202);
});

app.get("/api/participant/ticket", async (c) => {
  const ticket = await c.env.DB.prepare(`SELECT t.id, t.status, t.issued_at, t.checked_in_at, e.id AS event_id, e.name AS event_name,
    e.starts_at, e.ends_at, e.timezone, e.cancellation_closes_at, v.name AS venue_name
    FROM tickets t JOIN attendees a ON a.id = t.attendee_id JOIN events e ON e.id = t.event_id
    LEFT JOIN venues v ON v.id = a.venue_id WHERE a.id = ?`).bind(c.get("participantAttendeeId")).first();
  if (!ticket) return c.json({ error: "ticket_not_found" }, 404);
  return c.json(ticket);
});

app.post("/api/participant/ticket/qr", async (c) => {
  const ticket = await c.env.DB.prepare("SELECT id FROM tickets WHERE attendee_id = ? AND status = 'issued'")
    .bind(c.get("participantAttendeeId")).first<{ id: string }>();
  if (!ticket) return c.json({ error: "ticket_unavailable" }, 409);
  const token = await issueQrToken(c.env.DB, ticket.id, "+15 minutes");
  return c.json({ url: `${c.env.APP_ORIGIN}/public/tickets/${ticket.id}/check-in/${token}`, expiresInSeconds: 900 });
});

app.post("/api/participant/ticket/cancel", async (c) => {
  const attendeeId = c.get("participantAttendeeId");
  const auditId = crypto.randomUUID();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO audit_logs (id, organization_id, action, target_type, target_id, metadata_json)
      SELECT ?, a.organization_id, 'ticket.cancelled_by_participant', 'ticket', t.id, '{}'
      FROM tickets t JOIN attendees a ON a.id = t.attendee_id JOIN events e ON e.id = t.event_id
      WHERE a.id = ? AND t.status = 'issued'
      AND (e.cancellation_closes_at IS NULL OR datetime(e.cancellation_closes_at) > CURRENT_TIMESTAMP)`)
      .bind(auditId, attendeeId),
    c.env.DB.prepare("UPDATE tickets SET status = 'cancelled' WHERE attendee_id = ? AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)").bind(attendeeId, auditId),
    c.env.DB.prepare("UPDATE attendees SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE id = ? AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)").bind(attendeeId, auditId),
  ]);
  if (!results[0].meta.changes) return c.json({ error: "cancellation_unavailable" }, 409);
  return c.json({ cancelled: true });
});

app.post("/api/participant/logout", async (c) => {
  const token = cookieValue(c.req.header("cookie"), "tsudoi_participant");
  if (token) await c.env.DB.prepare("UPDATE participant_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?").bind(await sha256(token)).run();
  c.header("Set-Cookie", "tsudoi_participant=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  return c.body(null, 204);
});

app.post("/api/participant/push-subscriptions", async (c) => {
  const body = await jsonBody(c);
  const endpoint = requiredString(body, "endpoint");
  const keys = isRecord(body.keys) ? body.keys : {};
  const p256dh = requiredString(keys, "p256dh");
  const auth = requiredString(keys, "auth");
  if (!endpoint || !endpoint.startsWith("https://") || !p256dh || !auth) return badRequest(c, "invalid push subscription");
  const id = crypto.randomUUID();
  await c.env.DB.prepare(`INSERT INTO push_subscriptions (id, attendee_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET attendee_id = excluded.attendee_id, p256dh = excluded.p256dh, auth = excluded.auth, updated_at = CURRENT_TIMESTAMP`)
    .bind(id, c.get("participantAttendeeId"), endpoint, p256dh, auth).run();
  return c.json({ subscribed: true }, 201);
});

app.delete("/api/participant/push-subscriptions", async (c) => {
  const body = await jsonBody(c);
  const endpoint = requiredString(body, "endpoint");
  if (!endpoint) return badRequest(c, "endpoint is required");
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE attendee_id = ? AND endpoint = ?").bind(c.get("participantAttendeeId"), endpoint).run();
  return c.body(null, 204);
});

app.post("/api/participant/events/:eventId/message-thread", async (c) => {
  const attendeeId = c.get("participantAttendeeId");
  const eventId = c.req.param("eventId");
  const attendee = await c.env.DB.prepare("SELECT id FROM attendees WHERE id = ? AND event_id = ? AND status = 'active'").bind(attendeeId, eventId).first();
  if (!attendee) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("INSERT OR IGNORE INTO message_threads (id, event_id, attendee_id) VALUES (?, ?, ?)").bind(crypto.randomUUID(), eventId, attendeeId).run();
  const thread = await c.env.DB.prepare("SELECT id, key_generation, created_at FROM message_threads WHERE event_id = ? AND attendee_id = ?").bind(eventId, attendeeId).first();
  return c.json(thread, 201);
});

app.get("/api/participant/messages/:threadId", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT id, sender_kind, ciphertext, algorithm, key_generation, created_at FROM encrypted_messages
    WHERE thread_id = ? AND thread_id IN (SELECT id FROM message_threads WHERE attendee_id = ?) ORDER BY created_at`)
    .bind(c.req.param("threadId"), c.get("participantAttendeeId")).all<{ id: string; sender_kind: string; ciphertext: ArrayBuffer; algorithm: string; key_generation: number; created_at: string }>();
  return c.json(rows.results.map((row) => ({ ...row, ciphertext: bytesToBase64(row.ciphertext) })));
});

app.post("/api/participant/messages/:threadId", async (c) => {
  const limited = await rateLimit(c, `message:${c.get("participantAttendeeId")}`, 60, 300);
  if (limited) return limited;
  const body = await jsonBody(c);
  const ciphertext = requiredString(body, "ciphertext");
  const algorithm = requiredString(body, "algorithm");
  const keyGeneration = optionalInteger(body.keyGeneration);
  if (!ciphertext || !algorithm || !keyGeneration) return badRequest(c, "ciphertext, algorithm, and keyGeneration are required");
  const thread = await c.env.DB.prepare("SELECT id FROM message_threads WHERE id = ? AND attendee_id = ?").bind(c.req.param("threadId"), c.get("participantAttendeeId")).first<{ id: string }>();
  if (!thread) return c.json({ error: "not_found" }, 404);
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO encrypted_messages (id, thread_id, sender_kind, ciphertext, algorithm, key_generation) VALUES (?, ?, 'attendee', ?, ?, ?)")
    .bind(id, thread.id, base64ToBytes(ciphertext), algorithm, keyGeneration).run();
  return c.json({ id }, 201);
});

app.post("/api/participant/messages/:threadId/key-envelopes", async (c) => {
  const thread = await participantThread(c);
  if (!thread) return c.json({ error: "not_found" }, 404);
  return createKeyEnvelope(c, thread.id);
});

app.get("/api/participant/messages/:threadId/key-envelopes", async (c) => {
  const thread = await participantThread(c);
  if (!thread) return c.json({ error: "not_found" }, 404);
  return listKeyEnvelopes(c, thread.id);
});

app.put("/api/participant/messages/:threadId/attachments", async (c) => {
  const thread = await participantThread(c);
  if (!thread) return c.json({ error: "not_found" }, 404);
  return storeEncryptedAttachment(c, thread.id);
});

app.get("/api/participant/messages/:threadId/attachments/:attachmentId", async (c) => {
  const thread = await participantThread(c);
  if (!thread) return c.json({ error: "not_found" }, 404);
  return readEncryptedAttachment(c, thread.id);
});

app.post("/api/tickets/:ticketId/check-in", requireScope("checkin:write"), async (c) => {
  const limited = await rateLimit(c, `check-in:${c.get("auth").actorId}`, 120, 300);
  if (limited) return limited;
  const ticketId = c.req.param("ticketId");
  if (!ticketId) return c.json({ error: "not_found" }, 404);
  const body = await jsonBody(c);
  const venueId = optionalString(body.venueId);
  const ticketToken = requiredString(body, "ticketToken");
  if (!ticketToken) return badRequest(c, "ticketToken is required");
  const ticket = await c.env.DB.prepare("SELECT t.*, e.organization_id, a.venue_id FROM tickets t JOIN events e ON e.id = t.event_id JOIN attendees a ON a.id = t.attendee_id WHERE t.id = ? AND e.archived_at IS NULL").bind(ticketId).first<{ id: string; event_id: string; organization_id: string; status: string; token_hash: string; token_key_id: string; venue_id: string | null; checked_in_at: string | null; checked_in_by: string | null }>();
  if (!ticket || ticket.organization_id !== c.get("auth").organizationId) return c.json({ error: "not_found" }, 404);
  const tokenHash = await sha256(ticketToken);
  const issuedQr = await c.env.DB.prepare("SELECT id FROM ticket_qr_tokens WHERE ticket_id = ? AND token_hash = ? AND expires_at > CURRENT_TIMESTAMP")
    .bind(ticketId, tokenHash).first();
  if (!issuedQr && !(ticket.token_key_id === "v1" && safeEqual(ticket.token_hash, tokenHash))) return c.json({ error: "invalid_ticket" }, 403);
  const venueError = await checkInVenueError(c, ticket.event_id, venueId);
  if (venueError) return c.json({ error: venueError }, 403);
  if (ticket.venue_id && ticket.venue_id !== venueId) return c.json({ error: "wrong_venue" }, 403);
  const auth = c.get("auth");
  const result = await checkIn(c.env.DB, { ticketId, venueId, actorId: auth.actorId, organizationId: auth.organizationId, action: "ticket.verified" });
  return c.json(result, result.outcome === "accepted" ? 200 : 409);
});

app.post("/api/events/:eventId/attendees/:attendeeId/check-in", requireScope("checkin:write"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const body = await jsonBody(c);
  const venueId = optionalString(body.venueId);
  const venueError = await checkInVenueError(c, event.id, venueId);
  if (venueError) return c.json({ error: venueError }, 403);
  const attendee = await c.env.DB.prepare("SELECT a.id, a.venue_id, t.id AS ticket_id, t.status FROM attendees a JOIN tickets t ON t.attendee_id = a.id WHERE a.id = ? AND a.event_id = ?")
    .bind(c.req.param("attendeeId"), event.id).first<{ id: string; venue_id: string | null; ticket_id: string; status: string }>();
  if (!attendee) return c.json({ error: "not_found" }, 404);
  if (attendee.venue_id && attendee.venue_id !== venueId) return c.json({ error: "wrong_venue" }, 403);
  const auth = c.get("auth");
  const result = await checkIn(c.env.DB, { ticketId: attendee.ticket_id, venueId, actorId: auth.actorId, organizationId: auth.organizationId, action: "ticket.verified_manually" });
  return c.json(result, result.outcome === "accepted" ? 200 : 409);
});

app.post("/api/tickets/:ticketId/reverse-check-in", requireScope("admin"), async (c) => {
  const body = await jsonBody(c);
  const reason = requiredString(body, "reason");
  if (!reason || reason.length > 500) return badRequest(c, "reason is required");
  const ticket = await c.env.DB.prepare("SELECT t.id, t.checked_in_venue_id FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = ? AND e.organization_id = ?")
    .bind(c.req.param("ticketId"), c.get("auth").organizationId).first<{ id: string; checked_in_venue_id: string | null }>();
  if (!ticket) return c.json({ error: "not_found" }, 404);
  const attemptId = crypto.randomUUID();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO check_ins (id, ticket_id, venue_id, staff_user_id, outcome, reason)
      SELECT ?, id, checked_in_venue_id, ?, 'reversed', ? FROM tickets WHERE id = ? AND status = 'checked_in'`)
      .bind(attemptId, c.get("auth").actorId, reason, ticket.id),
    c.env.DB.prepare(`UPDATE tickets SET status = 'issued', checked_in_at = NULL, checked_in_by = NULL, checked_in_venue_id = NULL
      WHERE id = ? AND EXISTS (SELECT 1 FROM check_ins WHERE id = ?)`)
      .bind(ticket.id, attemptId),
    c.env.DB.prepare(`INSERT INTO audit_logs (id, organization_id, actor_id, action, target_type, target_id, metadata_json)
      SELECT ?, ?, ?, 'ticket.check_in_reversed', 'ticket', ticket_id, ? FROM check_ins WHERE id = ?`)
      .bind(crypto.randomUUID(), c.get("auth").organizationId, c.get("auth").actorId, JSON.stringify({ reason }), attemptId),
  ]);
  if (!results[0].meta.changes) return c.json({ error: "not_checked_in" }, 409);
  return c.json({ reversed: true });
});

app.post("/api/tickets/check-in-link", requireScope("checkin:write"), async (c) => {
  const limited = await rateLimit(c, `check-in:${c.get("auth").actorId}`, 120, 300);
  if (limited) return limited;
  const body = await jsonBody(c);
  const linkToken = requiredString(body, "linkToken");
  const venueId = optionalString(body.venueId);
  if (!linkToken) return badRequest(c, "linkToken is required");
  const record = await c.env.DB.prepare(`SELECT ml.id AS magic_link_id, t.id AS ticket_id, t.event_id, t.status, e.organization_id, a.venue_id
    FROM magic_links ml JOIN attendees a ON a.id = ml.attendee_id JOIN tickets t ON t.attendee_id = a.id
    JOIN events e ON e.id = t.event_id
    WHERE ml.token_hash = ? AND ml.purpose = 'ticket' AND ml.consumed_at IS NULL AND ml.expires_at > CURRENT_TIMESTAMP AND e.archived_at IS NULL`)
    .bind(await sha256(linkToken)).first<{ magic_link_id: string; ticket_id: string; event_id: string; status: string; organization_id: string; venue_id: string | null }>();
  if (!record || record.organization_id !== c.get("auth").organizationId) return c.json({ error: "not_found" }, 404);
  const venueError = await checkInVenueError(c, record.event_id, venueId);
  if (venueError) return c.json({ error: venueError }, 403);
  if (record.venue_id && record.venue_id !== venueId) return c.json({ error: "wrong_venue" }, 403);
  const auth = c.get("auth");
  const result = await checkIn(c.env.DB, { ticketId: record.ticket_id, venueId, actorId: auth.actorId, organizationId: auth.organizationId, action: "ticket.verified", magicLinkId: record.magic_link_id });
  return c.json(result, result.outcome === "accepted" ? 200 : 409);
});

app.post("/api/messages/:threadId", requireScope("messages:write"), async (c) => {
  const limited = await rateLimit(c, `message:${c.get("auth").actorId}`, 60, 300);
  if (limited) return limited;
  const body = await jsonBody(c);
  const ciphertext = requiredString(body, "ciphertext");
  const algorithm = requiredString(body, "algorithm");
  const keyGeneration = optionalInteger(body.keyGeneration);
  if (!ciphertext || !algorithm || !keyGeneration) return badRequest(c, "ciphertext, algorithm, and keyGeneration are required");
  const thread = await c.env.DB.prepare("SELECT mt.id, e.organization_id FROM message_threads mt JOIN events e ON e.id = mt.event_id WHERE mt.id = ?").bind(c.req.param("threadId")).first<{ id: string; organization_id: string }>();
  if (!thread || thread.organization_id !== c.get("auth").organizationId) return c.json({ error: "not_found" }, 404);
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO encrypted_messages (id, thread_id, sender_kind, ciphertext, algorithm, key_generation) VALUES (?, ?, 'organizer', ?, ?, ?)")
    .bind(id, thread.id, base64ToBytes(ciphertext), algorithm, keyGeneration).run();
  return c.json({ id }, 201);
});

app.post("/api/messages/:threadId/key-envelopes", requireScope("messages:write"), async (c) => {
  const thread = await organizerThread(c);
  if (!thread) return c.json({ error: "not_found" }, 404);
  return createKeyEnvelope(c, thread.id);
});

app.get("/api/messages/:threadId/key-envelopes", requireScope("messages:write"), async (c) => {
  const thread = await organizerThread(c);
  if (!thread) return c.json({ error: "not_found" }, 404);
  return listKeyEnvelopes(c, thread.id);
});

app.put("/api/messages/:threadId/attachments", requireScope("messages:write"), async (c) => {
  const thread = await organizerThread(c);
  if (!thread) return c.json({ error: "not_found" }, 404);
  return storeEncryptedAttachment(c, thread.id);
});

app.get("/api/messages/:threadId/attachments/:attachmentId", requireScope("messages:write"), async (c) => {
  const thread = await organizerThread(c);
  if (!thread) return c.json({ error: "not_found" }, 404);
  return readEncryptedAttachment(c, thread.id);
});

app.get("/public/events/:eventId", async (c) => {
  const event = await c.env.DB.prepare("SELECT id, name, description, starts_at, ends_at, timezone, capacity, registration_mode FROM events WHERE id = ? AND status = 'published'").bind(c.req.param("eventId")).first();
  if (!event) return c.json({ error: "not_found" }, 404);
  const fields = await c.env.DB.prepare("SELECT id, field_key, label, field_type, required, options_json FROM form_fields WHERE event_id = ? AND retired_at IS NULL ORDER BY sort_order").bind(c.req.param("eventId")).all();
  return c.json({ event, fields: fields.results, turnstileSiteKey: c.env.TURNSTILE_SITE_KEY ?? null });
});

app.get("/public/events/:eventId/schedule", async (c) => {
  const event = await c.env.DB.prepare("SELECT id, name, description, timezone, scheduling_enabled, schedule_status FROM events WHERE id = ? AND scheduling_enabled = 1 AND archived_at IS NULL")
    .bind(c.req.param("eventId")).first();
  if (!event) return c.json({ error: "not_found" }, 404);
  const options = await c.env.DB.prepare(`SELECT o.id, o.starts_at, o.ends_at, o.note,
      SUM(CASE WHEN r.response = 'yes' THEN 1 ELSE 0 END) AS yes,
      SUM(CASE WHEN r.response = 'maybe' THEN 1 ELSE 0 END) AS maybe,
      SUM(CASE WHEN r.response = 'no' THEN 1 ELSE 0 END) AS no
    FROM schedule_options o LEFT JOIN schedule_responses r ON r.option_id = o.id
    WHERE o.event_id = ? GROUP BY o.id ORDER BY o.starts_at`).bind(c.req.param("eventId")).all<{ id: string; starts_at: string; ends_at: string; note: string; yes: number; maybe: number; no: number }>();
  return c.json({ event, options: options.results.map((option) => scheduleOptionForClient(option, String(event.timezone ?? "Asia/Tokyo"))) });
});

app.post("/public/events/:eventId/schedule/responses", async (c) => {
  const body = await jsonBody(c);
  const respondentId = requiredString(body, "respondentId");
  const respondentName = requiredString(body, "respondentName");
  const response = requiredString(body, "response");
  const optionId = requiredString(body, "optionId");
  if (!respondentId || respondentId.length > 128 || !respondentName || respondentName.length > 200 || !optionId || !["yes", "maybe", "no"].includes(response ?? "")) return badRequest(c, "invalid schedule response");
  const event = await c.env.DB.prepare("SELECT id FROM events WHERE id = ? AND scheduling_enabled = 1 AND schedule_status != 'confirmed' AND archived_at IS NULL").bind(c.req.param("eventId")).first();
  const option = await c.env.DB.prepare("SELECT id FROM schedule_options WHERE id = ? AND event_id = ?").bind(optionId, c.req.param("eventId")).first();
  if (!event || !option) return c.json({ error: "schedule_not_available" }, 409);
  await c.env.DB.prepare(`INSERT INTO schedule_responses (id, event_id, option_id, respondent_id, respondent_name, response)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(option_id, respondent_id) DO UPDATE SET respondent_name = excluded.respondent_name, response = excluded.response, updated_at = CURRENT_TIMESTAMP`)
    .bind(crypto.randomUUID(), c.req.param("eventId"), optionId, respondentId, respondentName, response).run();
  await recordScheduleRevision(c.env.DB, c.req.param("eventId"), "availability_submitted", { optionId });
  return c.json({ saved: true }, 201);
});

app.post("/public/events/:eventId/schedule/agent-connections", async (c) => {
  const limited = await rateLimit(c, `agent-connection:${clientIp(c)}`, 30, 3600);
  if (limited) return limited;
  const body = await jsonBody(c);
  const respondentId = requiredString(body, "respondentId");
  const respondentName = requiredString(body, "respondentName");
  if (!respondentId || respondentId.length > 128 || !respondentName || respondentName.length > 200) return badRequest(c, "invalid agent connection");
  const event = await c.env.DB.prepare("SELECT id FROM events WHERE id = ? AND scheduling_enabled = 1 AND schedule_status != 'confirmed' AND archived_at IS NULL").bind(c.req.param("eventId")).first<{ id: string }>();
  if (!event) return c.json({ error: "schedule_not_available" }, 409);
  const token = `tsu_agent_${randomToken()}`;
  await c.env.DB.prepare("INSERT INTO agent_connections (id, event_id, respondent_id, respondent_name, token_hash, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+365 days'))")
    .bind(crypto.randomUUID(), event.id, respondentId, respondentName, await sha256(token)).run();
  const url = new URL(c.req.url);
  return c.json({ mcpUrl: `${url.origin}/mcp`, token, expiresInDays: 365 }, 201);
});

app.get("/public/events/:eventId/schedule/agent-connections", async (c) => {
  const respondentId = c.req.query("respondentId");
  if (!respondentId || respondentId.length > 128) return badRequest(c, "respondentId is required");
  const connections = await c.env.DB.prepare("SELECT id, scope, expires_at, revoked_at, created_at FROM agent_connections WHERE event_id = ? AND respondent_id = ? ORDER BY created_at DESC")
    .bind(c.req.param("eventId"), respondentId).all();
  return c.json({ connections: connections.results });
});

app.delete("/public/events/:eventId/schedule/agent-connections/:connectionId", async (c) => {
  const body = await jsonBody(c);
  const respondentId = requiredString(body, "respondentId");
  if (!respondentId || respondentId.length > 128) return badRequest(c, "respondentId is required");
  const updated = await c.env.DB.prepare("UPDATE agent_connections SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND event_id = ? AND respondent_id = ? AND revoked_at IS NULL")
    .bind(c.req.param("connectionId"), c.req.param("eventId"), respondentId).run();
  if (!updated.meta.changes) return c.json({ error: "connection_not_found" }, 404);
  return c.json({ revoked: true });
});

app.post("/public/events/:eventId/register", async (c) => {
  const limited = await rateLimit(c, `register:${c.req.param("eventId")}:${clientIp(c)}`, 20, 300);
  if (limited) return limited;
  if (c.env.TURNSTILE_SITE_KEY) {
    const body = await jsonBody(c);
    const token = requiredString(body, "turnstileToken");
    if (!token || !c.env.TURNSTILE_SECRET) return c.json({ error: "turnstile_required" }, 403);
    const form = new FormData();
    form.set("secret", c.env.TURNSTILE_SECRET);
    form.set("response", token);
    form.set("remoteip", clientIp(c));
    const validation = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    if (!validation.ok || !(await validation.json<{ success: boolean }>()).success) return c.json({ error: "turnstile_failed" }, 403);
  }
  const event = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ? AND status = 'published'
    AND (registration_opens_at IS NULL OR datetime(registration_opens_at) <= CURRENT_TIMESTAMP)
    AND (registration_closes_at IS NULL OR datetime(registration_closes_at) > CURRENT_TIMESTAMP)`).bind(c.req.param("eventId")).first<EventRow>();
  if (!event || event.registration_mode === "walk_in") return c.json({ error: "registration_unavailable" }, 404);
  return registerAttendee(c, event, false);
});

app.get("/public/magic-links/:token", async (c) => {
  const limited = await rateLimit(c, `magic-link:${clientIp(c)}`, 30, 300);
  if (limited) return limited;
  const token = c.req.param("token");
  const link = await c.env.DB.prepare("SELECT ml.id, ml.attendee_id FROM magic_links ml WHERE ml.token_hash = ? AND ml.purpose = 'ticket' AND ml.consumed_at IS NULL AND ml.expires_at > CURRENT_TIMESTAMP")
    .bind(await sha256(token)).first<{ id: string; attendee_id: string }>();
  if (!link) return c.json({ error: "link_expired_or_used" }, 400);
  const sessionToken = randomToken();
  const sessionId = crypto.randomUUID();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO participant_sessions (id, attendee_id, token_hash, expires_at)
      SELECT ?, attendee_id, ?, datetime('now', '+12 hours') FROM magic_links
      WHERE id = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP`)
      .bind(sessionId, await sha256(sessionToken), link.id),
    c.env.DB.prepare(`UPDATE magic_links SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?
      AND EXISTS (SELECT 1 FROM participant_sessions WHERE id = ?)` ).bind(link.id, sessionId),
  ]);
  if (!results[0].meta.changes) return c.json({ error: "link_expired_or_used" }, 400);
  c.header("Set-Cookie", participantCookie(sessionToken));
  return c.redirect("/ticket");
});

app.post("/public/participant/passkeys/authentication/options", async (c) => {
  const limited = await rateLimit(c, `participant-auth:${clientIp(c)}`, 30, 300);
  if (limited) return limited;
  const options = await generateAuthenticationOptions({ rpID: c.env.RP_ID, userVerification: "required" });
  const challengeId = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO participant_auth_challenges (id, challenge, expires_at) VALUES (?, ?, datetime('now', '+5 minutes'))")
    .bind(challengeId, options.challenge).run();
  return c.json({ challengeId, options });
});

app.post("/public/participant/passkeys/authentication/verify", async (c) => {
  const limited = await rateLimit(c, `participant-auth:${clientIp(c)}`, 30, 300);
  if (limited) return limited;
  const body = await jsonBody(c);
  const challengeId = requiredString(body, "challengeId");
  const response = body.response;
  if (!challengeId || !isAuthenticationResponse(response)) return badRequest(c, "invalid authentication response");
  const challenge = await c.env.DB.prepare("SELECT id, challenge FROM participant_auth_challenges WHERE id = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP")
    .bind(challengeId).first<{ id: string; challenge: string }>();
  const passkey = await c.env.DB.prepare("SELECT id, attendee_id, credential_id, public_key, counter, transports_json FROM passkeys WHERE credential_id = ? AND attendee_id IS NOT NULL")
    .bind(response.id).first<{ id: string; attendee_id: string; credential_id: string; public_key: ArrayBuffer; counter: number; transports_json: string }>();
  if (!challenge || !passkey) return c.json({ error: "challenge_or_credential_not_found" }, 400);
  const verification = await verifyAuthenticationResponse({
    response, expectedChallenge: challenge.challenge, expectedOrigin: c.env.APP_ORIGIN, expectedRPID: c.env.RP_ID, requireUserVerification: true,
    credential: { id: passkey.credential_id, publicKey: new Uint8Array(passkey.public_key), counter: passkey.counter, transports: parseAuthenticatorTransports(passkey.transports_json) },
  }).catch(() => null);
  if (!verification?.verified) return c.json({ error: "passkey_verification_failed" }, 400);
  if (!await consumeAuthChallenge(c.env.DB, "participant_auth_challenges", challenge.id)) return c.json({ error: "challenge_expired" }, 400);
  const sessionToken = randomToken();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE passkeys SET counter = ? WHERE id = ?").bind(verification.authenticationInfo.newCounter, passkey.id),
    c.env.DB.prepare("INSERT INTO participant_sessions (id, attendee_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+12 hours'))")
      .bind(crypto.randomUUID(), passkey.attendee_id, await sha256(sessionToken)),
  ]);
  c.header("Set-Cookie", participantCookie(sessionToken));
  return c.json({ verified: true });
});

app.post("/public/tickets/:ticketId/passkeys/options", async (c) => {
  const ticket = await ticketFromPossession(c);
  if (!ticket) return c.json({ error: "not_found" }, 404);
  const existing = await c.env.DB.prepare("SELECT credential_id, transports_json FROM passkeys WHERE attendee_id = ?").bind(ticket.attendee_id).all<{ credential_id: string; transports_json: string }>();
  const options = await generateRegistrationOptions({
    rpName: c.env.RP_NAME,
    rpID: c.env.RP_ID,
    userID: new TextEncoder().encode(ticket.attendee_id),
    userName: ticket.email_normalized ?? ticket.name,
    userDisplayName: ticket.name,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    // @simplewebauthn's bundled DOM types lag the standard PRF extension.
    extensions: { prf: {} } as never,
    excludeCredentials: existing.results.map((credential) => ({ id: credential.credential_id, transports: parseAuthenticatorTransports(credential.transports_json) })),
  });
  const challengeId = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO webauthn_challenges (id, attendee_id, challenge, purpose, expires_at) VALUES (?, ?, ?, 'registration', datetime('now', '+5 minutes'))")
    .bind(challengeId, ticket.attendee_id, options.challenge).run();
  return c.json({ challengeId, options });
});

app.post("/public/tickets/:ticketId/passkeys/verify", async (c) => {
  const ticket = await ticketFromPossession(c);
  if (!ticket) return c.json({ error: "not_found" }, 404);
  const body = await jsonBody(c);
  const challengeId = requiredString(body, "challengeId");
  const response = body.response;
  if (!challengeId || !isRegistrationResponse(response)) return badRequest(c, "invalid registration response");
  const challenge = await c.env.DB.prepare("SELECT * FROM webauthn_challenges WHERE id = ? AND attendee_id = ? AND purpose = 'registration' AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP")
    .bind(challengeId, ticket.attendee_id).first<{ id: string; challenge: string }>();
  if (!challenge) return c.json({ error: "challenge_expired" }, 400);
  const verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: c.env.APP_ORIGIN, expectedRPID: c.env.RP_ID, requireUserVerification: true });
  if (!verification.verified || !verification.registrationInfo) return c.json({ error: "passkey_verification_failed" }, 400);
  const credential = verification.registrationInfo.credential;
  const prfCapable = hasPrfEnabled(response.clientExtensionResults) ? 1 : 0;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE webauthn_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(challenge.id),
    c.env.DB.prepare("INSERT INTO passkeys (id, attendee_id, credential_id, public_key, counter, transports_json, prf_capable) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), ticket.attendee_id, credential.id, credential.publicKey, credential.counter, JSON.stringify(response.response.transports ?? []), prfCapable),
  ]);
  return c.json({ verified: true, prfCapable: prfCapable === 1 }, 201);
});

app.post("/public/attendees/:attendeeId/passkeys/authentication/options", async (c) => {
  const attendeeId = c.req.param("attendeeId");
  const credentials = await c.env.DB.prepare("SELECT credential_id, transports_json FROM passkeys WHERE attendee_id = ?").bind(attendeeId).all<{ credential_id: string; transports_json: string }>();
  if (credentials.results.length === 0) return c.json({ error: "passkey_not_found" }, 404);
  const options = await generateAuthenticationOptions({
    rpID: c.env.RP_ID,
    userVerification: "required",
    allowCredentials: credentials.results.map((credential) => ({ id: credential.credential_id, transports: parseAuthenticatorTransports(credential.transports_json) })),
  });
  const challengeId = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO webauthn_challenges (id, attendee_id, challenge, purpose, expires_at) VALUES (?, ?, ?, 'authentication', datetime('now', '+5 minutes'))")
    .bind(challengeId, attendeeId, options.challenge).run();
  return c.json({ challengeId, options });
});

app.post("/public/attendees/:attendeeId/passkeys/authentication/verify", async (c) => {
  const attendeeId = c.req.param("attendeeId");
  const body = await jsonBody(c);
  const challengeId = requiredString(body, "challengeId");
  const response = body.response;
  if (!challengeId || !isAuthenticationResponse(response)) return badRequest(c, "invalid authentication response");
  const challenge = await c.env.DB.prepare("SELECT id, challenge FROM webauthn_challenges WHERE id = ? AND attendee_id = ? AND purpose = 'authentication' AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP")
    .bind(challengeId, attendeeId).first<{ id: string; challenge: string }>();
  const passkey = await c.env.DB.prepare("SELECT id, credential_id, public_key, counter FROM passkeys WHERE attendee_id = ? AND credential_id = ?").bind(attendeeId, response.id).first<{ id: string; credential_id: string; public_key: ArrayBuffer; counter: number }>();
  if (!challenge || !passkey) return c.json({ error: "challenge_or_credential_not_found" }, 400);
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: c.env.APP_ORIGIN,
    expectedRPID: c.env.RP_ID,
    credential: { id: passkey.credential_id, publicKey: new Uint8Array(passkey.public_key), counter: passkey.counter },
    requireUserVerification: true,
  }).catch(() => null);
  if (!verification?.verified) return c.json({ error: "passkey_verification_failed" }, 400);
  if (!await consumeAuthChallenge(c.env.DB, "webauthn_challenges", challenge.id)) return c.json({ error: "challenge_expired" }, 400);
  const sessionToken = randomToken();
  const sessionId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE passkeys SET counter = ? WHERE id = ?").bind(verification.authenticationInfo.newCounter, passkey.id),
    c.env.DB.prepare("INSERT INTO participant_sessions (id, attendee_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+12 hours'))").bind(sessionId, attendeeId, await sha256(sessionToken)),
  ]);
  c.header("Set-Cookie", `tsudoi_participant=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`);
  return c.json({ verified: true });
});

async function registerAttendee(c: Context<AppEnv>, event: EventRow, staffRegistration: boolean): Promise<Response> {
  const body = await jsonBody(c);
  const name = requiredString(body, "name");
  if (!name) return badRequest(c, "name is required");
  const email = optionalString(body.email)?.trim().toLowerCase();
  if (email && !email.includes("@")) return badRequest(c, "invalid email");
  const fields = await c.env.DB.prepare("SELECT id, field_key, field_type, required, options_json, staff_visibility FROM form_fields WHERE event_id = ? AND retired_at IS NULL").bind(event.id).all<FieldRow & { staff_visibility: string }>();
  const answers = isRecord(body.answers) ? body.answers : {};
  const isStaff = staffRegistration && c.get("auth").role === "staff";
  // Staff cannot supply or be required to answer fields they cannot view.
  if (isStaff && fields.results.some((field) => field.staff_visibility !== "visible" && answers[field.field_key] !== undefined)) return forbidden(c);
  const writableFields = fields.results.filter((field) => !isStaff || field.staff_visibility === "visible");
  for (const field of writableFields) {
    const answer = answers[field.field_key];
    if (field.required && !hasRequiredAnswer(field, answer)) return badRequest(c, `${field.field_key} is required`);
    if (answer !== undefined && !isValidFieldAnswer(field, answer)) return badRequest(c, `${field.field_key} is invalid`);
  }
  const attendeeId = crypto.randomUUID();
  const ticketId = crypto.randomUUID();
  const ticketToken = randomToken();
  const qrToken = randomToken();
  const venueId = optionalString(body.venueId);
  if (venueId && !await c.env.DB.prepare("SELECT id FROM venues WHERE id = ? AND event_id = ?").bind(venueId, event.id).first()) return badRequest(c, "invalid venue");
  if (staffRegistration && c.get("auth").role === "staff" && await checkInVenueError(c, event.id, venueId)) return forbidden(c);
  const source = staffRegistration ? "walk_in" : "public_form";
  const statements = [
    c.env.DB.prepare("INSERT INTO attendees (id, organization_id, event_id, venue_id, name, email_normalized, registration_source) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(attendeeId, event.organization_id, event.id, venueId ?? null, name, email ?? null, source),
    c.env.DB.prepare("INSERT INTO tickets (id, attendee_id, event_id, token_hash, token_key_id) VALUES (?, ?, ?, ?, ?)")
      .bind(ticketId, attendeeId, event.id, await sha256(ticketToken), "possession-v2"),
    c.env.DB.prepare("INSERT INTO ticket_qr_tokens (id, ticket_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 year'))")
      .bind(crypto.randomUUID(), ticketId, await sha256(qrToken)),
  ];
  for (const field of writableFields) if (answers[field.field_key] !== undefined) statements.push(c.env.DB.prepare("INSERT INTO attendee_answers (attendee_id, field_id, value_json) VALUES (?, ?, ?)").bind(attendeeId, field.id, JSON.stringify(answers[field.field_key])));
  try { await c.env.DB.batch(statements); }
  catch (error) {
    if (error instanceof Error && error.message.includes("capacity_reached")) return c.json({ error: "capacity_reached" }, 409);
    throw error;
  }
  let emailQueued = false;
  if (email) {
    const magicToken = randomToken();
    await c.env.DB.prepare("INSERT INTO magic_links (id, attendee_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, 'ticket', datetime('now', '+24 hours'))")
      .bind(crypto.randomUUID(), attendeeId, await sha256(magicToken)).run();
    const link = `${c.env.APP_ORIGIN}/public/magic-links/${encodeURIComponent(magicToken)}`;
    const ticketUrl = `${c.env.APP_ORIGIN}/public/tickets/${ticketId}/check-in/${qrToken}`;
    await c.env.NOTIFICATION_QUEUE.send({ type: "ticket_link", to: email, eventName: event.name, link, ticketUrl } satisfies NotificationJob);
    emailQueued = true;
  }
  return c.json({ attendeeId, ticketId, ticketToken, qrToken, emailQueued }, 201);
}

async function ticketFromPossession(c: Context<AppEnv>) {
  const body = await jsonBody(c);
  const token = requiredString(body, "ticketToken");
  if (!token) return undefined;
  const ticket = await c.env.DB.prepare("SELECT t.id, t.attendee_id, t.token_hash, a.name, a.email_normalized FROM tickets t JOIN attendees a ON a.id = t.attendee_id WHERE t.id = ? AND t.status IN ('issued', 'checked_in')")
    .bind(c.req.param("ticketId")).first<{ id: string; attendee_id: string; token_hash: string; name: string; email_normalized: string | null }>();
  return ticket && safeEqual(ticket.token_hash, await sha256(token)) ? ticket : undefined;
}

async function organizerThread(c: Context<AppEnv>) {
  return c.env.DB.prepare("SELECT mt.id FROM message_threads mt JOIN events e ON e.id = mt.event_id WHERE mt.id = ? AND e.organization_id = ?")
    .bind(c.req.param("threadId"), c.get("auth").organizationId).first<{ id: string }>();
}

const MCP_PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];
const SCHEDULE_SCOPES = ["schedule:read", "schedule:write"];
type McpPrincipal = { kind: "event" | "oauth"; respondentId: string; respondentName: string; scope: string; eventId: string | null; userId: string | null };
type PollEvent = { id: string; name: string; description: string; timezone: string; schedule_status: string; starts_at: string; ends_at: string; updated_at: string };
type AuthorizeRequest = { clientId: string; redirectUri: string; codeChallenge: string; scope: string; resource: string; state: string; clientName: string };

async function handleMcpRequest(c: Context<AppEnv>): Promise<Response> {
  const principal = await mcpPrincipal(c);
  if (principal instanceof Response) return principal;
  const protocolHeader = c.req.header("mcp-protocol-version");
  if (protocolHeader && !MCP_PROTOCOL_VERSIONS.includes(protocolHeader)) return c.json({ error: "unsupported_protocol_version" }, 400);
  const body = await jsonBody(c);
  const id = body.id ?? null;
  const method = requiredString(body, "method");
  if (body.jsonrpc !== "2.0" || !method) return mcpError(c, id, -32600, "Invalid Request");
  if (method === "notifications/initialized") return c.body(null, 202);
  if (method === "ping") return mcpResult(c, id, {});
  if (method === "initialize") {
    const params = isRecord(body.params) ? body.params : {};
    const requestedVersion = requiredString(params, "protocolVersion");
    const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requestedVersion ?? "") ? requestedVersion : "2025-11-25";
    return mcpResult(c, id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "tsudoi-scheduling", version: "0.2.0" }, instructions: "Coordinate only through this poll. Read get_poll before writing. Submit free intervals with update_scheduling_preferences, never calendar titles or attendee lists. Use suggest_slots for the overlap, propose_schedule_option when nothing overlaps, and the calendar object after confirmation. An OAuth connection must pass eventId; an event token is already scoped." });
  }
  if (method === "tools/list") return mcpResult(c, id, { tools: mcpTools() });
  if (method !== "tools/call") return mcpError(c, id, -32601, "Method not found");
  const params = isRecord(body.params) ? body.params : {};
  const toolName = requiredString(params, "name");
  const args = isRecord(params.arguments) ? params.arguments : {};
  if (!toolName) return mcpError(c, id, -32602, "Invalid params");
  return mcpResult(c, id, await mcpCallTool(c, principal, toolName, args));
}
function mcpTools() {
  const eventId = { type: "string", description: "Poll id. Required for an OAuth connection. Omit for an event-scoped token." };
  const constraints = { type: "object", additionalProperties: false, properties: { timeZone: { type: "string", description: "IANA time zone, for example Asia/Tokyo." }, durationMinutes: { type: "integer", minimum: 15, maximum: 480, description: "Longest meeting, in minutes, this person will accept." }, maxDurationMinutes: { type: "integer", minimum: 15, maximum: 480 }, windows: { type: "array", maxItems: 32, items: { type: "object", additionalProperties: false, required: ["start", "end"], properties: { start: { type: "string", description: "RFC 3339 start." }, end: { type: "string", description: "RFC 3339 end." } } } }, unavailableWeekdays: { type: "array", maxItems: 7, items: { type: "string", description: "iCalendar weekday: MO, TU, WE, TH, FR, SA, SU." } } } };
  const outputSchema = { type: "object", additionalProperties: true };
  return [
    { name: "list_my_polls", description: "List polls this connection can coordinate.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema, annotations: { readOnlyHint: true } },
    { name: "get_poll", description: "Read one poll: options with this connection's own answer, participant names, who has not answered, whether required participants are all yes, and an iCalendar VEVENT after confirmation.", inputSchema: { type: "object", properties: { eventId }, additionalProperties: false }, outputSchema, annotations: { readOnlyHint: true } },
    { name: "get_schedule_options", description: "Same snapshot as get_poll.", inputSchema: { type: "object", properties: { eventId }, additionalProperties: false }, outputSchema, annotations: { readOnlyHint: true } },
    { name: "get_schedule_status", description: "Read whether the poll is open, its revision, and the confirmed calendar when scheduling is closed.", inputSchema: { type: "object", properties: { eventId }, additionalProperties: false }, outputSchema, annotations: { readOnlyHint: true } },
    { name: "get_schedule_changes", description: "Read poll changes after a revision cursor. Summaries omit free/busy windows and calendar titles.", inputSchema: { type: "object", properties: { eventId, since: { type: "integer", minimum: 0 } }, additionalProperties: false }, outputSchema, annotations: { readOnlyHint: true } },
    { name: "suggest_slots", description: "Intersect submitted free windows. durationMinutes is capped at the shortest maximum each person accepted. Does not return anyone's raw windows.", inputSchema: { type: "object", properties: { eventId, durationMinutes: { type: "integer", minimum: 15, maximum: 480 } }, additionalProperties: false }, outputSchema, annotations: { readOnlyHint: true } },
    { name: "submit_schedule_availability", description: "Record this connection's yes, maybe, or no. Pass responses to answer several options at once. Do not include calendar details.", inputSchema: { type: "object", properties: { eventId, optionId: { type: "string" }, response: { type: "string", enum: ["yes", "maybe", "no"] }, responses: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["optionId", "response"], properties: { optionId: { type: "string" }, response: { type: "string", enum: ["yes", "maybe", "no"] } } } } }, additionalProperties: false }, outputSchema },
    { name: "get_scheduling_preferences", description: "Read this connection's saved availability summary and constraints.", inputSchema: { type: "object", properties: { eventId }, additionalProperties: false }, outputSchema, annotations: { readOnlyHint: true } },
    { name: "update_scheduling_preferences", description: "Save a short availability summary and RFC 3339 free windows. Never include calendar titles or attendee names.", inputSchema: { type: "object", properties: { eventId, availabilityText: { type: "string", maxLength: 2000 }, constraints }, required: ["availabilityText"], additionalProperties: false }, outputSchema },
    { name: "propose_schedule_option", description: "Add one candidate when the current options do not overlap. Use either a calendar date or an RFC 3339 start and end.", inputSchema: { type: "object", properties: { eventId, date: { type: "string" }, start: { type: "string" }, end: { type: "string" }, note: { type: "string", maxLength: 500 } }, additionalProperties: false }, outputSchema },
    { name: "join_poll", description: "Join a poll with the invite token, or the full invite URL.", inputSchema: { type: "object", properties: { inviteToken: { type: "string" } }, required: ["inviteToken"], additionalProperties: false }, outputSchema },
  ];
}
async function mcpCallTool(c: Context<AppEnv>, principal: McpPrincipal, toolName: string, args: JsonRecord) {
  const read = new Set(["list_my_polls", "get_poll", "get_schedule_options", "get_schedule_status", "get_schedule_changes", "suggest_slots", "get_scheduling_preferences"]);
  if (read.has(toolName) && !hasScheduleScope(principal.scope, "schedule:read")) return mcpToolError("This connection cannot read the schedule.");
  if (!read.has(toolName) && !hasScheduleScope(principal.scope, "schedule:write")) return mcpToolError("This connection cannot change the schedule.");
  if (toolName === "list_my_polls") return mcpToolData({ polls: await listPolls(c, principal) });
  if (toolName === "join_poll") return joinPoll(c, principal, args);
  const event = await pollFromArgs(c, principal, args);
  if (event instanceof Response || !isPollEvent(event)) return event;
  if (toolName === "get_poll" || toolName === "get_schedule_options") return mcpToolData(await pollSnapshot(c, event, principal.respondentId));
  if (toolName === "get_schedule_status") {
    const snapshot = await pollSnapshot(c, event, principal.respondentId);
    return mcpToolData({ event: { name: snapshot.event.name, timeZone: snapshot.event.timeZone, scheduleStatus: snapshot.event.scheduleStatus, updatedAt: snapshot.event.updatedAt, revision: snapshot.event.revision }, readyToConfirm: snapshot.readyToConfirm, calendar: snapshot.calendar });
  }
  if (toolName === "get_schedule_changes") return scheduleChanges(c, event, args);
  if (toolName === "suggest_slots") return suggestPollSlots(c, event, args);
  if (toolName === "get_scheduling_preferences") return readPreferences(c, event, principal);
  if (!isScheduleOpen(event)) return mcpToolError("Scheduling is closed, so this poll can no longer be changed.");
  if (toolName === "submit_schedule_availability") return submitAvailability(c, event, principal, args);
  if (toolName === "update_scheduling_preferences") return updatePreferences(c, event, principal, args);
  if (toolName === "propose_schedule_option") return proposeOption(c, event, principal, args);
  return mcpToolError("Unknown tool");
}
function isPollEvent(value: PollEvent | ReturnType<typeof mcpToolError>): value is PollEvent { return "id" in value && "schedule_status" in value; }
async function pollFromArgs(c: Context<AppEnv>, principal: McpPrincipal, args: JsonRecord): Promise<PollEvent | ReturnType<typeof mcpToolError>> {
  const requested = requiredString(args, "eventId");
  if (principal.eventId && requested && requested !== principal.eventId) return mcpToolError("That poll is not available to this connection.");
  const eventId = principal.eventId ?? requested;
  if (!eventId) return mcpToolError("eventId is required for this connection.");
  const event = await accessiblePoll(c, principal, eventId);
  return event ?? mcpToolError("That poll is not available to this connection.");
}
async function mcpPrincipal(c: Context<AppEnv>): Promise<McpPrincipal | Response> {
  const authorization = c.req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return mcpUnauthorized(c);
  const token = authorization.slice("Bearer ".length);
  if (token.startsWith("tsu_agent_")) {
    const connection = await c.env.DB.prepare("SELECT event_id, respondent_id, respondent_name, scope FROM agent_connections WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP")
      .bind(await sha256(token)).first<{ event_id: string; respondent_id: string; respondent_name: string; scope: string }>();
    if (!connection) return mcpUnauthorized(c, "invalid_token");
    return { kind: "event", respondentId: connection.respondent_id, respondentName: connection.respondent_name, scope: connection.scope, eventId: connection.event_id, userId: null };
  }
  const grant = await c.env.DB.prepare(`SELECT g.user_id, g.scope, g.resource, u.display_name FROM oauth_grants g JOIN users u ON u.id = g.user_id
    WHERE g.token_hash = ? AND g.revoked_at IS NULL AND g.expires_at > CURRENT_TIMESTAMP`).bind(await sha256(token)).first<{ user_id: string; scope: string; resource: string; display_name: string | null }>();
  if (!grant || grant.resource !== `${requestOrigin(c)}/mcp`) return mcpUnauthorized(c, "invalid_token");
  return { kind: "oauth", respondentId: grant.user_id, respondentName: grant.display_name || "Participant", scope: grant.scope, eventId: null, userId: grant.user_id };
}
async function listPolls(c: Context<AppEnv>, principal: McpPrincipal) {
  if (principal.kind === "event" && principal.eventId) {
    const event = await accessiblePoll(c, principal, principal.eventId);
    return event ? [pollSummary(event)] : [];
  }
  const rows = await c.env.DB.prepare(`SELECT id, name, timezone, schedule_status, updated_at FROM events e
    WHERE scheduling_enabled = 1 AND archived_at IS NULL AND (
      EXISTS (SELECT 1 FROM schedule_participants p WHERE p.event_id = e.id AND p.user_id = ?)
      OR EXISTS (SELECT 1 FROM event_organizers o WHERE o.event_id = e.id AND o.user_id = ?)
    ) ORDER BY updated_at DESC`).bind(principal.userId, principal.userId).all<PollEvent>();
  return rows.results.map(pollSummary);
}
function pollSummary(event: { id: string; name: string; timezone: string; schedule_status: string; updated_at: string }) {
  return { eventId: event.id, name: event.name, timeZone: event.timezone, scheduleStatus: event.schedule_status, updatedAt: event.updated_at };
}
async function accessiblePoll(c: Context<AppEnv>, principal: McpPrincipal, eventId: string) {
  const event = await c.env.DB.prepare(`SELECT id, name, description, timezone, schedule_status, starts_at, ends_at, updated_at FROM events
    WHERE id = ? AND scheduling_enabled = 1 AND archived_at IS NULL`).bind(eventId).first<PollEvent>();
  if (!event || principal.kind === "event") return event;
  const allowed = await c.env.DB.prepare(`SELECT 1 AS ok WHERE EXISTS (SELECT 1 FROM schedule_participants WHERE event_id = ? AND user_id = ?)
    OR EXISTS (SELECT 1 FROM event_organizers WHERE event_id = ? AND user_id = ?)`).bind(eventId, principal.userId, eventId, principal.userId).first();
  return allowed ? event : null;
}
async function pollSnapshot(c: Context<AppEnv>, event: PollEvent, respondentId: string) {
  const options = await c.env.DB.prepare(`SELECT o.id, o.starts_at, o.ends_at, o.note,
      SUM(CASE WHEN r.response = 'yes' THEN 1 ELSE 0 END) AS yes,
      SUM(CASE WHEN r.response = 'maybe' THEN 1 ELSE 0 END) AS maybe,
      SUM(CASE WHEN r.response = 'no' THEN 1 ELSE 0 END) AS no,
      MAX(CASE WHEN r.respondent_id = ? THEN r.response END) AS my_response
    FROM schedule_options o LEFT JOIN schedule_responses r ON r.option_id = o.id
    WHERE o.event_id = ? GROUP BY o.id ORDER BY o.starts_at`).bind(respondentId, event.id).all<{ id: string; starts_at: string; ends_at: string; note: string; yes: number | null; maybe: number | null; no: number | null; my_response: string | null }>();
  const participants = await c.env.DB.prepare(`SELECT display_name, role, EXISTS(SELECT 1 FROM schedule_responses r WHERE r.event_id = schedule_participants.event_id AND r.respondent_id = schedule_participants.respondent_id) AS answered
    FROM schedule_participants WHERE event_id = ? ORDER BY joined_at`).bind(event.id).all<{ display_name: string; role: string; answered: number }>();
  const revision = await c.env.DB.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM schedule_revisions WHERE event_id = ?").bind(event.id).first<{ revision: number }>();
  const calendar = event.schedule_status === "confirmed" && event.starts_at
    ? confirmedCalendar({ uid: event.id, title: event.name, startsAt: event.starts_at, endsAt: event.ends_at || event.starts_at, timeZone: event.timezone, url: `${requestOrigin(c)}/events/${event.id}/schedule` })
    : null;
  return {
    event: { id: event.id, name: event.name, description: event.description, timeZone: event.timezone, scheduleStatus: event.schedule_status, updatedAt: event.updated_at, revision: revision?.revision ?? 0 },
    options: options.results.map((option) => ({ ...scheduleOptionForClient(option, event.timezone), yes: option.yes ?? 0, maybe: option.maybe ?? 0, no: option.no ?? 0, myResponse: option.my_response })),
    participants: participants.results.map((participant) => ({ displayName: participant.display_name, role: participant.role, answered: Number(participant.answered) === 1 })),
    unanswered: participants.results.filter((participant) => Number(participant.answered) !== 1).map((participant) => participant.display_name),
    readyToConfirm: await readyOptionIds(c.env.DB, event.id),
    calendar,
  };
}
async function scheduleChanges(c: Context<AppEnv>, event: PollEvent, args: JsonRecord) {
  const since = args.since === undefined ? 0 : args.since;
  if (typeof since !== "number" || !Number.isInteger(since) || since < 0) return mcpToolError("since must be a non-negative integer.");
  const rows = await c.env.DB.prepare("SELECT revision, kind, summary_json, created_at FROM schedule_revisions WHERE event_id = ? AND revision > ? ORDER BY revision LIMIT 50")
    .bind(event.id, since).all<{ revision: number; kind: string; summary_json: string; created_at: string }>();
  const current = await c.env.DB.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM schedule_revisions WHERE event_id = ?").bind(event.id).first<{ revision: number }>();
  return mcpToolData({ revision: current?.revision ?? 0, changes: rows.results.map((row) => ({ revision: row.revision, kind: row.kind, at: row.created_at, summary: safeJson(row.summary_json) })) });
}
async function suggestPollSlots(c: Context<AppEnv>, event: PollEvent, args: JsonRecord) {
  const durationMinutes = args.durationMinutes;
  if (durationMinutes !== undefined && (typeof durationMinutes !== "number" || !Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480)) return mcpToolError("durationMinutes must be an integer from 15 to 480.");
  const saved = await c.env.DB.prepare("SELECT constraints_json FROM scheduling_preferences WHERE event_id = ?").bind(event.id).all<{ constraints_json: string }>();
  const constraints = saved.results.flatMap((row) => { const parsed = parseConstraints(safeJson(row.constraints_json)); return parsed ? [parsed] : []; });
  const suggestion = suggestSlots({ constraints, durationMinutes: typeof durationMinutes === "number" ? durationMinutes : undefined, now: Date.now() });
  const options = await c.env.DB.prepare("SELECT id, starts_at, ends_at FROM schedule_options WHERE event_id = ? ORDER BY starts_at").bind(event.id).all<{ id: string; starts_at: string; ends_at: string }>();
  return mcpToolData({ durationMinutes: suggestion.durationMinutes, slots: suggestion.slots, matchingOptions: options.results.map((option) => ({ optionId: option.id, covered: optionCovered(option, suggestion.slots, event.timezone) })) });
}
function optionCovered(option: { starts_at: string; ends_at: string }, slots: Array<{ start: string; end: string }>, timeZone: string) {
  if (slots.length === 0) return false;
  if (canonicalDate(option.starts_at) === option.starts_at) return slots.some((slot) => calendarDate(slot.start, timeZone) === option.starts_at);
  const start = Date.parse(option.starts_at);
  const end = Date.parse(option.ends_at);
  return slots.some((slot) => Date.parse(slot.start) < end && Date.parse(slot.end) > start);
}
async function readPreferences(c: Context<AppEnv>, event: PollEvent, principal: McpPrincipal) {
  const preferences = await c.env.DB.prepare("SELECT availability_text, constraints_json, updated_at FROM scheduling_preferences WHERE event_id = ? AND respondent_id = ?")
    .bind(event.id, principal.respondentId).first<{ availability_text: string; constraints_json: string; updated_at: string }>();
  return mcpToolData({ preferences: preferences ? { availabilityText: preferences.availability_text, constraints: parseConstraints(safeJson(preferences.constraints_json)) ?? {}, updatedAt: preferences.updated_at } : null });
}
async function submitAvailability(c: Context<AppEnv>, event: PollEvent, principal: McpPrincipal, args: JsonRecord) {
  const updates = availabilityUpdates(args);
  if (!updates) return mcpToolError("Provide optionId and response, or responses with up to 20 answers.");
  const found = await c.env.DB.prepare(`SELECT id FROM schedule_options WHERE event_id = ? AND id IN (${updates.map(() => "?").join(",")})`).bind(event.id, ...updates.map((update) => update.optionId)).all<{ id: string }>();
  if (found.results.length !== new Set(updates.map((update) => update.optionId)).size) return mcpToolError("One or more options are not on this poll.");
  await ensureScheduleParticipant(c, event.id, principal);
  await c.env.DB.batch(updates.map((update) => c.env.DB.prepare(`INSERT INTO schedule_responses (id, event_id, option_id, respondent_id, respondent_name, response)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(option_id, respondent_id) DO UPDATE SET respondent_name = excluded.respondent_name, response = excluded.response, updated_at = CURRENT_TIMESTAMP`)
    .bind(crypto.randomUUID(), event.id, update.optionId, principal.respondentId, principal.respondentName, update.response)));
  await recordScheduleRevision(c.env.DB, event.id, "availability_submitted", { optionIds: updates.map((update) => update.optionId) });
  return mcpToolData({ saved: true, responses: updates });
}
async function updatePreferences(c: Context<AppEnv>, event: PollEvent, principal: McpPrincipal, args: JsonRecord) {
  const availabilityText = requiredString(args, "availabilityText");
  if (!availabilityText || availabilityText.length > 2000) return mcpToolError("availabilityText is required and must be at most 2000 characters.");
  const constraints = args.constraints === undefined ? {} : parseConstraints(args.constraints);
  if (!constraints) return mcpToolError("constraints must use timeZone, durationMinutes, windows, and unavailableWeekdays. Do not add calendar titles.");
  const constraintsJson = JSON.stringify(constraints);
  if (constraintsJson.length > 8000) return mcpToolError("constraints are too large.");
  await ensureScheduleParticipant(c, event.id, principal);
  await c.env.DB.prepare(`INSERT INTO scheduling_preferences (event_id, respondent_id, availability_text, constraints_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(event_id, respondent_id) DO UPDATE SET availability_text = excluded.availability_text, constraints_json = excluded.constraints_json, updated_at = CURRENT_TIMESTAMP`)
    .bind(event.id, principal.respondentId, availabilityText, constraintsJson).run();
  await recordScheduleRevision(c.env.DB, event.id, "preferences_updated", {});
  return mcpToolData({ saved: true, constraints });
}
async function proposeOption(c: Context<AppEnv>, event: PollEvent, principal: McpPrincipal, args: JsonRecord) {
  const limited = await rateLimit(c, `propose:${principal.respondentId}`, 20, 3600);
  if (limited) return mcpToolError("Too many proposed options. Try again later.");
  const slot = parseScheduleSlot(args);
  const note = optionalString(args.note) ?? "";
  if (!slot || note.length > 500) return mcpToolError("Provide a calendar date or an RFC 3339 start and end.");
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM schedule_options WHERE event_id = ?").bind(event.id).first<{ count: number }>();
  if ((count?.count ?? 0) >= 20) return mcpToolError("This poll already has 20 options.");
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare("INSERT INTO schedule_options (id, event_id, starts_at, ends_at, note) VALUES (?, ?, ?, ?, ?)").bind(id, event.id, slot.startsAt, slot.endsAt, note).run();
  } catch { return mcpToolError("That option already exists."); }
  await ensureScheduleParticipant(c, event.id, principal);
  await recordScheduleRevision(c.env.DB, event.id, "option_added", { optionId: id });
  return mcpToolData({ id, ...slot });
}
async function joinPoll(c: Context<AppEnv>, principal: McpPrincipal, args: JsonRecord) {
  const inviteToken = requiredString(args, "inviteToken");
  const token = inviteToken ? extractInviteToken(inviteToken) : undefined;
  if (!token) return mcpToolError("inviteToken must be the invite token or the full invite URL.");
  const limited = await rateLimit(c, `join:${principal.respondentId}`, 20, 3600);
  if (limited) return mcpToolError("Too many join attempts. Try again later.");
  const invite = await c.env.DB.prepare(`SELECT event_id, role FROM schedule_invites WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP`).bind(await sha256(token)).first<{ event_id: string; role: "required" | "optional" }>();
  if (!invite) return mcpToolError("That invite is not available.");
  if (principal.eventId && principal.eventId !== invite.event_id) return mcpToolError("This connection cannot join a different poll.");
  const event = await c.env.DB.prepare("SELECT id FROM events WHERE id = ? AND scheduling_enabled = 1 AND schedule_status != 'confirmed' AND archived_at IS NULL").bind(invite.event_id).first();
  if (!event) return mcpToolError("That poll is no longer accepting participants.");
  await c.env.DB.prepare(`INSERT INTO schedule_participants (event_id, respondent_id, user_id, display_name, role) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(event_id, respondent_id) DO UPDATE SET display_name = excluded.display_name, role = CASE WHEN schedule_participants.role = 'required' OR excluded.role = 'required' THEN 'required' ELSE 'optional' END`)
    .bind(invite.event_id, principal.respondentId, principal.userId, principal.respondentName, invite.role).run();
  await recordScheduleRevision(c.env.DB, invite.event_id, "participant_joined", { displayName: principal.respondentName, role: invite.role });
  return mcpToolData({ joined: true, eventId: invite.event_id, role: invite.role });
}
async function ensureScheduleParticipant(c: Context<AppEnv>, eventId: string, principal: McpPrincipal) {
  await c.env.DB.prepare(`INSERT INTO schedule_participants (event_id, respondent_id, user_id, display_name, role) VALUES (?, ?, ?, ?, 'optional')
    ON CONFLICT(event_id, respondent_id) DO UPDATE SET display_name = excluded.display_name`)
    .bind(eventId, principal.respondentId, principal.userId, principal.respondentName).run();
}
function availabilityUpdates(args: JsonRecord): Array<{ optionId: string; response: string }> | undefined {
  if (Array.isArray(args.responses)) {
    if (args.responses.length === 0 || args.responses.length > 20) return undefined;
    const updates: Array<{ optionId: string; response: string }> = [];
    for (const item of args.responses) {
      if (!isRecord(item)) return undefined;
      const optionId = requiredString(item, "optionId");
      const response = requiredString(item, "response");
      if (!optionId || !response || !["yes", "maybe", "no"].includes(response)) return undefined;
      updates.push({ optionId, response });
    }
    return updates;
  }
  const optionId = requiredString(args, "optionId");
  const response = requiredString(args, "response");
  if (!optionId || !response || !["yes", "maybe", "no"].includes(response)) return undefined;
  return [{ optionId, response }];
}
function isScheduleOpen(event: PollEvent) { return event.schedule_status !== "confirmed"; }
function hasScheduleScope(scope: string, required: string) { return scope.split(/\s+/).includes(required); }
function safeJson(value: string): unknown { try { return JSON.parse(value); } catch { return {}; } }
function mcpToolData(value: unknown) { return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }; }
function mcpToolError(text: string) { return { content: [{ type: "text", text }], isError: true }; }
function mcpResult(c: Context<AppEnv>, id: unknown, result: unknown) { return mcpResponse(c, { jsonrpc: "2.0", id, result }); }
function mcpError(c: Context<AppEnv>, id: unknown, code: number, message: string) { return mcpResponse(c, { jsonrpc: "2.0", id, error: { code, message } }); }
function mcpResponse(c: Context<AppEnv>, payload: unknown) {
  const accept = c.req.header("accept") ?? "";
  if (accept.includes("text/event-stream") && !accept.includes("application/json")) return c.body(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, 200, { "content-type": "text/event-stream" });
  return c.json(payload);
}
function mcpUnauthorized(c: Context<AppEnv>, error?: string) {
  const metadata = `${requestOrigin(c)}/.well-known/oauth-protected-resource/mcp`;
  c.header("WWW-Authenticate", error ? `Bearer realm="tsudoi", error="${error}", resource_metadata="${metadata}"` : `Bearer realm="tsudoi", resource_metadata="${metadata}"`);
  return c.json({ error: "unauthorized" }, 401);
}
function requestOrigin(c: Context<AppEnv>) { return new URL(c.req.url).origin; }
function protectedResourceMetadata(origin: string) { return { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: SCHEDULE_SCOPES, bearer_methods_supported: ["header"] }; }
function authorizationServerMetadata(origin: string) {
  return { issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/revoke`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"], scopes_supported: SCHEDULE_SCOPES };
}
async function registerOauthClient(c: Context<AppEnv>) {
  const limited = await rateLimit(c, `oauth-register:${clientIp(c)}`, 30, 3600);
  if (limited) return limited;
  const body = await jsonBody(c);
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((item): item is string => typeof item === "string") : [];
  const clientName = optionalString(body.client_name) ?? "MCP client";
  const authMethod = optionalString(body.token_endpoint_auth_method) ?? "none";
  if (redirectUris.length < 1 || redirectUris.length > 5 || redirectUris.some((uri) => !allowedRedirectUri(uri)) || clientName.length > 100 || authMethod !== "none") return oauthError(c, "invalid_client_metadata", "redirect_uris must be https or loopback http, and this server only supports public clients.");
  if (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || body.grant_types.some((grant) => grant !== "authorization_code" && grant !== "refresh_token"))) return oauthError(c, "invalid_client_metadata", "Unsupported grant type.");
  if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.some((response) => response !== "code"))) return oauthError(c, "invalid_client_metadata", "response_type must be code.");
  const clientId = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris_json) VALUES (?, ?, ?)").bind(clientId, clientName, JSON.stringify(redirectUris)).run();
  return c.json({ client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: clientName, redirect_uris: redirectUris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: SCHEDULE_SCOPES.join(" ") }, 201);
}
async function renderOauthAuthorize(c: Context<AppEnv>) {
  const parsed = await readAuthorizeRequest(c, queryRecord(c));
  if (!parsed.ok) return parsed.redirectUri ? c.redirect(authorizeErrorRedirect(parsed.redirectUri, parsed.state, parsed.error), 302) : c.json({ error: parsed.error }, 400);
  const user = await schedulingUser(c);
  return c.html(user ? consentPage(parsed.request, user.displayName) : schedulerSignInPage(parsed.request));
}
async function createSchedulerSession(c: Context<AppEnv>) {
  const limited = await rateLimit(c, `oauth-session:${clientIp(c)}`, 30, 3600);
  if (limited) return limited;
  const body = await formRecord(c);
  const displayName = requiredString(body, "displayName");
  if (!displayName || displayName.length > 100) return badRequest(c, "displayName is required");
  const user = await issueSchedulerSession(c, displayName);
  const returnTo = safeAuthorizeReturn(optionalString(body.returnTo), requestOrigin(c));
  if (returnTo && (c.req.header("content-type") ?? "").includes("application/x-www-form-urlencoded")) return c.redirect(returnTo, 303);
  return c.json({ userId: user.id, displayName: user.displayName });
}
async function approveOauthAuthorize(c: Context<AppEnv>) {
  const body = await formRecord(c);
  const parsed = await readAuthorizeRequest(c, body);
  const json = (c.req.header("content-type") ?? "").includes("application/json");
  if (!parsed.ok) {
    if (!parsed.redirectUri) return c.json({ error: parsed.error }, 400);
    const location = authorizeErrorRedirect(parsed.redirectUri, parsed.state, parsed.error);
    return json ? c.json({ redirect: location }, 400) : c.redirect(location, 302);
  }
  const user = await schedulingUser(c);
  if (!user) return c.json({ error: "login_required" }, 401);
  if (requiredString(body, "approve") !== "yes") {
    const location = authorizeErrorRedirect(parsed.request.redirectUri, parsed.request.state, "access_denied");
    return json ? c.json({ redirect: location }, 400) : c.redirect(location, 302);
  }
  const code = `tsu_code_${randomToken()}`;
  await c.env.DB.prepare(`INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+5 minutes'))`)
    .bind(await sha256(code), parsed.request.clientId, user.id, parsed.request.redirectUri, parsed.request.codeChallenge, parsed.request.scope, parsed.request.resource).run();
  const location = new URL(parsed.request.redirectUri);
  location.searchParams.set("code", code);
  location.searchParams.set("state", parsed.request.state);
  return json ? c.json({ redirect: location.toString() }) : c.redirect(location.toString(), 302);
}
async function issueOauthToken(c: Context<AppEnv>) {
  const limited = await rateLimit(c, `oauth-token:${clientIp(c)}`, 60, 3600);
  if (limited) return limited;
  if (!(c.req.header("content-type") ?? "").includes("application/x-www-form-urlencoded")) return oauthError(c, "invalid_request", "Content-Type must be application/x-www-form-urlencoded.");
  const body = await formRecord(c);
  const clientId = requiredString(body, "client_id");
  const grantType = requiredString(body, "grant_type");
  if (!clientId || !await c.env.DB.prepare("SELECT client_id FROM oauth_clients WHERE client_id = ?").bind(clientId).first()) return oauthError(c, "invalid_client", "Unknown client.");
  if (grantType === "authorization_code") return exchangeAuthorizationCode(c, body, clientId);
  if (grantType === "refresh_token") return exchangeRefreshToken(c, body, clientId);
  return oauthError(c, "unsupported_grant_type", "Supported grants are authorization_code and refresh_token.");
}
async function exchangeAuthorizationCode(c: Context<AppEnv>, body: JsonRecord, clientId: string) {
  const code = requiredString(body, "code");
  const redirectUri = requiredString(body, "redirect_uri");
  const verifier = requiredString(body, "code_verifier");
  const resource = optionalString(body.resource);
  if (!code || !redirectUri || !verifier || !validPkce(verifier)) return oauthError(c, "invalid_request", "code, redirect_uri, and code_verifier are required.");
  const stored = await c.env.DB.prepare(`SELECT code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource FROM oauth_codes
    WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP`).bind(await sha256(code)).first<{ code_hash: string; client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string }>();
  if (!stored || stored.client_id !== clientId || stored.redirect_uri !== redirectUri || (resource && resource !== stored.resource)) return oauthError(c, "invalid_grant", "Authorization code is invalid.");
  if (!safeEqual(await pkceS256(verifier), stored.code_challenge)) return oauthError(c, "invalid_grant", "PKCE verification failed.");
  const consumed = await c.env.DB.prepare("UPDATE oauth_codes SET consumed_at = CURRENT_TIMESTAMP WHERE code_hash = ? AND consumed_at IS NULL").bind(stored.code_hash).run();
  if (!consumed.meta.changes) return oauthError(c, "invalid_grant", "Authorization code is invalid.");
  return issueGrant(c, stored);
}
async function exchangeRefreshToken(c: Context<AppEnv>, body: JsonRecord, clientId: string) {
  const refresh = requiredString(body, "refresh_token");
  const resource = optionalString(body.resource);
  if (!refresh) return oauthError(c, "invalid_request", "refresh_token is required.");
  const grant = await c.env.DB.prepare("SELECT id, client_id, user_id, scope, resource, revoked_at FROM oauth_grants WHERE refresh_token_hash = ?").bind(await sha256(refresh)).first<{ id: string; client_id: string; user_id: string; scope: string; resource: string; revoked_at: string | null }>();
  if (!grant || grant.client_id !== clientId) return oauthError(c, "invalid_grant", "Refresh token is invalid.");
  if (grant.revoked_at) {
    await c.env.DB.prepare("UPDATE oauth_grants SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL").bind(grant.user_id, grant.client_id).run();
    return oauthError(c, "invalid_grant", "Refresh token is invalid.");
  }
  if (resource && resource !== grant.resource) return oauthError(c, "invalid_grant", "Resource does not match the grant.");
  const rotated = await c.env.DB.prepare("UPDATE oauth_grants SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL AND refresh_expires_at > CURRENT_TIMESTAMP").bind(grant.id).run();
  if (!rotated.meta.changes) return oauthError(c, "invalid_grant", "Refresh token is invalid.");
  return issueGrant(c, grant);
}
async function issueGrant(c: Context<AppEnv>, grant: { user_id: string; client_id: string; scope: string; resource: string }) {
  const access = `tsu_oauth_${randomToken()}`;
  const refresh = `tsu_refresh_${randomToken()}`;
  await c.env.DB.prepare(`INSERT INTO oauth_grants (id, token_hash, refresh_token_hash, client_id, user_id, scope, resource, expires_at, refresh_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+1 hour'), datetime('now', '+30 days'))`)
    .bind(crypto.randomUUID(), await sha256(access), await sha256(refresh), grant.client_id, grant.user_id, grant.scope, grant.resource).run();
  return c.json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: grant.scope });
}
async function revokeOauthToken(c: Context<AppEnv>) {
  const body = await formRecord(c);
  const token = requiredString(body, "token");
  if (token) {
    const hash = await sha256(token);
    await c.env.DB.prepare("UPDATE oauth_grants SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? OR refresh_token_hash = ?").bind(hash, hash).run();
  }
  return c.body(null, 200);
}
async function readAuthorizeRequest(c: Context<AppEnv>, source: JsonRecord): Promise<{ ok: true; request: AuthorizeRequest } | { ok: false; error: string; redirectUri?: string; state?: string }> {
  const clientId = requiredString(source, "client_id");
  const redirectUri = requiredString(source, "redirect_uri");
  const client = clientId ? await c.env.DB.prepare("SELECT client_name, redirect_uris_json FROM oauth_clients WHERE client_id = ?").bind(clientId).first<{ client_name: string; redirect_uris_json: string }>() : null;
  const registered = client ? stringArray(client.redirect_uris_json) : [];
  if (!clientId || !client || !redirectUri || !registered.includes(redirectUri)) return { ok: false, error: "invalid_request" };
  const state = requiredString(source, "state");
  const resource = canonicalMcpResource(requestOrigin(c), requiredString(source, "resource"));
  const challenge = requiredString(source, "code_challenge");
  const scope = normalizeScope(optionalString(source.scope));
  if (requiredString(source, "response_type") !== "code" || requiredString(source, "code_challenge_method") !== "S256" || !challenge || !validPkce(challenge) || !state || state.length > 512 || !resource) return { ok: false, error: "invalid_request", redirectUri, state };
  if (!scope) return { ok: false, error: "invalid_scope", redirectUri, state };
  return { ok: true, request: { clientId, redirectUri, codeChallenge: challenge, scope, resource, state, clientName: client.client_name } };
}
async function schedulingUser(c: Context<AppEnv>): Promise<{ id: string; displayName: string } | null> {
  const organizerToken = cookieValue(c.req.header("cookie"), "tsudoi_organizer");
  if (organizerToken) {
    const organizer = await c.env.DB.prepare(`SELECT u.id, u.display_name FROM organizer_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP`).bind(await sha256(organizerToken)).first<{ id: string; display_name: string | null }>();
    if (organizer) return { id: organizer.id, displayName: organizer.display_name || "Organizer" };
  }
  const schedulerToken = cookieValue(c.req.header("cookie"), "tsudoi_scheduler");
  if (!schedulerToken) return null;
  const scheduler = await c.env.DB.prepare(`SELECT u.id, u.display_name FROM scheduler_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP`).bind(await sha256(schedulerToken)).first<{ id: string; display_name: string | null }>();
  return scheduler ? { id: scheduler.id, displayName: scheduler.display_name || "Participant" } : null;
}
async function issueSchedulerSession(c: Context<AppEnv>, displayName: string) {
  const existing = await schedulingUser(c);
  if (existing) return existing;
  const userId = crypto.randomUUID();
  const token = randomToken();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").bind(userId, displayName),
    c.env.DB.prepare("INSERT INTO scheduler_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+30 days'))").bind(crypto.randomUUID(), userId, await sha256(token)),
  ]);
  c.header("Set-Cookie", `tsudoi_scheduler=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
  return { id: userId, displayName };
}
function schedulerSignInPage(request: AuthorizeRequest) {
  return oauthPage("表示名を入力", `<p>${escapeHtml(request.clientName)} が、あなたの tsudoi の日程調整を読み書きしようとしています。</p><form method="post" action="/oauth/session"><input type="hidden" name="returnTo" value="${escapeHtml(authorizePath(request))}" /><label>表示名<input name="displayName" required maxlength="100" autocomplete="name" /></label><button>続ける</button></form>`);
}
function consentPage(request: AuthorizeRequest, displayName: string) {
  return oauthPage("日程調整を許可", `<p><strong>${escapeHtml(displayName)}</strong> として、${escapeHtml(request.clientName)} に参加中の日程調整の確認と回答を許可します。カレンダーの予定名は送りません。</p><form method="post" action="/oauth/authorize">${authorizeFields(request)}<button name="approve" value="yes">許可する</button><button name="approve" value="no">拒否する</button></form>`);
}
function oauthPage(title: string, body: string) {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><body style="font-family: sans-serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem;"><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}
function authorizeFields(request: AuthorizeRequest) {
  return ["response_type", "code", "client_id", request.clientId, "redirect_uri", request.redirectUri, "code_challenge", request.codeChallenge, "code_challenge_method", "S256", "resource", request.resource, "scope", request.scope, "state", request.state]
    .reduce((html, value, index, all) => index % 2 === 0 ? `${html}<input type="hidden" name="${escapeHtml(value)}" value="${escapeHtml(all[index + 1] ?? "")}" />` : html, "");
}
function authorizePath(request: AuthorizeRequest) {
  const params = new URLSearchParams({ response_type: "code", client_id: request.clientId, redirect_uri: request.redirectUri, code_challenge: request.codeChallenge, code_challenge_method: "S256", resource: request.resource, scope: request.scope, state: request.state });
  return `/oauth/authorize?${params.toString()}`;
}
function authorizeErrorRedirect(redirectUri: string, state: string | undefined, error: string) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}
function normalizeScope(value: string | undefined) {
  if (!value) return SCHEDULE_SCOPES.join(" ");
  const requested = value.split(/\s+/).filter(Boolean);
  if (requested.some((scope) => !SCHEDULE_SCOPES.includes(scope))) return undefined;
  return SCHEDULE_SCOPES.filter((scope) => requested.includes(scope)).join(" ");
}
function canonicalMcpResource(origin: string, resource: string | undefined) {
  if (!resource) return undefined;
  const trimmed = resource.endsWith("/") ? resource.slice(0, -1) : resource;
  return trimmed === `${origin}/mcp` ? `${origin}/mcp` : undefined;
}
function allowedRedirectUri(value: string) {
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch { return false; }
}
function validPkce(value: string) { return /^[A-Za-z0-9._~-]{43,128}$/.test(value); }
function safeAuthorizeReturn(value: string | undefined, origin: string) {
  if (!value?.startsWith("/oauth/authorize?")) return undefined;
  const url = new URL(value, origin);
  return url.origin === origin && url.pathname === "/oauth/authorize" ? `${url.pathname}${url.search}` : undefined;
}
function stringArray(value: string): string[] { const parsed = safeJson(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; }
function queryRecord(c: Context<AppEnv>): JsonRecord { return Object.fromEntries(new URL(c.req.url).searchParams.entries()); }
async function formRecord(c: Context<AppEnv>): Promise<JsonRecord> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) return jsonBody(c);
  try {
    const form = await c.req.parseBody();
    const record: JsonRecord = {};
    for (const [key, value] of Object.entries(form)) if (typeof value === "string") record[key] = value;
    return record;
  } catch { return {}; }
}
function oauthError(c: Context<AppEnv>, error: string, description: string) { return c.json({ error, error_description: description }, 400); }
async function readyOptionIds(db: D1Database, eventId: string) {
  const rows = await db.prepare(`SELECT o.id FROM schedule_options o WHERE o.event_id = ?
    AND EXISTS (SELECT 1 FROM schedule_participants p WHERE p.event_id = o.event_id AND p.role = 'required')
    AND NOT EXISTS (SELECT 1 FROM schedule_participants p WHERE p.event_id = o.event_id AND p.role = 'required'
      AND NOT EXISTS (SELECT 1 FROM schedule_responses r WHERE r.option_id = o.id AND r.respondent_id = p.respondent_id AND r.response = 'yes'))`).bind(eventId).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}
async function recordScheduleRevision(db: D1Database, eventId: string, kind: string, summary: JsonRecord) {
  const summaryJson = JSON.stringify(summary);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await db.batch([
        db.prepare(`INSERT INTO schedule_revisions (event_id, revision, kind, summary_json) SELECT ?, COALESCE(MAX(revision), 0) + 1, ?, ? FROM schedule_revisions WHERE event_id = ?`).bind(eventId, kind, summaryJson, eventId),
        db.prepare("UPDATE events SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(eventId),
      ]);
      return;
    } catch (error) { if (attempt === 1) throw error; }
  }
}
async function participantThread(c: Context<AppEnv>) {
  return c.env.DB.prepare("SELECT id FROM message_threads WHERE id = ? AND attendee_id = ?")
    .bind(c.req.param("threadId"), c.get("participantAttendeeId")).first<{ id: string }>();
}
async function storeEncryptedAttachment(c: Context<AppEnv>, threadId: string) {
  if (c.req.header("content-type")?.split(";")[0] !== "application/octet-stream") return badRequest(c, "encrypted binary body is required");
  const reader = c.req.raw.body?.getReader();
  if (!reader) return badRequest(c, "body is required");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 5_000_000) { await reader.cancel(); return c.json({ error: "payload_too_large" }, 413); }
    chunks.push(value);
  }
  if (total === 0) return badRequest(c, "body is required");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const id = crypto.randomUUID();
  const objectKey = `threads/${threadId}/${id}`;
  await c.env.ENCRYPTED_ATTACHMENTS.put(objectKey, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
  try {
    await c.env.DB.prepare("INSERT INTO encrypted_attachments (id, thread_id, object_key, byte_length) VALUES (?, ?, ?, ?)")
      .bind(id, threadId, objectKey, total).run();
  } catch (error) { await c.env.ENCRYPTED_ATTACHMENTS.delete(objectKey); throw error; }
  return c.json({ id, byteLength: total }, 201);
}
async function readEncryptedAttachment(c: Context<AppEnv>, threadId: string) {
  const attachment = await c.env.DB.prepare("SELECT object_key FROM encrypted_attachments WHERE id = ? AND thread_id = ?")
    .bind(c.req.param("attachmentId"), threadId).first<{ object_key: string }>();
  if (!attachment) return c.json({ error: "not_found" }, 404);
  const object = await c.env.ENCRYPTED_ATTACHMENTS.get(attachment.object_key);
  if (!object) return c.json({ error: "not_found" }, 404);
  return new Response(object.body, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
async function createKeyEnvelope(c: Context<AppEnv>, threadId: string) {
  const body = await jsonBody(c);
  const recipientKeyId = requiredString(body, "recipientKeyId");
  const encryptedKey = requiredString(body, "encryptedKey");
  const algorithm = requiredString(body, "algorithm");
  if (!recipientKeyId || !encryptedKey || !algorithm) return badRequest(c, "recipientKeyId, encryptedKey, and algorithm are required");
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO key_envelopes (id, thread_id, recipient_key_id, encrypted_key, algorithm) VALUES (?, ?, ?, ?, ?)")
    .bind(id, threadId, recipientKeyId, base64ToBytes(encryptedKey), algorithm).run();
  return c.json({ id }, 201);
}
async function listKeyEnvelopes(c: Context<AppEnv>, threadId: string) {
  const keyId = c.req.query("recipientKeyId");
  const rows = await c.env.DB.prepare("SELECT id, recipient_key_id, encrypted_key, algorithm, created_at FROM key_envelopes WHERE thread_id = ? AND (? IS NULL OR recipient_key_id = ?) ORDER BY created_at")
    .bind(threadId, keyId ?? null, keyId ?? null).all<{ id: string; recipient_key_id: string; encrypted_key: ArrayBuffer; algorithm: string; created_at: string }>();
  return c.json(rows.results.map((row) => ({ ...row, encrypted_key: bytesToBase64(row.encrypted_key) })));
}

async function requireOrganizer(c: Context<AppEnv>, next: () => Promise<void>) {
  const value = c.req.header("authorization");
  if (value?.startsWith("Bearer tsu_")) {
    const token = await c.env.DB.prepare("SELECT id, organization_id, scopes FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)").bind(await sha256(value.slice(7))).first<{ id: string; organization_id: string; scopes: string }>();
    if (!token) return c.json({ error: "unauthorized" }, 401);
    c.set("auth", { actorId: token.id, organizationId: token.organization_id, scopes: JSON.parse(token.scopes) as string[], role: "api_token", kind: "api_token" });
    return next();
  }
  const sessionToken = cookieValue(c.req.header("cookie"), "tsudoi_organizer");
  if (!sessionToken) return c.json({ error: "unauthorized" }, 401);
  const session = await c.env.DB.prepare(`SELECT s.user_id, s.organization_id, m.role
    FROM organizer_sessions s JOIN organization_members m ON m.organization_id = s.organization_id AND m.user_id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP`)
    .bind(await sha256(sessionToken)).first<{ user_id: string; organization_id: string; role: Role }>();
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const scopes = session.role === "owner" || session.role === "admin" ? ["admin"] : session.role === "staff" ? ["roster:read", "roster:write", "checkin:write"] : ["roster:read"];
  c.set("auth", { actorId: session.user_id, organizationId: session.organization_id, scopes, role: session.role, kind: "session" });
  await next();
}

async function requireParticipant(c: Context<AppEnv>, next: () => Promise<void>) {
  const token = cookieValue(c.req.header("cookie"), "tsudoi_participant");
  if (!token) return c.json({ error: "participant_unauthorized" }, 401);
  const session = await c.env.DB.prepare("SELECT attendee_id FROM participant_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP")
    .bind(await sha256(token)).first<{ attendee_id: string }>();
  if (!session) return c.json({ error: "participant_unauthorized" }, 401);
  c.set("participantAttendeeId", session.attendee_id);
  await next();
}

function requireScope(scope: string) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const scopes = c.get("auth").scopes;
    if (!scopes.includes("admin") && !scopes.includes(scope)) return c.json({ error: "forbidden" }, 403);
    await next();
  };
}

async function requireSession(c: Context<AppEnv>, next: () => Promise<void>) {
  if (c.get("auth").kind !== "session") return forbidden(c);
  await next();
}

function sameOrganization(c: Context<AppEnv>) { return c.req.param("organizationId") === c.get("auth").organizationId; }
function forbidden(c: Context<AppEnv>) { return c.json({ error: "forbidden" }, 403); }
function badRequest(c: Context<AppEnv>, message: string) { return c.json({ error: "bad_request", message }, 400); }
async function createEvent(c: Context<AppEnv>, organizationId: string, body: JsonRecord) {
  const name = requiredString(body, "name");
  const startsAt = requiredString(body, "startsAt");
  const endsAt = requiredString(body, "endsAt") || startsAt;
  const registrationMode = requiredString(body, "registrationMode");
  const schedulingEnabled = body.schedulingEnabled === true;
  const initialScheduleOptions = scheduleOptions(body.initialScheduleOptions);
  const registrationOpensAt = optionalString(body.registrationOpensAt);
  const registrationClosesAt = optionalString(body.registrationClosesAt);
  if (!name || (!schedulingEnabled && !startsAt) || !["advance", "walk_in", "hybrid"].includes(registrationMode ?? "") || (!schedulingEnabled && initialScheduleOptions.length > 0)) return badRequest(c, "invalid event");
  const optionKeys = new Set(initialScheduleOptions.map((option) => `${option.startsAt}/${option.endsAt}`));
  if (optionKeys.size !== initialScheduleOptions.length) return badRequest(c, "duplicate schedule options");
  const eventId = crypto.randomUUID();
  const preparedOptions = initialScheduleOptions.map((option) => ({ ...option, id: crypto.randomUUID() }));
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO events (id, organization_id, name, starts_at, ends_at, registration_mode, registration_opens_at, registration_closes_at, capacity, timezone, scheduling_enabled, schedule_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(eventId, organizationId, name, startsAt ?? "", endsAt ?? "", registrationMode, registrationOpensAt ?? null, registrationClosesAt ?? null, optionalInteger(body.capacity), optionalString(body.timezone) ?? "Asia/Tokyo", schedulingEnabled ? 1 : 0, schedulingEnabled ? "collecting" : "confirmed"),
    ...preparedOptions.map((option) => c.env.DB.prepare("INSERT INTO schedule_options (id, event_id, starts_at, ends_at, note) VALUES (?, ?, ?, ?, ?)").bind(option.id, eventId, option.startsAt, option.endsAt, option.note)),
    ...preparedOptions.map((option, index) => c.env.DB.prepare("INSERT INTO schedule_revisions (event_id, revision, kind, summary_json) VALUES (?, ?, 'option_added', ?)").bind(eventId, index + 1, JSON.stringify({ optionId: option.id }))),
  ]);
  if (c.get("auth").kind === "session") await c.env.DB.prepare("INSERT INTO event_organizers (event_id, user_id, role) VALUES (?, ?, 'organizer')")
    .bind(eventId, c.get("auth").actorId).run();
  await audit(c.env.DB, c.get("auth"), "event.created", "event", eventId);
  return c.json({ id: eventId }, 201);
}
type ScheduleOptionInput = { startsAt: string; endsAt: string; note: string };
function scheduleOptions(value: unknown): ScheduleOptionInput[] {
  if (!Array.isArray(value) || value.length > 20) return [];
  return value.flatMap((option) => {
    if (!isRecord(option)) return [];
    const slot = parseScheduleSlot(option);
    const note = optionalString(option.note) ?? "";
    return slot && note.length <= 500 ? [{ startsAt: slot.startsAt, endsAt: slot.endsAt, note }] : [];
  });
}
function scheduleOptionForClient(option: { id: string; starts_at: string; ends_at: string; note: string; [key: string]: unknown }, timeZone: string) {
  const allDay = canonicalDate(option.starts_at) === option.starts_at;
  return { ...option, allDay, date: allDay ? option.starts_at : calendarDate(option.starts_at, timeZone), start: allDay ? null : option.starts_at, end: allDay ? null : option.ends_at };
}
function scheduleSummary(event: EventRow) {
  const starts = event.starts_at ?? "";
  const timeZone = event.timezone ?? "Asia/Tokyo";
  const allDay = !starts || canonicalDate(starts) === starts;
  return { enabled: event.scheduling_enabled === 1, status: event.schedule_status, date: !starts ? null : allDay ? starts : calendarDate(starts, timeZone), startsAt: starts || null, endsAt: event.ends_at || null, allDay, timeZone };
}
async function eventForAuth(c: Context<AppEnv>) {
  const event = await c.env.DB.prepare("SELECT * FROM events WHERE id = ? AND organization_id = ? AND archived_at IS NULL").bind(c.req.param("eventId"), c.get("auth").organizationId).first<EventRow>();
  if (event && c.get("auth").role === "staff") {
    const assigned = await c.env.DB.prepare("SELECT 1 FROM venue_staff_assignments s JOIN venues v ON v.id = s.venue_id WHERE v.event_id = ? AND s.user_id = ?")
      .bind(event.id, c.get("auth").actorId).first();
    if (!assigned) return null;
  }
  return event;
}
async function jsonBody(c: Context<AppEnv>): Promise<JsonRecord> { try { const body = await c.req.json(); return isRecord(body) ? body : {}; } catch { return {}; } }
function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function fieldOptions(field: FieldRow): string[] {
  try { const value: unknown = JSON.parse(field.options_json); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
}
function answerValue(value: string): unknown { try { return JSON.parse(value); } catch { return value; } }
function hasRequiredAnswer(field: FieldRow, answer: unknown): boolean {
  if (field.field_type === "checkbox" || field.field_type === "consent") return answer === true;
  if (field.field_type === "multi_select") return Array.isArray(answer) && answer.length > 0;
  return typeof answer === "string" ? answer.trim().length > 0 : typeof answer === "number";
}
function isValidFieldAnswer(field: FieldRow, answer: unknown): boolean {
  const options = fieldOptions(field);
  if (field.field_type === "checkbox" || field.field_type === "consent") return typeof answer === "boolean";
  if (field.field_type === "multi_select") return Array.isArray(answer) && answer.every((item) => typeof item === "string" && options.includes(item));
  if (field.field_type === "single_select") return typeof answer === "string" && options.includes(answer);
  if (field.field_type === "number") return typeof answer === "number" || (typeof answer === "string" && answer.trim() !== "" && Number.isFinite(Number(answer)));
  if (field.field_type === "date") return typeof answer === "string" && /^\d{4}-\d{2}-\d{2}$/.test(answer);
  return typeof answer === "string";
}
function requiredString(body: JsonRecord, key: string) { const value = body[key]; return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function optionalString(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function optionalAvatarUrl(value: unknown) {
  const url = optionalString(value);
  if (!url || url.length > 280_000) return undefined;
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url) ? url : undefined;
}
function optionalInteger(value: unknown) { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null; }
function randomToken() { const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function sha256(value: string) { const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function base64ToBytes(value: string) { const decoded = atob(value); return Uint8Array.from(decoded, (char) => char.charCodeAt(0)); }
function bytesToBase64(value: ArrayBuffer) { return btoa(String.fromCharCode(...new Uint8Array(value))); }
function parseAuthenticatorTransports(value: string) {
  const allowed = ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"] as const;
  const isTransport = (item: unknown): item is typeof allowed[number] => typeof item === "string" && allowed.some((transport) => transport === item);
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter(isTransport) : []; } catch { return []; }
}
function hasPrfEnabled(value: unknown) {
  return isRecord(value) && isRecord(value.prf) && value.prf.enabled === true;
}
function isRegistrationResponse(value: unknown): value is RegistrationResponseJSON {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.rawId !== "string" || value.type !== "public-key" || !isRecord(value.response)) return false;
  return typeof value.response.clientDataJSON === "string" && typeof value.response.attestationObject === "string";
}
function isAuthenticationResponse(value: unknown): value is AuthenticationResponseJSON {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.rawId !== "string" || value.type !== "public-key" || !isRecord(value.response)) return false;
  return typeof value.response.clientDataJSON === "string" && typeof value.response.authenticatorData === "string" && typeof value.response.signature === "string";
}
function participantCookie(token: string) { return `tsudoi_participant=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`; }
function organizerCookie(token: string, maxAge = 43200) { return `tsudoi_organizer=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`; }
function cookieValue(header: string | undefined, name: string) {
  if (!header) return undefined;
  const prefix = `${name}=`;
  return header.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
}
function csvCell(value: string) {
  const safe = /^[\s]*[=+\-@]|^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
function csvAnswer(value: string) { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.join("; ") : typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean" ? String(parsed) : ""; } catch { return ""; } }
function clientIp(c: Context<AppEnv>) { return c.req.header("cf-connecting-ip") ?? "local"; }
async function inviteForToken(c: Context<AppEnv>) {
  return c.env.DB.prepare("SELECT id, organization_id, role, email_normalized FROM organization_invites WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP")
    .bind(await sha256(c.req.param("token") ?? "")).first<{ id: string; organization_id: string; role: string; email_normalized: string | null }>();
}
async function rateLimit(c: Context<AppEnv>, scope: string, maxAttempts: number, seconds: number): Promise<Response | null> {
  const bucket = await sha256(`${scope}:${Math.floor(Date.now() / (seconds * 1000))}`);
  const attempt = await c.env.DB.prepare(`INSERT INTO rate_limit_counters (bucket_key, attempts, expires_at) VALUES (?, 1, datetime('now', ?))
    ON CONFLICT(bucket_key) DO UPDATE SET attempts = attempts + 1 WHERE attempts < ? RETURNING attempts`)
    .bind(bucket, `+${seconds * 2} seconds`, maxAttempts).first();
  if (!attempt) { c.header("Retry-After", String(seconds)); return c.json({ error: "rate_limited" }, 429); }
  return null;
}
async function issueQrToken(db: D1Database, ticketId: string, lifetime: string) {
  const token = randomToken();
  await db.prepare("INSERT INTO ticket_qr_tokens (id, ticket_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', ?))")
    .bind(crypto.randomUUID(), ticketId, await sha256(token), lifetime).run();
  return token;
}
async function checkInVenueError(c: Context<AppEnv>, eventId: string, venueId: string | undefined) {
  if (venueId && !await c.env.DB.prepare("SELECT id FROM venues WHERE id = ? AND event_id = ?").bind(venueId, eventId).first()) return "invalid_venue";
  const auth = c.get("auth");
  if (auth.role !== "staff") return null;
  if (!venueId) return "venue_required";
  const assignment = await c.env.DB.prepare("SELECT 1 FROM venue_staff_assignments WHERE venue_id = ? AND user_id = ?")
    .bind(venueId, auth.actorId).first();
  return assignment ? null : "venue_not_assigned";
}
function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(left), encoder.encode(right));
}
async function consumeAuthChallenge(db: D1Database, table: "organizer_webauthn_challenges" | "participant_auth_challenges" | "webauthn_challenges", id: string) {
  const result = await db.prepare(`UPDATE ${table} SET consumed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP`).bind(id).run();
  return result.meta.changes === 1;
}
async function audit(db: D1Database, auth: OrganizerAuth, action: string, targetType: string, targetId: string, metadata: JsonRecord = {}) { await db.prepare("INSERT INTO audit_logs (id, organization_id, actor_id, action, target_type, target_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.organizationId, auth.actorId, action, targetType, targetId, JSON.stringify(metadata)).run(); }

type EventRow = { id: string; organization_id: string; name: string; status: string; archived_at?: string | null; registration_mode: string; capacity: number | null; timezone?: string; scheduling_enabled?: number; schedule_status?: string; starts_at?: string; ends_at?: string };
type FieldRow = { id: string; field_key: string; field_type: string; required: number; options_json: string };

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch, env: Cloudflare.Env) {
    for (const message of batch.messages) {
      const job = message.body;
      if (isTicketLinkJob(job)) {
        let ticketUrl = job.ticketUrl;
        if (!ticketUrl) {
          const rawToken = new URL(job.link).pathname.split("/").at(-1) ?? "";
          const ticket = await env.DB.prepare("SELECT t.id FROM magic_links ml JOIN tickets t ON t.attendee_id = ml.attendee_id WHERE ml.token_hash = ? AND ml.consumed_at IS NULL")
            .bind(await sha256(rawToken)).first<{ id: string }>();
          if (!ticket) throw new Error("Queued ticket link no longer has an active ticket");
          const qrToken = await issueQrToken(env.DB, ticket.id, "+1 year");
          ticketUrl = `${env.APP_ORIGIN}/public/tickets/${ticket.id}/check-in/${qrToken}`;
        }
        const ticketQr = await QRCode.toString(ticketUrl, { type: "svg", errorCorrectionLevel: "M", margin: 1, width: 640 });
        await env.EMAIL.send({ to: job.to, from: { email: env.EMAIL_FROM, name: "tsudoi" }, subject: `Your ticket link for ${job.eventName}`,
          text: `Open your ticket: ${job.link}\n\nThis link expires in 24 hours and can be used once. The attached QR is for venue check-in.`, html: `<p>Open your ticket for <strong>${escapeHtml(job.eventName)}</strong>:</p><p><a href="${escapeHtml(job.link)}">Open ticket</a></p><p>This link expires in 24 hours and can be used once. The attached QR is for venue check-in.</p>`, attachments: [{ content: ticketQr, filename: "tsudoi-ticket-qr.svg", type: "image/svg+xml", disposition: "attachment" }] });
      } else if (isEventAnnouncementJob(job)) {
        await env.EMAIL.send({ to: job.to, from: { email: env.EMAIL_FROM, name: "tsudoi" }, subject: `${job.eventName}: ${job.subject}`,
          text: job.message, html: `<p>${escapeHtml(job.message).replaceAll("\n", "<br>")}</p>` });
      }
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;

function escapeHtml(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function isTicketLinkJob(value: unknown): value is Extract<NotificationJob, { type: "ticket_link" }> {
  return isRecord(value) && value.type === "ticket_link" && typeof value.to === "string" && typeof value.eventName === "string" && typeof value.link === "string" && (value.ticketUrl === undefined || typeof value.ticketUrl === "string");
}
function isEventAnnouncementJob(value: unknown): value is Extract<NotificationJob, { type: "event_announcement" }> {
  return isRecord(value) && value.type === "event_announcement" && typeof value.to === "string" && typeof value.eventName === "string" && typeof value.subject === "string" && typeof value.message === "string";
}
