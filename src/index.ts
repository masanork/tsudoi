import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

type Role = "owner" | "admin" | "staff" | "viewer";
type TokenAuth = { organizationId: string; scopes: string[]; tokenId: string };
type AppVariables = { auth: TokenAuth };
type JsonRecord = Record<string, unknown>;
type AppEnv = { Bindings: Cloudflare.Env; Variables: AppVariables };

const app = new Hono<AppEnv>();

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

app.post("/api/bootstrap", async (c) => {
  const body = await jsonBody(c);
  const name = requiredString(body, "organizationName");
  if (!name) return badRequest(c, "organizationName is required");
  const organizationId = crypto.randomUUID();
  const rawToken = `tsu_${randomToken()}`;
  const tokenId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(organizationId, name),
    c.env.DB.prepare("INSERT INTO api_tokens (id, organization_id, token_hash, scopes, label) VALUES (?, ?, ?, ?, ?)")
      .bind(tokenId, organizationId, await sha256(rawToken), JSON.stringify(["admin"]), "initial administrator token"),
  ]);
  return c.json({ organizationId, token: rawToken }, 201);
});

app.use("/api/organizations/*", requireToken);
app.use("/api/events/*", requireToken);
app.use("/api/tickets/*", requireToken);
app.use("/api/messages/*", requireToken);

app.get("/api/organizations/:organizationId/events", requireScope("roster:read"), async (c) => {
  if (!sameOrganization(c)) return forbidden(c);
  const rows = await c.env.DB.prepare("SELECT * FROM events WHERE organization_id = ? ORDER BY starts_at DESC")
    .bind(c.req.param("organizationId")).all();
  return c.json(rows.results);
});

app.post("/api/organizations/:organizationId/events", requireScope("admin"), async (c) => {
  if (!sameOrganization(c)) return forbidden(c);
  const body = await jsonBody(c);
  const name = requiredString(body, "name");
  const startsAt = requiredString(body, "startsAt");
  const endsAt = requiredString(body, "endsAt");
  const registrationMode = requiredString(body, "registrationMode");
  if (!name || !startsAt || !endsAt || !["advance", "walk_in", "hybrid"].includes(registrationMode ?? "")) return badRequest(c, "invalid event");
  const eventId = crypto.randomUUID();
  await c.env.DB.prepare(`INSERT INTO events (id, organization_id, name, starts_at, ends_at, registration_mode, capacity, timezone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(eventId, c.req.param("organizationId"), name, startsAt, endsAt, registrationMode, optionalInteger(body.capacity), optionalString(body.timezone) ?? "Asia/Tokyo").run();
  await audit(c.env.DB, c.get("auth"), "event.created", "event", eventId);
  return c.json({ id: eventId }, 201);
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
    WHERE id = ? AND status = 'issued' RETURNING id, status, checked_in_at`).bind(c.get("auth").tokenId, venueId ?? null, ticketId).first();
  const outcome = updated ? "accepted" : ticket.status === "checked_in" ? "duplicate" : "rejected";
  await c.env.DB.prepare("INSERT INTO check_ins (id, ticket_id, venue_id, staff_user_id, outcome) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), ticketId, venueId ?? null, c.get("auth").tokenId, outcome).run();
  return c.json({ outcome, ticket: updated ?? { id: ticket.id, status: ticket.status } }, updated ? 200 : 409);
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

app.get("/public/events/:eventId", async (c) => {
  const event = await c.env.DB.prepare("SELECT id, name, description, starts_at, ends_at, timezone, capacity, registration_mode FROM events WHERE id = ? AND status = 'published'").bind(c.req.param("eventId")).first();
  if (!event) return c.json({ error: "not_found" }, 404);
  const fields = await c.env.DB.prepare("SELECT id, field_key, label, field_type, required, options_json FROM form_fields WHERE event_id = ? AND retired_at IS NULL ORDER BY sort_order").bind(c.req.param("eventId")).all();
  return c.json({ event, fields: fields.results });
});

app.post("/public/events/:eventId/register", async (c) => {
  const event = await c.env.DB.prepare("SELECT * FROM events WHERE id = ? AND status = 'published'").bind(c.req.param("eventId")).first<EventRow>();
  if (!event || event.registration_mode === "walk_in") return c.json({ error: "registration_unavailable" }, 404);
  return registerAttendee(c, event, false);
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

async function registerAttendee(c: Context<AppEnv>, event: EventRow, staffRegistration: boolean): Promise<Response> {
  const body = await jsonBody(c);
  const name = requiredString(body, "name");
  if (!name) return badRequest(c, "name is required");
  const email = optionalString(body.email)?.trim().toLowerCase();
  if (email && !email.includes("@")) return badRequest(c, "invalid email");
  const fields = await c.env.DB.prepare("SELECT id, field_key, field_type, required, options_json FROM form_fields WHERE event_id = ? AND retired_at IS NULL").bind(event.id).all<FieldRow>();
  const answers = isRecord(body.answers) ? body.answers : {};
  for (const field of fields.results) if (field.required && (answers[field.field_key] === undefined || answers[field.field_key] === "")) return badRequest(c, `${field.field_key} is required`);
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
  await c.env.DB.batch(statements);
  return c.json({ attendeeId, ticketId, ticketToken: staffRegistration ? undefined : ticketToken }, 201);
}

async function ticketFromPossession(c: Context<AppEnv>) {
  const body = await jsonBody(c);
  const token = requiredString(body, "ticketToken");
  if (!token) return undefined;
  const ticket = await c.env.DB.prepare("SELECT t.id, t.attendee_id, t.token_hash, a.name, a.email_normalized FROM tickets t JOIN attendees a ON a.id = t.attendee_id WHERE t.id = ? AND t.status IN ('issued', 'checked_in')")
    .bind(c.req.param("ticketId")).first<{ id: string; attendee_id: string; token_hash: string; name: string; email_normalized: string | null }>();
  return ticket && safeEqual(ticket.token_hash, await sha256(token)) ? ticket : undefined;
}

async function requireToken(c: Context<AppEnv>, next: () => Promise<void>) {
  const value = c.req.header("authorization");
  if (!value?.startsWith("Bearer tsu_")) return c.json({ error: "unauthorized" }, 401);
  const token = await c.env.DB.prepare("SELECT id, organization_id, scopes FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)").bind(await sha256(value.slice(7))).first<{ id: string; organization_id: string; scopes: string }>();
  if (!token) return c.json({ error: "unauthorized" }, 401);
  c.set("auth", { tokenId: token.id, organizationId: token.organization_id, scopes: JSON.parse(token.scopes) as string[] });
  await next();
}

function requireScope(scope: string) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const scopes = c.get("auth").scopes;
    if (!scopes.includes("admin") && !scopes.includes(scope)) return c.json({ error: "forbidden" }, 403);
    await next();
  };
}

function sameOrganization(c: Context<AppEnv>) { return c.req.param("organizationId") === c.get("auth").organizationId; }
function forbidden(c: Context<AppEnv>) { return c.json({ error: "forbidden" }, 403); }
function badRequest(c: Context<AppEnv>, message: string) { return c.json({ error: "bad_request", message }, 400); }
async function eventForAuth(c: Context<AppEnv>) {
  const event = await c.env.DB.prepare("SELECT * FROM events WHERE id = ? AND organization_id = ?").bind(c.req.param("eventId"), c.get("auth").organizationId).first<EventRow>();
  return event;
}
async function jsonBody(c: Context<AppEnv>): Promise<JsonRecord> { try { const body = await c.req.json(); return isRecord(body) ? body : {}; } catch { return {}; } }
function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function requiredString(body: JsonRecord, key: string) { const value = body[key]; return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function optionalString(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function optionalInteger(value: unknown) { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null; }
function randomToken() { const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function sha256(value: string) { const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function base64ToBytes(value: string) { const decoded = atob(value); return Uint8Array.from(decoded, (char) => char.charCodeAt(0)); }
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
function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
async function audit(db: D1Database, auth: TokenAuth, action: string, targetType: string, targetId: string) { await db.prepare("INSERT INTO audit_logs (id, organization_id, actor_id, action, target_type, target_id) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.organizationId, auth.tokenId, action, targetType, targetId).run(); }

type EventRow = { id: string; organization_id: string; registration_mode: string };
type FieldRow = { id: string; field_key: string; field_type: string; required: number; options_json: string };

export default app;
