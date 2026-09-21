import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import * as QRCode from "qrcode";

type Role = "owner" | "admin" | "staff" | "viewer";
type TokenAuth = { organizationId: string; scopes: string[]; tokenId: string };
type AppVariables = { auth: TokenAuth; participantAttendeeId: string };
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
app.use("/api/participant/*", requireParticipant);

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
    WHERE id = ? AND status = 'issued' RETURNING id, status, checked_in_at`).bind(c.get("auth").tokenId, venueId ?? null, ticketId).first();
  const outcome = updated ? "accepted" : ticket.status === "checked_in" ? "duplicate" : "rejected";
  await c.env.DB.prepare("INSERT INTO check_ins (id, ticket_id, venue_id, staff_user_id, outcome) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), ticketId, venueId ?? null, c.get("auth").tokenId, outcome).run();
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
    WHERE id = ? AND status = 'issued' RETURNING id, status, checked_in_at`).bind(c.get("auth").tokenId, venueId ?? null, record.ticket_id).first();
  const outcome = updated ? "accepted" : record.status === "checked_in" ? "duplicate" : "rejected";
  const statements = [c.env.DB.prepare("INSERT INTO check_ins (id, ticket_id, venue_id, staff_user_id, outcome) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), record.ticket_id, venueId ?? null, c.get("auth").tokenId, outcome)];
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

app.post("/public/events/:eventId/register", async (c) => {
  const event = await c.env.DB.prepare("SELECT * FROM events WHERE id = ? AND status = 'published'").bind(c.req.param("eventId")).first<EventRow>();
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
  if (event.capacity !== null) {
    const registrations = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM attendees WHERE event_id = ? AND status = 'active'").bind(event.id).first<{ count: number }>();
    if ((registrations?.count ?? 0) >= event.capacity) return c.json({ error: "capacity_reached" }, 409);
  }
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
  await c.env.DB.batch(statements);
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

async function requireToken(c: Context<AppEnv>, next: () => Promise<void>) {
  const value = c.req.header("authorization");
  if (!value?.startsWith("Bearer tsu_")) return c.json({ error: "unauthorized" }, 401);
  const token = await c.env.DB.prepare("SELECT id, organization_id, scopes FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)").bind(await sha256(value.slice(7))).first<{ id: string; organization_id: string; scopes: string }>();
  if (!token) return c.json({ error: "unauthorized" }, 401);
  c.set("auth", { tokenId: token.id, organizationId: token.organization_id, scopes: JSON.parse(token.scopes) as string[] });
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

function sameOrganization(c: Context<AppEnv>) { return c.req.param("organizationId") === c.get("auth").organizationId; }
function forbidden(c: Context<AppEnv>) { return c.json({ error: "forbidden" }, 403); }
function badRequest(c: Context<AppEnv>, message: string) { return c.json({ error: "bad_request", message }, 400); }
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
async function audit(db: D1Database, auth: TokenAuth, action: string, targetType: string, targetId: string) { await db.prepare("INSERT INTO audit_logs (id, organization_id, actor_id, action, target_type, target_id) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.organizationId, auth.tokenId, action, targetType, targetId).run(); }

type EventRow = { id: string; organization_id: string; name: string; registration_mode: string; capacity: number | null };
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
