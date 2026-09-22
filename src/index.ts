import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import * as QRCode from "qrcode";

type Role = "owner" | "admin" | "staff" | "viewer";
type OrganizerAuth = { organizationId: string; scopes: string[]; actorId: string; role: Role | "api_token"; kind: "session" | "api_token" };
type AppVariables = { auth: OrganizerAuth; participantAttendeeId: string };
type JsonRecord = Record<string, unknown>;
type AppEnv = { Bindings: Cloudflare.Env; Variables: AppVariables };
type NotificationJob = { type: "ticket_link"; to: string; eventName: string; link: string };

export const app = new Hono<AppEnv>();

app.use("/api/*", cors({ origin: (origin, c) => origin === c.env.APP_ORIGIN ? origin : c.env.APP_ORIGIN, credentials: true }));
app.use("*", async (c, next) => {
  if (Number(c.req.header("content-length") ?? "0") > 1_000_000) return c.json({ error: "payload_too_large" }, 413);
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
  });
  if (!verification.verified) return c.json({ error: "passkey_verification_failed" }, 400);
  const membership = await c.env.DB.prepare("SELECT organization_id, role FROM organization_members WHERE user_id = ? ORDER BY created_at LIMIT 1")
    .bind(passkey.user_id).first<{ organization_id: string; role: Role }>();
  if (!membership) return c.json({ error: "organization_membership_not_found" }, 403);
  const sessionToken = randomToken();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE organizer_webauthn_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(challenge.id),
    c.env.DB.prepare("UPDATE passkeys SET counter = ? WHERE id = ?").bind(verification.authenticationInfo.newCounter, passkey.id),
    c.env.DB.prepare("INSERT INTO organizer_sessions (id, user_id, organization_id, token_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+12 hours'))")
      .bind(crypto.randomUUID(), passkey.user_id, membership.organization_id, await sha256(sessionToken)),
  ]);
  c.header("Set-Cookie", organizerCookie(sessionToken));
  return c.json({ role: membership.role });
});

app.post("/api/setup/initial-admin/options", async (c) => {
  const body = await jsonBody(c);
  const organizationName = optionalString(body.organizationName)?.trim() || "既定ワークスペース";
  const displayName = requiredString(body, "displayName");
  const email = optionalString(body.email)?.trim().toLowerCase();
  if (!displayName || displayName.length > 100 || (email && !email.includes("@"))) return badRequest(c, "displayName is required");
  if (await c.env.DB.prepare("SELECT id FROM organizations LIMIT 1").first()) return c.json({ error: "initial_setup_complete" }, 409);
  const options = await generateRegistrationOptions({
    rpName: c.env.RP_NAME, rpID: c.env.RP_ID, userID: crypto.getRandomValues(new Uint8Array(16)),
    userName: email ?? displayName, userDisplayName: displayName, attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const challengeId = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO initial_admin_challenges (id, organization_name, display_name, email_normalized, challenge, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+5 minutes'))")
    .bind(challengeId, organizationName, displayName, email ?? null, options.challenge).run();
  return c.json({ challengeId, options });
});

app.post("/api/setup/initial-admin/verify", async (c) => {
  const body = await jsonBody(c);
  const challengeId = requiredString(body, "challengeId");
  const response = body.response;
  if (!challengeId || !isRegistrationResponse(response)) return badRequest(c, "invalid registration response");
  const challenge = await c.env.DB.prepare("SELECT id, organization_name, display_name, email_normalized, challenge FROM initial_admin_challenges WHERE id = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP")
    .bind(challengeId).first<{ id: string; organization_name: string; display_name: string; email_normalized: string | null; challenge: string }>();
  if (!challenge || await c.env.DB.prepare("SELECT id FROM organizations LIMIT 1").first()) return c.json({ error: "initial_setup_unavailable" }, 409);
  const verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: c.env.APP_ORIGIN, expectedRPID: c.env.RP_ID, requireUserVerification: true });
  if (!verification.verified || !verification.registrationInfo) return c.json({ error: "passkey_verification_failed" }, 400);
  const organizationId = crypto.randomUUID(), userId = crypto.randomUUID();
  const credential = verification.registrationInfo.credential;
  const sessionToken = randomToken();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE initial_admin_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(challenge.id),
    c.env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(organizationId, challenge.organization_name),
    c.env.DB.prepare("INSERT INTO users (id, display_name, email_normalized) VALUES (?, ?, ?)").bind(userId, challenge.display_name, challenge.email_normalized),
    c.env.DB.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'owner')").bind(organizationId, userId),
    c.env.DB.prepare("INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports_json, prf_capable) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), userId, credential.id, credential.publicKey, credential.counter, JSON.stringify(response.response.transports ?? []), hasPrfEnabled(response.clientExtensionResults) ? 1 : 0),
    c.env.DB.prepare("INSERT INTO organizer_sessions (id, user_id, organization_id, token_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+12 hours'))")
      .bind(crypto.randomUUID(), userId, organizationId, await sha256(sessionToken)),
  ]);
  c.header("Set-Cookie", organizerCookie(sessionToken));
  return c.json({ role: "owner" }, 201);
});

app.use("/api/organizations/*", requireOrganizer);
app.use("/api/events", requireOrganizer);
app.use("/api/events/*", requireOrganizer);
app.use("/api/tickets/*", requireOrganizer);
app.use("/api/messages/*", requireOrganizer);
app.use("/api/participant/*", requireParticipant);

app.post("/mcp", async (c) => handleMcpRequest(c));

app.get("/api/organizations/:organizationId/events", requireScope("roster:read"), async (c) => {
  if (!sameOrganization(c)) return forbidden(c);
  const rows = await c.env.DB.prepare("SELECT * FROM events WHERE organization_id = ? AND archived_at IS NULL ORDER BY starts_at DESC")
    .bind(c.req.param("organizationId")).all();
  return c.json(rows.results);
});

app.get("/api/events", requireScope("roster:read"), async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM events WHERE organization_id = ? AND archived_at IS NULL ORDER BY starts_at DESC").bind(c.get("auth").organizationId).all();
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
    c.env.DB.prepare("DELETE FROM schedule_responses WHERE event_id = ?").bind(event.id),
    c.env.DB.prepare("DELETE FROM schedule_options WHERE event_id = ?").bind(event.id),
    c.env.DB.prepare("DELETE FROM form_fields WHERE event_id = ?").bind(event.id),
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
  const options = await c.env.DB.prepare(`SELECT o.id, o.starts_at, o.ends_at, o.note,
      COUNT(r.id) AS responses,
      SUM(CASE WHEN r.response = 'yes' THEN 1 ELSE 0 END) AS yes,
      SUM(CASE WHEN r.response = 'maybe' THEN 1 ELSE 0 END) AS maybe,
      SUM(CASE WHEN r.response = 'no' THEN 1 ELSE 0 END) AS no
    FROM schedule_options o LEFT JOIN schedule_responses r ON r.option_id = o.id
    WHERE o.event_id = ? GROUP BY o.id ORDER BY o.starts_at`).bind(event.id).all();
  return c.json({ enabled: event.scheduling_enabled === 1, status: event.schedule_status, startsAt: event.starts_at || null, endsAt: event.ends_at || null, options: options.results });
});

app.post("/api/events/:eventId/schedule/options", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  if (event.scheduling_enabled !== 1 || event.schedule_status === "confirmed") return c.json({ error: "schedule_not_editable" }, 409);
  const body = await jsonBody(c);
  const startsAt = requiredString(body, "startsAt");
  const endsAt = scheduleOptionEndsAt(startsAt, event.schedule_duration_minutes, requiredString(body, "endsAt"));
  if (!isValidScheduleOption(startsAt, endsAt)) return badRequest(c, "a valid start and end time are required");
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare("INSERT INTO schedule_options (id, event_id, starts_at, ends_at, note) VALUES (?, ?, ?, ?, ?)")
      .bind(id, event.id, startsAt, endsAt, optionalString(body.note) ?? "").run();
  } catch { return c.json({ error: "schedule_option_exists" }, 409); }
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
  return c.json({ confirmed: true, startsAt: option.starts_at, endsAt: option.ends_at });
});

app.post("/api/events/:eventId/venues", requireScope("admin"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const body = await jsonBody(c);
  const name = requiredString(body, "name");
  if (!name) return badRequest(c, "name is required");
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO venues (id, event_id, name, address, opens_at, capacity) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, event.id, name, optionalString(body.address) ?? "", optionalString(body.opensAt), optionalInteger(body.capacity)).run();
  return c.json({ id }, 201);
});

app.get("/api/events/:eventId/form-fields", requireScope("roster:read"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const fields = await c.env.DB.prepare("SELECT * FROM form_fields WHERE event_id = ? AND retired_at IS NULL ORDER BY sort_order, created_at").bind(event.id).all();
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
  const fields = await c.env.DB.prepare("SELECT id, field_key, label FROM form_fields WHERE event_id = ? AND retired_at IS NULL ORDER BY sort_order, created_at").bind(event.id).all<{ id: string; field_key: string; label: string }>();
  const attendees = await c.env.DB.prepare(`SELECT a.id, a.name, a.email_normalized, a.status, a.registration_source, a.created_at,
      t.status AS ticket_status, t.checked_in_at FROM attendees a JOIN tickets t ON t.attendee_id = a.id
      WHERE a.event_id = ? ORDER BY a.created_at DESC LIMIT 200`).bind(event.id).all<{ id: string; name: string; email_normalized: string | null; status: string; registration_source: string; created_at: string; ticket_status: string; checked_in_at: string | null }>();
  const answers = await c.env.DB.prepare("SELECT attendee_id, field_id, value_json FROM attendee_answers WHERE attendee_id IN (SELECT id FROM attendees WHERE event_id = ?)").bind(event.id).all<{ attendee_id: string; field_id: string; value_json: string }>();
  const answerMap = new Map(answers.results.map((answer) => [`${answer.attendee_id}:${answer.field_id}`, answerValue(answer.value_json)]));
  return c.json({ fields: fields.results.map(({ field_key, label }) => ({ field_key, label })), attendees: attendees.results.map((attendee) => ({ ...attendee, answers: Object.fromEntries(fields.results.map((field) => [field.field_key, answerMap.get(`${attendee.id}:${field.id}`) ?? null])) })) });
});

app.get("/api/events/:eventId/attendees", requireScope("roster:read"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const query = c.req.query("q")?.trim();
  const status = c.req.query("status");
  const rows = await c.env.DB.prepare(`SELECT a.*, t.id AS ticket_id, t.status AS ticket_status, t.checked_in_at
    FROM attendees a JOIN tickets t ON t.attendee_id = a.id WHERE a.event_id = ?
    AND (? IS NULL OR a.status = ?) AND (? IS NULL OR a.name LIKE ? OR a.email_normalized LIKE ?)
    ORDER BY a.created_at DESC LIMIT 200`)
    .bind(event.id, status ?? null, status ?? null, query ?? null, query ? `%${query}%` : null, query ? `%${query}%` : null).all();
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
  const metrics = await c.env.DB.prepare(`SELECT
    COUNT(*) AS registrations,
    SUM(CASE WHEN t.status IN ('issued','checked_in') THEN 1 ELSE 0 END) AS issued,
    SUM(CASE WHEN t.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
    SUM(CASE WHEN t.status = 'checked_in' THEN 1 ELSE 0 END) AS checked_in,
    SUM(CASE WHEN t.status = 'issued' THEN 1 ELSE 0 END) AS not_checked_in
    FROM attendees a JOIN tickets t ON t.attendee_id = a.id WHERE a.event_id = ?`).bind(event.id).first();
  return c.json(metrics);
});

app.post("/api/events/:eventId/attendees/:attendeeId/ticket-link", requireScope("roster:write"), async (c) => {
  const event = await eventForAuth(c);
  if (!event) return c.json({ error: "not_found" }, 404);
  const attendee = await c.env.DB.prepare("SELECT id, email_normalized FROM attendees WHERE id = ? AND event_id = ? AND status = 'active'")
    .bind(c.req.param("attendeeId"), event.id).first<{ id: string; email_normalized: string | null }>();
  if (!attendee?.email_normalized) return c.json({ error: "email_not_available" }, 400);
  const rawToken = randomToken();
  await c.env.DB.prepare("INSERT INTO magic_links (id, attendee_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, 'ticket', datetime('now', '+24 hours'))")
    .bind(crypto.randomUUID(), attendee.id, await sha256(rawToken)).run();
  const eventName = (await c.env.DB.prepare("SELECT name FROM events WHERE id = ?").bind(event.id).first<{ name: string }>())?.name ?? "Your event";
  const link = `${c.env.APP_ORIGIN}/public/magic-links/${encodeURIComponent(rawToken)}`;
  await c.env.NOTIFICATION_QUEUE.send({ type: "ticket_link", to: attendee.email_normalized, eventName, link } satisfies NotificationJob);
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

app.post("/api/participant/ticket/cancel", async (c) => {
  const attendeeId = c.get("participantAttendeeId");
  const ticket = await c.env.DB.prepare(`UPDATE tickets SET status = 'cancelled'
    WHERE attendee_id = ? AND status = 'issued' AND event_id IN
      (SELECT id FROM events WHERE cancellation_closes_at IS NULL OR cancellation_closes_at > CURRENT_TIMESTAMP)
    RETURNING id, event_id`).bind(attendeeId).first<{ id: string; event_id: string }>();
  if (!ticket) return c.json({ error: "cancellation_unavailable" }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE attendees SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?").bind(attendeeId),
    c.env.DB.prepare("INSERT INTO audit_logs (id, organization_id, action, target_type, target_id, metadata_json) SELECT ?, organization_id, 'ticket.cancelled_by_participant', 'ticket', ?, '{}' FROM attendees WHERE id = ?")
      .bind(crypto.randomUUID(), ticket.id, attendeeId),
  ]);
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

app.post("/api/tickets/:ticketId/check-in", requireScope("checkin:write"), async (c) => {
  const ticketId = c.req.param("ticketId");
  const body = await jsonBody(c);
  const venueId = optionalString(body.venueId);
  const ticketToken = requiredString(body, "ticketToken");
  if (!ticketToken) return badRequest(c, "ticketToken is required");
  const ticket = await c.env.DB.prepare("SELECT t.*, e.organization_id FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = ?").bind(ticketId).first<{ id: string; organization_id: string; status: string; token_hash: string }>();
  if (!ticket || ticket.organization_id !== c.get("auth").organizationId) return c.json({ error: "not_found" }, 404);
  if (!safeEqual(ticket.token_hash, await sha256(ticketToken))) return c.json({ error: "invalid_ticket" }, 403);
  const updated = await c.env.DB.prepare(`UPDATE tickets SET status = 'checked_in', checked_in_at = CURRENT_TIMESTAMP, checked_in_by = ?, checked_in_venue_id = ?
    WHERE id = ? AND status = 'issued' RETURNING id, status, checked_in_at`).bind(c.get("auth").actorId, venueId ?? null, ticketId).first();
  const outcome = updated ? "accepted" : ticket.status === "checked_in" ? "duplicate" : "rejected";
  await c.env.DB.prepare("INSERT INTO check_ins (id, ticket_id, venue_id, staff_user_id, outcome) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), ticketId, venueId ?? null, c.get("auth").actorId, outcome).run();
  return c.json({ outcome, ticket: updated ?? { id: ticket.id, status: ticket.status } }, updated ? 200 : 409);
});

app.post("/api/tickets/check-in-link", requireScope("checkin:write"), async (c) => {
  const body = await jsonBody(c);
  const linkToken = requiredString(body, "linkToken");
  const venueId = optionalString(body.venueId);
  if (!linkToken) return badRequest(c, "linkToken is required");
  const record = await c.env.DB.prepare(`SELECT ml.id AS magic_link_id, t.id AS ticket_id, t.status, e.organization_id
    FROM magic_links ml JOIN attendees a ON a.id = ml.attendee_id JOIN tickets t ON t.attendee_id = a.id
    JOIN events e ON e.id = t.event_id
    WHERE ml.token_hash = ? AND ml.purpose = 'ticket' AND ml.consumed_at IS NULL AND ml.expires_at > CURRENT_TIMESTAMP`)
    .bind(await sha256(linkToken)).first<{ magic_link_id: string; ticket_id: string; status: string; organization_id: string }>();
  if (!record || record.organization_id !== c.get("auth").organizationId) return c.json({ error: "not_found" }, 404);
  const updated = await c.env.DB.prepare(`UPDATE tickets SET status = 'checked_in', checked_in_at = CURRENT_TIMESTAMP, checked_in_by = ?, checked_in_venue_id = ?
    WHERE id = ? AND status = 'issued' RETURNING id, status, checked_in_at`).bind(c.get("auth").actorId, venueId ?? null, record.ticket_id).first();
  const outcome = updated ? "accepted" : record.status === "checked_in" ? "duplicate" : "rejected";
  const statements = [c.env.DB.prepare("INSERT INTO check_ins (id, ticket_id, venue_id, staff_user_id, outcome) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), record.ticket_id, venueId ?? null, c.get("auth").actorId, outcome)];
  if (updated) statements.push(c.env.DB.prepare("UPDATE magic_links SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(record.magic_link_id));
  await c.env.DB.batch(statements);
  return c.json({ outcome, ticket: updated ?? { id: record.ticket_id, status: record.status } }, updated ? 200 : 409);
});

app.post("/api/messages/:threadId", requireScope("messages:write"), async (c) => {
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

app.get("/public/events/:eventId", async (c) => {
  const event = await c.env.DB.prepare("SELECT id, name, description, starts_at, ends_at, timezone, capacity, registration_mode FROM events WHERE id = ? AND status = 'published'").bind(c.req.param("eventId")).first();
  if (!event) return c.json({ error: "not_found" }, 404);
  const fields = await c.env.DB.prepare("SELECT id, field_key, label, field_type, required, options_json FROM form_fields WHERE event_id = ? AND retired_at IS NULL ORDER BY sort_order").bind(c.req.param("eventId")).all();
  return c.json({ event, fields: fields.results });
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
    WHERE o.event_id = ? GROUP BY o.id ORDER BY o.starts_at`).bind(c.req.param("eventId")).all();
  return c.json({ event, options: options.results });
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
  return c.json({ saved: true }, 201);
});

app.post("/public/events/:eventId/schedule/agent-connections", async (c) => {
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
  const event = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ? AND status = 'published'
    AND (registration_opens_at IS NULL OR registration_opens_at <= CURRENT_TIMESTAMP)
    AND (registration_closes_at IS NULL OR registration_closes_at > CURRENT_TIMESTAMP)`).bind(c.req.param("eventId")).first<EventRow>();
  if (!event || event.registration_mode === "walk_in") return c.json({ error: "registration_unavailable" }, 404);
  return registerAttendee(c, event, false);
});

app.get("/public/magic-links/:token", async (c) => {
  const token = c.req.param("token");
  const link = await c.env.DB.prepare("SELECT ml.id, ml.attendee_id FROM magic_links ml WHERE ml.token_hash = ? AND ml.purpose = 'ticket' AND ml.consumed_at IS NULL AND ml.expires_at > CURRENT_TIMESTAMP")
    .bind(await sha256(token)).first<{ id: string; attendee_id: string }>();
  if (!link) return c.json({ error: "link_expired_or_used" }, 400);
  const sessionToken = randomToken();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE magic_links SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(link.id),
    c.env.DB.prepare("INSERT INTO participant_sessions (id, attendee_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+12 hours'))")
      .bind(crypto.randomUUID(), link.attendee_id, await sha256(sessionToken)),
  ]);
  c.header("Set-Cookie", participantCookie(sessionToken));
  return c.redirect("/ticket");
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
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
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
  });
  if (!verification.verified) return c.json({ error: "passkey_verification_failed" }, 400);
  const sessionToken = randomToken();
  const sessionId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE webauthn_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(challenge.id),
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
  const fields = await c.env.DB.prepare("SELECT id, field_key, field_type, required, options_json FROM form_fields WHERE event_id = ? AND retired_at IS NULL").bind(event.id).all<FieldRow>();
  const answers = isRecord(body.answers) ? body.answers : {};
  for (const field of fields.results) {
    const answer = answers[field.field_key];
    if (field.required && !hasRequiredAnswer(field, answer)) return badRequest(c, `${field.field_key} is required`);
    if (answer !== undefined && !isValidFieldAnswer(field, answer)) return badRequest(c, `${field.field_key} is invalid`);
  }
  const attendeeId = crypto.randomUUID();
  const ticketId = crypto.randomUUID();
  const ticketToken = randomToken();
  const venueId = optionalString(body.venueId);
  const source = staffRegistration ? "walk_in" : "public_form";
  const statements = [
    c.env.DB.prepare("INSERT INTO attendees (id, organization_id, event_id, venue_id, name, email_normalized, registration_source) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(attendeeId, event.organization_id, event.id, venueId ?? null, name, email ?? null, source),
    c.env.DB.prepare("INSERT INTO tickets (id, attendee_id, event_id, token_hash, token_key_id) VALUES (?, ?, ?, ?, ?)")
      .bind(ticketId, attendeeId, event.id, await sha256(ticketToken), "v1"),
  ];
  for (const field of fields.results) if (answers[field.field_key] !== undefined) statements.push(c.env.DB.prepare("INSERT INTO attendee_answers (attendee_id, field_id, value_json) VALUES (?, ?, ?)").bind(attendeeId, field.id, JSON.stringify(answers[field.field_key])));
  try { await c.env.DB.batch(statements); }
  catch (error) {
    if (error instanceof Error && error.message.includes("capacity_reached")) return c.json({ error: "capacity_reached" }, 409);
    throw error;
  }
  let emailQueued = false;
  if (!staffRegistration && email) {
    const magicToken = randomToken();
    await c.env.DB.prepare("INSERT INTO magic_links (id, attendee_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, 'ticket', datetime('now', '+24 hours'))")
      .bind(crypto.randomUUID(), attendeeId, await sha256(magicToken)).run();
    const link = `${c.env.APP_ORIGIN}/public/magic-links/${encodeURIComponent(magicToken)}`;
    await c.env.NOTIFICATION_QUEUE.send({ type: "ticket_link", to: email, eventName: event.name, link } satisfies NotificationJob);
    emailQueued = true;
  }
  return c.json({ attendeeId, ticketId, ticketToken: staffRegistration ? undefined : ticketToken, emailQueued }, 201);
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

type AgentConnection = { id: string; event_id: string; respondent_id: string; respondent_name: string; scope: string };
async function handleMcpRequest(c: Context<AppEnv>): Promise<Response> {
  const authorization = c.req.header("authorization");
  if (!authorization?.startsWith("Bearer tsu_agent_")) {
    c.header("WWW-Authenticate", 'Bearer realm="tsudoi MCP"');
    return c.json({ error: "unauthorized" }, 401);
  }
  const connection = await c.env.DB.prepare("SELECT id, event_id, respondent_id, respondent_name, scope FROM agent_connections WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP")
    .bind(await sha256(authorization.slice(7))).first<AgentConnection>();
  if (!connection) {
    c.header("WWW-Authenticate", 'Bearer realm="tsudoi MCP", error="invalid_token"');
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await jsonBody(c);
  const id = body.id ?? null;
  const method = requiredString(body, "method");
  if (body.jsonrpc !== "2.0" || !method) return mcpError(c, id, -32600, "Invalid Request");
  if (method === "notifications/initialized") return c.body(null, 202);
  if (method === "initialize") {
    const params = isRecord(body.params) ? body.params : {};
    const requestedVersion = requiredString(params, "protocolVersion");
    const protocolVersion = ["2025-03-26", "2025-06-18", "2025-11-25"].includes(requestedVersion ?? "") ? requestedVersion : "2025-11-25";
    return mcpResult(c, id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "tsudoi-scheduling", version: "0.1.0" }, instructions: "Use these tools only to review and submit this connection owner's availability for its linked event." });
  }
  if (method === "tools/list") return mcpResult(c, id, { tools: mcpTools() });
  if (method !== "tools/call") return mcpError(c, id, -32601, "Method not found");
  const params = isRecord(body.params) ? body.params : {};
  const toolName = requiredString(params, "name");
  const args = isRecord(params.arguments) ? params.arguments : {};
  if (toolName === "get_schedule_options") return mcpResult(c, id, await mcpScheduleOptions(c, connection));
  if (toolName === "get_schedule_status") return mcpResult(c, id, await mcpScheduleStatus(c, connection));
  if (toolName === "submit_schedule_availability") return mcpResult(c, id, await mcpSubmitAvailability(c, connection, args));
  if (toolName === "get_scheduling_preferences") return mcpResult(c, id, await mcpSchedulingPreferences(c, connection));
  if (toolName === "update_scheduling_preferences") return mcpResult(c, id, await mcpUpdateSchedulingPreferences(c, connection, args));
  return mcpError(c, id, -32601, "Unknown tool");
}
function mcpTools() {
  return [
    { name: "get_schedule_options", description: "Get the linked event's current date options and aggregate availability counts.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: "get_schedule_status", description: "Get the linked event's name, timezone, and whether scheduling remains open.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: "submit_schedule_availability", description: "Record this connection owner's availability for one date option. Do not infer or disclose calendar details.", inputSchema: { type: "object", properties: { optionId: { type: "string" }, response: { type: "string", enum: ["yes", "maybe", "no"] } }, required: ["optionId", "response"], additionalProperties: false } },
    { name: "get_scheduling_preferences", description: "Get this connection owner's saved scheduling constraints for the linked event.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: "update_scheduling_preferences", description: "Save this connection owner's scheduling constraints. Provide a concise availability summary and optional structured constraints; never include calendar titles or attendee details.", inputSchema: { type: "object", properties: { availabilityText: { type: "string", maxLength: 2000 }, constraints: { type: "object" } }, required: ["availabilityText"], additionalProperties: false } },
  ];
}
async function mcpScheduleOptions(c: Context<AppEnv>, connection: AgentConnection) {
  const event = await c.env.DB.prepare("SELECT name, description, timezone, schedule_status FROM events WHERE id = ? AND scheduling_enabled = 1 AND archived_at IS NULL").bind(connection.event_id).first();
  if (!event) return mcpToolError("The linked schedule is no longer available.");
  const options = await c.env.DB.prepare(`SELECT o.id, o.starts_at, o.ends_at, o.note,
    SUM(CASE WHEN r.response = 'yes' THEN 1 ELSE 0 END) AS yes,
    SUM(CASE WHEN r.response = 'maybe' THEN 1 ELSE 0 END) AS maybe,
    SUM(CASE WHEN r.response = 'no' THEN 1 ELSE 0 END) AS no
    FROM schedule_options o LEFT JOIN schedule_responses r ON r.option_id = o.id
    WHERE o.event_id = ? GROUP BY o.id ORDER BY o.starts_at`).bind(connection.event_id).all();
  return mcpToolText(JSON.stringify({ event, options: options.results }));
}
async function mcpScheduleStatus(c: Context<AppEnv>, connection: AgentConnection) {
  const event = await c.env.DB.prepare("SELECT name, timezone, schedule_status FROM events WHERE id = ? AND scheduling_enabled = 1 AND archived_at IS NULL").bind(connection.event_id).first();
  return event ? mcpToolText(JSON.stringify({ event })) : mcpToolError("The linked schedule is no longer available.");
}
async function mcpSubmitAvailability(c: Context<AppEnv>, connection: AgentConnection, args: JsonRecord) {
  const optionId = requiredString(args, "optionId");
  const response = requiredString(args, "response");
  if (!optionId || !["yes", "maybe", "no"].includes(response ?? "")) return mcpToolError("optionId and a valid response are required.");
  const option = await c.env.DB.prepare(`SELECT o.id FROM schedule_options o JOIN events e ON e.id = o.event_id
    WHERE o.id = ? AND o.event_id = ? AND e.schedule_status != 'confirmed' AND e.archived_at IS NULL`).bind(optionId, connection.event_id).first();
  if (!option) return mcpToolError("That option is not available for this connection.");
  await c.env.DB.prepare(`INSERT INTO schedule_responses (id, event_id, option_id, respondent_id, respondent_name, response)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(option_id, respondent_id) DO UPDATE SET respondent_name = excluded.respondent_name, response = excluded.response, updated_at = CURRENT_TIMESTAMP`)
    .bind(crypto.randomUUID(), connection.event_id, optionId, connection.respondent_id, connection.respondent_name, response).run();
  return mcpToolText(JSON.stringify({ saved: true, optionId, response }));
}
async function mcpSchedulingPreferences(c: Context<AppEnv>, connection: AgentConnection) {
  const preferences = await c.env.DB.prepare("SELECT availability_text, constraints_json, updated_at FROM scheduling_preferences WHERE event_id = ? AND respondent_id = ?")
    .bind(connection.event_id, connection.respondent_id).first<{ availability_text: string; constraints_json: string; updated_at: string }>();
  return mcpToolText(JSON.stringify({ preferences: preferences ? { ...preferences, constraints: safeJson(preferences.constraints_json) } : null }));
}
async function mcpUpdateSchedulingPreferences(c: Context<AppEnv>, connection: AgentConnection, args: JsonRecord) {
  const availabilityText = requiredString(args, "availabilityText");
  const constraints = args.constraints;
  if (!availabilityText || availabilityText.length > 2000 || (constraints !== undefined && !isRecord(constraints))) return mcpToolError("availabilityText and an optional constraints object are required.");
  const event = await c.env.DB.prepare("SELECT id FROM events WHERE id = ? AND schedule_status != 'confirmed' AND archived_at IS NULL").bind(connection.event_id).first();
  if (!event) return mcpToolError("Scheduling is closed, so preferences can no longer be changed.");
  const constraintsJson = JSON.stringify(constraints ?? {});
  if (constraintsJson.length > 8000) return mcpToolError("constraints are too large.");
  await c.env.DB.prepare(`INSERT INTO scheduling_preferences (event_id, respondent_id, availability_text, constraints_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(event_id, respondent_id) DO UPDATE SET availability_text = excluded.availability_text, constraints_json = excluded.constraints_json, updated_at = CURRENT_TIMESTAMP`)
    .bind(connection.event_id, connection.respondent_id, availabilityText, constraintsJson).run();
  return mcpToolText(JSON.stringify({ saved: true }));
}
function safeJson(value: string): unknown { try { return JSON.parse(value); } catch { return {}; } }
function mcpToolText(text: string) { return { content: [{ type: "text", text }] }; }
function mcpToolError(text: string) { return { content: [{ type: "text", text }], isError: true }; }
function mcpResult(c: Context<AppEnv>, id: unknown, result: unknown) { return c.json({ jsonrpc: "2.0", id, result }); }
function mcpError(c: Context<AppEnv>, id: unknown, code: number, message: string) { return c.json({ jsonrpc: "2.0", id, error: { code, message } }); }
async function participantThread(c: Context<AppEnv>) {
  return c.env.DB.prepare("SELECT id FROM message_threads WHERE id = ? AND attendee_id = ?")
    .bind(c.req.param("threadId"), c.get("participantAttendeeId")).first<{ id: string }>();
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
    const token = await c.env.DB.prepare("SELECT id, organization_id, scopes FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)").bind(await sha256(value.slice(7))).first<{ id: string; organization_id: string; scopes: string }>();
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
  const scopes = session.role === "owner" || session.role === "admin" ? ["admin"] : session.role === "staff" ? ["roster:read", "checkin:write"] : [];
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
  const scheduleDurationMinutes = optionalScheduleDuration(body.scheduleDurationMinutes);
  const initialScheduleOptions = scheduleOptions(body.initialScheduleOptions);
  const registrationOpensAt = optionalString(body.registrationOpensAt);
  const registrationClosesAt = optionalString(body.registrationClosesAt);
  if (!name || (!schedulingEnabled && !startsAt) || !["advance", "walk_in", "hybrid"].includes(registrationMode ?? "") || (!schedulingEnabled && initialScheduleOptions.length > 0) || (body.scheduleDurationMinutes !== undefined && scheduleDurationMinutes === undefined) || initialScheduleOptions.some((option) => !isValidScheduleOption(option.startsAt, scheduleOptionEndsAt(option.startsAt, scheduleDurationMinutes, option.endsAt)))) return badRequest(c, "invalid event");
  const optionKeys = new Set(initialScheduleOptions.map((option) => `${option.startsAt}\u0000${option.endsAt}`));
  if (optionKeys.size !== initialScheduleOptions.length) return badRequest(c, "duplicate schedule options");
  const eventId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO events (id, organization_id, name, starts_at, ends_at, registration_mode, registration_opens_at, registration_closes_at, capacity, timezone, scheduling_enabled, schedule_status, schedule_duration_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(eventId, organizationId, name, startsAt ?? "", endsAt ?? "", registrationMode, registrationOpensAt ?? null, registrationClosesAt ?? null, optionalInteger(body.capacity), optionalString(body.timezone) ?? "Asia/Tokyo", schedulingEnabled ? 1 : 0, schedulingEnabled ? "collecting" : "confirmed", scheduleDurationMinutes ?? null),
    ...initialScheduleOptions.map((option) => c.env.DB.prepare("INSERT INTO schedule_options (id, event_id, starts_at, ends_at, note) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), eventId, option.startsAt, scheduleOptionEndsAt(option.startsAt, scheduleDurationMinutes, option.endsAt), option.note)),
  ]);
  if (c.get("auth").kind === "session") await c.env.DB.prepare("INSERT INTO event_organizers (event_id, user_id, role) VALUES (?, ?, 'organizer')")
    .bind(eventId, c.get("auth").actorId).run();
  await audit(c.env.DB, c.get("auth"), "event.created", "event", eventId);
  return c.json({ id: eventId }, 201);
}
type ScheduleOptionInput = { startsAt: string; endsAt?: string; note: string };
function scheduleOptions(value: unknown): ScheduleOptionInput[] {
  if (!Array.isArray(value) || value.length > 20) return [];
  return value.flatMap((option) => {
    if (!isRecord(option)) return [];
    const startsAt = requiredString(option, "startsAt");
    const endsAt = requiredString(option, "endsAt") || undefined;
    const note = optionalString(option.note) ?? "";
    return startsAt && note.length <= 500 ? [{ startsAt, endsAt, note }] : [];
  });
}
function optionalScheduleDuration(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1440 ? value : undefined;
}
function scheduleOptionEndsAt(startsAt: string | undefined, durationMinutes: number | null | undefined, fallbackEndsAt?: string) {
  if (!startsAt) return undefined;
  if (!durationMinutes) return fallbackEndsAt ?? startsAt;
  const start = new Date(startsAt);
  return Number.isNaN(start.getTime()) ? undefined : new Date(start.getTime() + durationMinutes * 60_000).toISOString();
}
function isValidScheduleOption(startsAt: string | undefined, endsAt: string | undefined) {
  return Boolean(startsAt && endsAt && !Number.isNaN(Date.parse(startsAt)) && !Number.isNaN(Date.parse(endsAt)) && Date.parse(endsAt) >= Date.parse(startsAt));
}
async function eventForAuth(c: Context<AppEnv>) {
  const event = await c.env.DB.prepare("SELECT * FROM events WHERE id = ? AND organization_id = ?").bind(c.req.param("eventId"), c.get("auth").organizationId).first<EventRow>();
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
function csvCell(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function csvAnswer(value: string) { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.join("; ") : typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean" ? String(parsed) : ""; } catch { return ""; } }
function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
async function audit(db: D1Database, auth: OrganizerAuth, action: string, targetType: string, targetId: string) { await db.prepare("INSERT INTO audit_logs (id, organization_id, actor_id, action, target_type, target_id) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.organizationId, auth.actorId, action, targetType, targetId).run(); }

type EventRow = { id: string; organization_id: string; name: string; status: string; archived_at?: string | null; registration_mode: string; capacity: number | null; scheduling_enabled?: number; schedule_status?: string; schedule_duration_minutes?: number | null; starts_at?: string; ends_at?: string };
type FieldRow = { id: string; field_key: string; field_type: string; required: number; options_json: string };

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch, env: Cloudflare.Env) {
    for (const message of batch.messages) {
      const job = message.body;
      if (!isTicketLinkJob(job)) continue;
      const ticketQr = await QRCode.toString(job.link, { type: "svg", errorCorrectionLevel: "M", margin: 1, width: 640 });
      await env.EMAIL.send({
        to: job.to,
        from: { email: env.EMAIL_FROM, name: "tsudoi" },
        subject: `Your ticket link for ${job.eventName}`,
        text: `Open your ticket: ${job.link}\n\nThis link expires in 24 hours and can be used once.`,
        html: `<p>Open your ticket for <strong>${escapeHtml(job.eventName)}</strong>:</p><p><a href="${escapeHtml(job.link)}">Open ticket</a></p><p>This link expires in 24 hours and can be used once.</p>`,
        attachments: [{ content: ticketQr, filename: "tsudoi-ticket-qr.svg", type: "image/svg+xml", disposition: "attachment" }],
      });
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;

function escapeHtml(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function isTicketLinkJob(value: unknown): value is NotificationJob {
  return isRecord(value) && value.type === "ticket_link" && typeof value.to === "string" && typeof value.eventName === "string" && typeof value.link === "string";
}
