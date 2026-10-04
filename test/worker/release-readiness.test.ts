import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const base = "https://tsudoi.test";
const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
type Registration = { attendeeId: string; ticketId: string; ticketToken: string; qrToken: string };

async function fixture() {
  const organizationId = crypto.randomUUID();
  const token = `tsu_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, 'Release tests')").bind(organizationId),
    env.DB.prepare("INSERT INTO api_tokens (id, organization_id, token_hash, scopes, label) VALUES (?, ?, ?, '[\"admin\"]', 'test')").bind(crypto.randomUUID(), organizationId, await hash(token)),
  ]);
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const created = await SELF.fetch(`${base}/api/events`, { method: "POST", headers, body: JSON.stringify({ name: "Reception", startsAt: "2026-12-10", registrationMode: "hybrid" }) });
  expect(created.status).toBe(201);
  const { id: eventId } = await created.json<{ id: string }>();
  const venue = async (name: string) => {
    const response = await SELF.fetch(`${base}/api/events/${eventId}/venues`, { method: "POST", headers, body: JSON.stringify({ name }) });
    return (await response.json<{ id: string }>()).id;
  };
  const register = async (name = "Guest", venueId?: string) => {
    const response = await SELF.fetch(`${base}/api/events/${eventId}/attendees`, { method: "POST", headers, body: JSON.stringify({ name, venueId }) });
    expect(response.status).toBe(201);
    return response.json<Registration>();
  };
  const member = async (role: "staff" | "viewer", venueId?: string) => {
    const userId = crypto.randomUUID(), session = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").bind(userId, role),
      env.DB.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)").bind(organizationId, userId, role),
      env.DB.prepare("INSERT INTO organizer_sessions (id, user_id, organization_id, token_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+1 hour'))").bind(crypto.randomUUID(), userId, organizationId, await hash(session)),
    ]);
    if (venueId) await env.DB.prepare("INSERT INTO venue_staff_assignments (venue_id, user_id) VALUES (?, ?)").bind(venueId, userId).run();
    return { userId, headers: { "content-type": "application/json", cookie: `tsudoi_organizer=${session}` } };
  };
  return { organizationId, eventId, headers, venue, register, member };
}

describe("Release reception boundaries", () => {
  it("limits both roster endpoints and form metadata to a staff member's assigned venue", async () => {
    const f = await fixture();
    const venueA = await f.venue("A"), venueB = await f.venue("B");
    const guest = await f.register("Visible", venueA);
    await f.register("Hidden", venueB);
    await f.register("Unassigned");
    await SELF.fetch(`${base}/api/events/${f.eventId}/form-fields`, { method: "POST", headers: f.headers, body: JSON.stringify({ key: "private", label: "Private", type: "text", staffVisibility: "admin_only" }) });
    const staff = await f.member("staff", venueA);
    const roster = await SELF.fetch(`${base}/api/events/${f.eventId}/roster`, { headers: staff.headers });
    await expect(roster.json()).resolves.toMatchObject({ fields: [], attendees: [expect.objectContaining({ id: guest.attendeeId })] });
    const legacy = await SELF.fetch(`${base}/api/events/${f.eventId}/attendees`, { headers: staff.headers });
    await expect(legacy.json()).resolves.toEqual([expect.objectContaining({ id: guest.attendeeId })]);
    await expect((await SELF.fetch(`${base}/api/events/${f.eventId}/form-fields`, { headers: staff.headers })).json()).resolves.toEqual([]);
    expect((await SELF.fetch(`${base}/api/events/${f.eventId}/attendees.csv`, { headers: staff.headers })).status).toBe(403);
  });

  it("keeps newly issued reception QR tokens separate from Passkey enrollment credentials", async () => {
    const f = await fixture();
    const guest = await f.register();
    expect(guest.qrToken).toBeTruthy();
    expect(guest.qrToken).not.toBe(guest.ticketToken);
    const enroll = (ticketToken: string) => SELF.fetch(`${base}/public/tickets/${guest.ticketId}/passkeys/options`, { method: "POST", headers: f.headers, body: JSON.stringify({ ticketToken }) });
    expect((await enroll(guest.qrToken)).status).toBe(404);
    expect((await enroll(guest.ticketToken)).status).toBe(200);
    const reception = (ticketToken: string) => SELF.fetch(`${base}/api/tickets/${guest.ticketId}/check-in`, { method: "POST", headers: f.headers, body: JSON.stringify({ ticketToken }) });
    expect((await reception(guest.ticketToken)).status).toBe(403);
    expect((await reception(guest.qrToken)).status).toBe(200);
  });

  it("enforces a guest's assigned venue for QR, roster, and legacy link reception", async () => {
    const f = await fixture();
    const venueA = await f.venue("A"), venueB = await f.venue("B");
    const guest = await f.register("Assigned", venueA);
    const linkToken = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO magic_links (id, attendee_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, 'ticket', datetime('now', '+1 hour'))").bind(crypto.randomUUID(), guest.attendeeId, await hash(linkToken)).run();
    const paths = [
      { path: `/api/tickets/${guest.ticketId}/check-in`, body: { ticketToken: guest.qrToken } },
      { path: `/api/events/${f.eventId}/attendees/${guest.attendeeId}/check-in`, body: {} },
      { path: "/api/tickets/check-in-link", body: { linkToken } },
    ];
    for (const { path, body } of paths) for (const venueId of [undefined, venueB]) {
      const response = await SELF.fetch(`${base}${path}`, { method: "POST", headers: f.headers, body: JSON.stringify({ ...body, venueId }) });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "wrong_venue" });
    }
    expect((await SELF.fetch(`${base}${paths[0].path}`, { method: "POST", headers: f.headers, body: JSON.stringify({ ticketToken: guest.qrToken, venueId: venueA }) })).status).toBe(200);
  });

  it("reports exactly one accepted attempt when QR and roster reception race", async () => {
    const f = await fixture();
    const guest = await f.register();
    const responses = await Promise.all([
      SELF.fetch(`${base}/api/tickets/${guest.ticketId}/check-in`, { method: "POST", headers: f.headers, body: JSON.stringify({ ticketToken: guest.qrToken }) }),
      SELF.fetch(`${base}/api/events/${f.eventId}/attendees/${guest.attendeeId}/check-in`, { method: "POST", headers: f.headers, body: "{}" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const results = await Promise.all(responses.map((response) => response.json<{ outcome: string; ticket: { status: string; checked_in_at: string; checked_in_by: string } }>()));
    expect(results.map((result) => result.outcome).sort()).toEqual(["accepted", "duplicate"]);
    for (const result of results) expect(result.ticket).toMatchObject({ status: "checked_in", checked_in_at: expect.any(String), checked_in_by: expect.any(String) });
    const attempts = await env.DB.prepare("SELECT outcome FROM check_ins WHERE ticket_id = ? ORDER BY outcome").bind(guest.ticketId).all<{ outcome: string }>();
    expect(attempts.results.map((attempt) => attempt.outcome)).toEqual(["accepted", "duplicate"]);
    const audits = await env.DB.prepare("SELECT metadata_json FROM audit_logs WHERE target_id = ? AND action LIKE 'ticket.verified%'").bind(guest.ticketId).all<{ metadata_json: string }>();
    expect(audits.results.map((audit) => JSON.parse(audit.metadata_json).outcome).sort()).toEqual(["accepted", "duplicate"]);
  });

  it("rolls back reception if its audit cannot be saved", async () => {
    const f = await fixture();
    const guest = await f.register();
    await env.DB.exec("CREATE TRIGGER fail_reception_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'ticket.verified' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;");
    try {
      const response = await SELF.fetch(`${base}/api/tickets/${guest.ticketId}/check-in`, { method: "POST", headers: f.headers, body: JSON.stringify({ ticketToken: guest.qrToken }) });
      expect(response.status).toBe(500);
      await expect(env.DB.prepare("SELECT status FROM tickets WHERE id = ?").bind(guest.ticketId).first()).resolves.toEqual({ status: "issued" });
      await expect(env.DB.prepare("SELECT id FROM check_ins WHERE ticket_id = ?").bind(guest.ticketId).first()).resolves.toBeNull();
    } finally { await env.DB.exec("DROP TRIGGER fail_reception_audit;"); }
  });

  it("consumes a magic login link only once even with concurrent requests", async () => {
    const f = await fixture();
    const guest = await f.register();
    const token = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO magic_links (id, attendee_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, 'ticket', datetime('now', '+1 hour'))").bind(crypto.randomUUID(), guest.attendeeId, await hash(token)).run();
    const responses = await Promise.all([SELF.fetch(`${base}/public/magic-links/${token}`, { redirect: "manual" }), SELF.fetch(`${base}/public/magic-links/${token}`, { redirect: "manual" })]);
    expect(responses.map((response) => response.status).sort()).toEqual([302, 400]);
    expect(responses.filter((response) => response.headers.has("set-cookie"))).toHaveLength(1);
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM participant_sessions WHERE attendee_id = ?").bind(guest.attendeeId).first()).resolves.toEqual({ count: 1 });
  });

  it("rolls back reversal if its audit cannot be saved", async () => {
    const f = await fixture();
    const guest = await f.register();
    await SELF.fetch(`${base}/api/tickets/${guest.ticketId}/check-in`, { method: "POST", headers: f.headers, body: JSON.stringify({ ticketToken: guest.qrToken }) });
    await env.DB.exec("CREATE TRIGGER fail_reversal_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'ticket.check_in_reversed' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;");
    try {
      const response = await SELF.fetch(`${base}/api/tickets/${guest.ticketId}/reverse-check-in`, { method: "POST", headers: f.headers, body: JSON.stringify({ reason: "Wrong guest" }) });
      expect(response.status).toBe(500);
      await expect(env.DB.prepare("SELECT status FROM tickets WHERE id = ?").bind(guest.ticketId).first()).resolves.toEqual({ status: "checked_in" });
      await expect(env.DB.prepare("SELECT id FROM check_ins WHERE ticket_id = ? AND outcome = 'reversed'").bind(guest.ticketId).first()).resolves.toBeNull();
    } finally { await env.DB.exec("DROP TRIGGER fail_reversal_audit;"); }
  });

  it("rolls back cancellation and capacity changes if its audit cannot be saved", async () => {
    const f = await fixture();
    const guest = await f.register();
    const token = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO participant_sessions (id, attendee_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))").bind(crypto.randomUUID(), guest.attendeeId, await hash(token)).run();
    await env.DB.exec("CREATE TRIGGER fail_cancellation_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'ticket.cancelled_by_participant' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;");
    try {
      const response = await SELF.fetch(`${base}/api/participant/ticket/cancel`, { method: "POST", headers: { cookie: `tsudoi_participant=${token}` } });
      expect(response.status).toBe(500);
      await expect(env.DB.prepare("SELECT status FROM tickets WHERE id = ?").bind(guest.ticketId).first()).resolves.toEqual({ status: "issued" });
      await expect(env.DB.prepare("SELECT status FROM attendees WHERE id = ?").bind(guest.attendeeId).first()).resolves.toEqual({ status: "active" });
      await expect(env.DB.prepare("SELECT active_registration_count FROM events WHERE id = ?").bind(f.eventId).first()).resolves.toEqual({ active_registration_count: 1 });
    } finally { await env.DB.exec("DROP TRIGGER fail_cancellation_audit;"); }
  });

  it("deletes an empty draft with assigned staff and an organizer", async () => {
    const f = await fixture();
    const venue = await f.venue("A");
    const staff = await f.member("staff", venue);
    await env.DB.prepare("INSERT INTO event_organizers (event_id, user_id, role) VALUES (?, ?, 'organizer')").bind(f.eventId, staff.userId).run();
    const response = await SELF.fetch(`${base}/api/events/${f.eventId}`, { method: "DELETE", headers: f.headers });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ action: "deleted" });
    await expect(env.DB.prepare("PRAGMA foreign_key_check").all()).resolves.toMatchObject({ results: [] });
  });

  it("allows viewers to read the roster but forbids reception and export", async () => {
    const f = await fixture();
    const guest = await f.register();
    const viewer = await f.member("viewer");
    expect((await SELF.fetch(`${base}/api/events/${f.eventId}/roster`, { headers: viewer.headers })).status).toBe(200);
    expect((await SELF.fetch(`${base}/api/events/${f.eventId}/attendees.csv`, { headers: viewer.headers })).status).toBe(403);
    expect((await SELF.fetch(`${base}/api/tickets/${guest.ticketId}/check-in`, { method: "POST", headers: viewer.headers, body: JSON.stringify({ ticketToken: guest.qrToken }) })).status).toBe(403);
  });

  it("compares metric periods as instants and exports spreadsheet formulas as text", async () => {
    const f = await fixture();
    const guest = await f.register("=HYPERLINK(\"https://example.test\")");
    await env.DB.prepare("UPDATE attendees SET created_at = '2026-10-04 09:00:00' WHERE id = ?").bind(guest.attendeeId).run();
    const metrics = await SELF.fetch(`${base}/api/events/${f.eventId}/metrics?from=2026-10-04T17:00:00%2B09:00&to=2026-10-04T19:00:00%2B09:00`, { headers: f.headers });
    await expect(metrics.json()).resolves.toMatchObject({ registrations: 1 });
    const csv = await SELF.fetch(`${base}/api/events/${f.eventId}/attendees.csv`, { headers: f.headers });
    expect(await csv.text()).toContain("\"'=HYPERLINK");
  });

  it("rejects cross-origin browser mutations including OAuth consent", async () => {
    for (const path of ["/api/events", "/public/events/test/register", "/oauth/authorize", "/oauth/session"]) {
      const response = await SELF.fetch(`${base}${path}`, { method: "POST", headers: { origin: "https://untrusted.test", "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "untrusted_origin" });
    }
  });
});
