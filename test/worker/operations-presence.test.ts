import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const origin = "http://localhost:8787";

async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createOwner(name: string) {
  const organizationId = crypto.randomUUID(), userId = crypto.randomUUID(), token = `session_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO organizations (id,name) VALUES (?,?)").bind(organizationId, name),
    env.DB.prepare("INSERT INTO users (id,display_name) VALUES (?,?)").bind(userId, name),
    env.DB.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES (?,?,'owner')").bind(organizationId, userId),
    env.DB.prepare("INSERT INTO organizer_sessions (id,user_id,organization_id,token_hash,expires_at) VALUES (?,?,?,?,datetime('now','+12 hours'))")
      .bind(crypto.randomUUID(), userId, organizationId, await digest(token)),
  ]);
  return { organizationId, userId, token, headers: { "content-type": "application/json", cookie: `tsudoi_organizer=${token}` } };
}

async function createMember(organizationId: string, name: string, role: "admin" | "staff" | "viewer") {
  const userId = crypto.randomUUID(), token = `session_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id,display_name) VALUES (?,?)").bind(userId, name),
    env.DB.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES (?,?,?)").bind(organizationId, userId, role),
    env.DB.prepare("INSERT INTO organizer_sessions (id,user_id,organization_id,token_hash,expires_at) VALUES (?,?,?,?,datetime('now','+12 hours'))")
      .bind(crypto.randomUUID(), userId, organizationId, await digest(token)),
  ]);
  return { userId, token, headers: { "content-type": "application/json", cookie: `tsudoi_organizer=${token}` } };
}

async function createEvent(organizationId: string, name: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO events (id,organization_id,name,starts_at,ends_at,registration_mode,status)
    VALUES (?,?,?,'2026-10-01T09:00:00Z','2026-10-01T10:00:00Z','hybrid','published')`).bind(id, organizationId, name).run();
  return id;
}

async function createVenue(eventId: string, name: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO venues (id,event_id,name) VALUES (?,?,?)").bind(id, eventId, name).run();
  return id;
}

async function createGuest(eventId: string, organizationId: string, options: { status?: "active" | "cancelled"; ticketStatus?: "issued" | "checked_in" | "cancelled" | "voided"; registrationVenue?: string | null; legacyQr?: boolean } = {}) {
  const attendeeId = crypto.randomUUID(), ticketId = crypto.randomUUID(), qr = `qr_${crypto.randomUUID()}`, ticketToken = `ticket_${crypto.randomUUID()}`;
  const tokenHash = options.legacyQr ? await digest(qr) : await digest(ticketToken);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO attendees (id,organization_id,event_id,venue_id,name,affiliation,registration_source,status)
      VALUES (?,?,?,?,?,'North Branch','admin',?)`).bind(attendeeId, organizationId, eventId, options.registrationVenue ?? null, "Presence Guest", options.status ?? "active"),
    env.DB.prepare(`INSERT INTO tickets (id,attendee_id,event_id,token_hash,token_key_id,status)
      VALUES (?,?,?,?,?,?)`).bind(ticketId, attendeeId, eventId, tokenHash, options.legacyQr ? "v1" : "possession-v2", options.ticketStatus ?? "issued"),
    ...(options.legacyQr ? [] : [env.DB.prepare("INSERT INTO ticket_qr_tokens (id,ticket_id,token_hash,expires_at) VALUES (?,?,?,?)")
      .bind(crypto.randomUUID(), ticketId, await digest(qr), "2999-01-01 00:00:00")]),
  ]);
  return { attendeeId, ticketId, qr, qrLink: `${origin}/public/tickets/${ticketId}/check-in/${qr}`, ticketToken };
}

function move(eventId: string, headers: Record<string, string>, input: { requestId?: string; qrLink?: string; attendeeId?: string; action: "enter" | "exit"; venueId: string; expectedRevision?: number; occurredAt?: string }) {
  return SELF.fetch(`${origin}/api/events/${eventId}/presence/movements`, {
    method: "POST", headers, body: JSON.stringify({ requestId: crypto.randomUUID(), ...input }),
  });
}

function resolve(eventId: string, headers: Record<string, string>, qrLink: string, venueId: string) {
  return SELF.fetch(`${origin}/api/events/${eventId}/presence/resolve`, { method: "POST", headers, body: JSON.stringify({ qrLink, venueId }) });
}

describe("phase 2 presence tracking", () => {
  it("keeps presence independent from ticket check-in and records venue exit then re-entry", async () => {
    const owner = await createOwner("Presence owner");
    const eventId = await createEvent(owner.organizationId, "Presence event");
    const venueA = await createVenue(eventId, "Hall A"), venueB = await createVenue(eventId, "Hall B");
    const checkedIn = await createGuest(eventId, owner.organizationId, { ticketStatus: "checked_in", registrationVenue: venueB });
    await env.DB.prepare("UPDATE tickets SET checked_in_at = CURRENT_TIMESTAMP WHERE id = ?").bind(checkedIn.ticketId).run();
    const qrResolve = await resolve(eventId, owner.headers, checkedIn.qrLink, venueA);
    expect(qrResolve.status).toBe(200);
    await expect(qrResolve.json()).resolves.toMatchObject({ attendee_id: checkedIn.attendeeId, registration_venue_id: venueB, presence: { state: "out", venue_id: null, revision: 0 }, operation_venue_id: venueA });

    const enterA = await move(eventId, owner.headers, { qrLink: checkedIn.qrLink, action: "enter", venueId: venueA, expectedRevision: 0 });
    expect(enterA.status).toBe(201);
    await expect(enterA.json()).resolves.toMatchObject({ outcome: "accepted", movement: { action: "enter", venue_id: venueA, revision: 1 }, presence: { state: "in", venue_id: venueA, revision: 1 } });
    const wrongVenueExit = await move(eventId, owner.headers, { qrLink: checkedIn.qrLink, action: "exit", venueId: venueB, expectedRevision: 1 });
    expect(wrongVenueExit.status).toBe(201);
    await expect(wrongVenueExit.json()).resolves.toMatchObject({ outcome: "state_conflict", movement: null, presence: { state: "in", venue_id: venueA, revision: 1 } });

    const exitA = await move(eventId, owner.headers, { qrLink: checkedIn.qrLink, action: "exit", venueId: venueA, expectedRevision: 1 });
    expect(exitA.status).toBe(201);
    await expect(exitA.json()).resolves.toMatchObject({ outcome: "accepted", movement: { action: "exit", venue_id: venueA, revision: 2 }, presence: { state: "out", venue_id: null, revision: 2 } });
    const enterB = await move(eventId, owner.headers, { qrLink: checkedIn.qrLink, action: "enter", venueId: venueB, expectedRevision: 2 });
    expect(enterB.status).toBe(201);
    await expect(enterB.json()).resolves.toMatchObject({ outcome: "accepted", movement: { action: "enter", venue_id: venueB, revision: 3 } });

    const ticket = await env.DB.prepare("SELECT status,checked_in_at FROM tickets WHERE id=?").bind(checkedIn.ticketId).first<{ status: string; checked_in_at: string | null }>();
    expect(ticket?.status).toBe("checked_in");
    expect(ticket?.checked_in_at).not.toBeNull();
    const checkins = await env.DB.prepare("SELECT COUNT(*) AS count FROM check_ins WHERE ticket_id=?").bind(checkedIn.ticketId).first<{ count: number }>();
    expect(checkins?.count).toBe(0);

    const snapshot = await SELF.fetch(`${origin}/api/events/${eventId}/presence?venueId=${venueB}`, { headers: owner.headers });
    await expect(snapshot.json()).resolves.toMatchObject({ presence: [expect.objectContaining({ attendee_id: checkedIn.attendeeId, state: "in", venue_id: venueB, revision: 3 })], summary: { total_in: 1, total_out: 0, total_entries: 2, venue_in: [expect.objectContaining({ venue_id: venueB, count: 1 })] } });
    const history = await SELF.fetch(`${origin}/api/events/${eventId}/presence/history?attendeeId=${checkedIn.attendeeId}`, { headers: owner.headers });
    await expect(history.json()).resolves.toMatchObject({ movements: expect.arrayContaining([
      expect.objectContaining({ action: "enter", venue_id: venueB, revision: 3 }),
      expect.objectContaining({ action: "exit", venue_id: venueA, revision: 2 }),
      expect.objectContaining({ action: "enter", venue_id: venueA, revision: 1 }),
    ]) });
  });

  it("serializes concurrent revisions and request-id retries without duplicate movements", async () => {
    const owner = await createOwner("Presence race owner");
    const eventId = await createEvent(owner.organizationId, "Presence race event");
    const venue = await createVenue(eventId, "Race Hall");
    const guest = await createGuest(eventId, owner.organizationId);
    const firstRequest = crypto.randomUUID();
    const entries = await Promise.all([
      move(eventId, owner.headers, { requestId: firstRequest, qrLink: guest.qrLink, action: "enter", venueId: venue, expectedRevision: 0 }),
      move(eventId, owner.headers, { requestId: crypto.randomUUID(), qrLink: guest.qrLink, action: "enter", venueId: venue, expectedRevision: 0 }),
    ]);
    expect(entries.map((response) => response.status).sort()).toEqual([201, 201]);
    const entryBodies = await Promise.all(entries.map((response) => response.json<{ outcome: string }>()));
    expect(entryBodies.map((body) => body.outcome).sort()).toEqual(["accepted", "revision_conflict"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM presence_movements WHERE attendee_id=?").bind(guest.attendeeId).first<{ count: number }>().then((row) => row?.count)).toBe(1);
    const failedHistory = await SELF.fetch(`${origin}/api/events/${eventId}/presence/history?attendeeId=${guest.attendeeId}`, { headers: owner.headers });
    await expect(failedHistory.json()).resolves.toMatchObject({ movements: expect.arrayContaining([
      expect.objectContaining({ outcome: "revision_conflict", status: "unsuccessful", movement_id: null }),
      expect.objectContaining({ outcome: "accepted", status: "accepted", movement_id: expect.any(String) }),
    ]) });
    const snapshot = await SELF.fetch(`${origin}/api/events/${eventId}/presence?attendeeId=${guest.attendeeId}`, { headers: owner.headers });
    await expect(snapshot.json()).resolves.toMatchObject({ summary: { total_in: 1, total_entries: 1 } });

    const sameId = crypto.randomUUID();
    const duplicate = await Promise.all([
      move(eventId, owner.headers, { requestId: sameId, qrLink: guest.qrLink, action: "exit", venueId: venue, expectedRevision: 1 }),
      move(eventId, owner.headers, { requestId: sameId, qrLink: guest.qrLink, action: "exit", venueId: venue, expectedRevision: 1 }),
    ]);
    expect(duplicate.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM presence_movements WHERE event_id=? AND request_id=?").bind(eventId, sameId).first<{ count: number }>().then((row) => row?.count)).toBe(1);
    const conflict = await move(eventId, owner.headers, { requestId: sameId, qrLink: guest.qrLink, action: "enter", venueId: venue, expectedRevision: 1 });
    expect(conflict.status).toBe(409);

    await env.DB.prepare("UPDATE ticket_qr_tokens SET expires_at='2000-01-01 00:00:00' WHERE ticket_id=?").bind(guest.ticketId).run();
    const status = await SELF.fetch(`${origin}/api/events/${eventId}/presence/movements/by-request/${sameId}`, { headers: owner.headers });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ outcome: "accepted", movement: { request_id: sameId, action: "exit", revision: 2 }, presence: { state: "out", revision: 2 } });
  });

  it("scopes staff to the actual current venue, rejects invalid QR statuses, and supports legacy reception QR", async () => {
    const owner = await createOwner("Presence scope owner");
    const eventId = await createEvent(owner.organizationId, "Presence scope event");
    const venueA = await createVenue(eventId, "Scope Hall A"), venueB = await createVenue(eventId, "Scope Hall B");
    const staffA = await createMember(owner.organizationId, "Presence staff A", "staff");
    const staffB = await createMember(owner.organizationId, "Presence staff B", "staff");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO venue_staff_assignments (venue_id,user_id) VALUES (?,?)").bind(venueA, staffA.userId),
      env.DB.prepare("INSERT INTO venue_staff_assignments (venue_id,user_id) VALUES (?,?)").bind(venueB, staffB.userId),
    ]);
    const guest = await createGuest(eventId, owner.organizationId);
    const enterB = await move(eventId, staffB.headers, { qrLink: guest.qrLink, action: "enter", venueId: venueB, expectedRevision: 0 });
    expect(enterB.status).toBe(201);
    const leakedResolve = await resolve(eventId, staffA.headers, guest.qrLink, venueA);
    expect(leakedResolve.status).toBe(403);
    await expect(leakedResolve.json()).resolves.toEqual({ error: "venue_not_assigned" });
    const leakedMove = await move(eventId, staffA.headers, { qrLink: guest.qrLink, action: "exit", venueId: venueA, expectedRevision: 1 });
    expect(leakedMove.status).toBe(403);

    const legacy = await createGuest(eventId, owner.organizationId, { legacyQr: true });
    const legacyEnter = await move(eventId, staffA.headers, { qrLink: legacy.qrLink, action: "enter", venueId: venueA, expectedRevision: 0 });
    expect(legacyEnter.status).toBe(201);
    await expect(legacyEnter.json()).resolves.toMatchObject({ outcome: "accepted" });
    const expired = await createGuest(eventId, owner.organizationId);
    await env.DB.prepare("UPDATE ticket_qr_tokens SET expires_at='2000-01-01 00:00:00' WHERE ticket_id=?").bind(expired.ticketId).run();
    expect((await move(eventId, owner.headers, { qrLink: expired.qrLink, action: "enter", venueId: venueA, expectedRevision: 0 })).status).toBe(404);
    for (const ticketStatus of ["cancelled", "voided"] as const) {
      const invalid = await createGuest(eventId, owner.organizationId, { ticketStatus });
      expect((await move(eventId, owner.headers, { qrLink: invalid.qrLink, action: "enter", venueId: venueA, expectedRevision: 0 })).status).toBe(404);
    }
    const cancelledAttendee = await createGuest(eventId, owner.organizationId, { status: "cancelled" });
    expect((await move(eventId, owner.headers, { qrLink: cancelledAttendee.qrLink, action: "enter", venueId: venueA, expectedRevision: 0 })).status).toBe(404);
  });

  it("blocks participant cancellation while present and permits it after exit", async () => {
    const owner = await createOwner("Presence cancel owner");
    const eventId = await createEvent(owner.organizationId, "Presence cancel event");
    const venue = await createVenue(eventId, "Cancellation Hall");
    const guest = await createGuest(eventId, owner.organizationId);
    const participantToken = `participant_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO participant_sessions (id,attendee_id,token_hash,expires_at) VALUES (?,?,?,datetime('now','+12 hours'))")
      .bind(crypto.randomUUID(), guest.attendeeId, await digest(participantToken)).run();
    const participantHeaders = { "content-type": "application/json", cookie: `tsudoi_participant=${participantToken}` };
    const enter = await move(eventId, owner.headers, { qrLink: guest.qrLink, action: "enter", venueId: venue, expectedRevision: 0 });
    expect(enter.status).toBe(201);
    const blocked = await SELF.fetch(`${origin}/api/participant/ticket/cancel`, { method: "POST", headers: participantHeaders, body: "{}" });
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toEqual({ error: "attendee_present" });
    await expect(env.DB.prepare("SELECT status FROM tickets WHERE id=?").bind(guest.ticketId).first()).resolves.toMatchObject({ status: "issued" });
    const exit = await move(eventId, owner.headers, { qrLink: guest.qrLink, action: "exit", venueId: venue, expectedRevision: 1 });
    expect(exit.status).toBe(201);
    const allowed = await SELF.fetch(`${origin}/api/participant/ticket/cancel`, { method: "POST", headers: participantHeaders, body: "{}" });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toEqual({ cancelled: true });
  });

  it("rolls back state, movement, request, and audit together", async () => {
    const owner = await createOwner("Presence rollback owner");
    const eventId = await createEvent(owner.organizationId, "Presence rollback event");
    const venue = await createVenue(eventId, "Rollback Hall");
    const guest = await createGuest(eventId, owner.organizationId);
    await env.DB.prepare(`CREATE TRIGGER fail_presence_audit BEFORE INSERT ON audit_logs
      WHEN NEW.action IN ('presence.entered', 'presence.exited') BEGIN SELECT RAISE(ABORT, 'presence_audit_failed'); END`).run();
    const requestId = crypto.randomUUID();
    try {
      const failed = await move(eventId, owner.headers, { requestId, qrLink: guest.qrLink, action: "enter", venueId: venue, expectedRevision: 0 });
      expect(failed.status).toBe(500);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM attendee_presence WHERE attendee_id=?").bind(guest.attendeeId).first<{ count: number }>().then((row) => row?.count)).toBe(0);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM presence_requests WHERE attendee_id=?").bind(guest.attendeeId).first<{ count: number }>().then((row) => row?.count)).toBe(0);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM presence_movements WHERE attendee_id=?").bind(guest.attendeeId).first<{ count: number }>().then((row) => row?.count)).toBe(0);
      await env.DB.prepare("DROP TRIGGER fail_presence_audit").run();
      const retry = await move(eventId, owner.headers, { requestId, qrLink: guest.qrLink, action: "enter", venueId: venue, expectedRevision: 0 });
      expect(retry.status).toBe(201);
      await expect(retry.json()).resolves.toMatchObject({ outcome: "accepted", presence: { state: "in", revision: 1 } });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_presence_audit").run();
    }
  });

  it("supports checkin-scoped API tokens and keeps viewer/tenant boundaries", async () => {
    const owner = await createOwner("Presence token owner");
    const other = await createOwner("Presence token other");
    const eventId = await createEvent(owner.organizationId, "Presence token event");
    const otherEvent = await createEvent(other.organizationId, "Other tenant event");
    const venue = await createVenue(eventId, "Token Hall");
    const guest = await createGuest(eventId, owner.organizationId);
    const foreignGuest = await createGuest(otherEvent, other.organizationId);
    const viewer = await createMember(owner.organizationId, "Presence viewer", "viewer");
    const viewerRead = await SELF.fetch(`${origin}/api/events/${eventId}/presence?venueId=${venue}`, { headers: viewer.headers });
    expect(viewerRead.status).toBe(200);
    const viewerWrite = await move(eventId, viewer.headers, { qrLink: guest.qrLink, action: "enter", venueId: venue, expectedRevision: 0 });
    expect(viewerWrite.status).toBe(403);
    const otherTenantRead = await SELF.fetch(`${origin}/api/events/${eventId}/presence`, { headers: other.headers });
    expect(otherTenantRead.status).toBe(404);
    expect((await resolve(eventId, owner.headers, foreignGuest.qrLink, venue)).status).toBe(404);

    const apiToken = `tsu_${crypto.randomUUID()}`;
    const apiTokenId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO api_tokens (id,organization_id,token_hash,scopes,label) VALUES (?,?,?,'[\"checkin:write\"]','Presence token')")
      .bind(apiTokenId, owner.organizationId, await digest(apiToken)).run();
    const tokenHeaders = { "content-type": "application/json", authorization: `Bearer ${apiToken}` };
    const tokenMove = await move(eventId, tokenHeaders, { qrLink: guest.qrLink, action: "enter", venueId: venue, expectedRevision: 0 });
    expect(tokenMove.status).toBe(201);
    const tokenResult = await tokenMove.json<{ outcome: string; movement: { id: string } }>();
    expect(tokenResult).toMatchObject({ outcome: "accepted", movement: { action: "enter", venue_id: venue, revision: 1 } });
    const loggedActor = await env.DB.prepare("SELECT actor_id FROM audit_logs WHERE action='presence.entered' AND target_id=?")
      .bind(tokenResult.movement.id).first<{ actor_id: string }>();
    expect(loggedActor?.actor_id).toBe(apiTokenId);
  });
});
