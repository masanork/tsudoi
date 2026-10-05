import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const origin = "http://localhost:8787";

async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createSession(name: string, role: "owner" | "admin" | "staff" | "viewer" = "owner") {
  const organizationId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const sessionToken = `session_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(organizationId, name),
    env.DB.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").bind(userId, name),
    env.DB.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)").bind(organizationId, userId, role),
    env.DB.prepare("INSERT INTO organizer_sessions (id, user_id, organization_id, token_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+12 hours'))")
      .bind(crypto.randomUUID(), userId, organizationId, await digest(sessionToken)),
  ]);
  return { organizationId, userId, sessionToken, headers: { "content-type": "application/json", cookie: `tsudoi_organizer=${sessionToken}` } };
}

async function createMemberSession(organizationId: string, name: string, role: "admin" | "staff" | "viewer") {
  const userId = crypto.randomUUID();
  const sessionToken = `session_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").bind(userId, name),
    env.DB.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)").bind(organizationId, userId, role),
    env.DB.prepare("INSERT INTO organizer_sessions (id, user_id, organization_id, token_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+12 hours'))")
      .bind(crypto.randomUUID(), userId, organizationId, await digest(sessionToken)),
  ]);
  return { organizationId, userId, sessionToken, headers: { "content-type": "application/json", cookie: `tsudoi_organizer=${sessionToken}` } };
}

async function createEvent(organizationId: string, name: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO events (id, organization_id, name, starts_at, ends_at, registration_mode, status)
    VALUES (?, ?, ?, '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', 'hybrid', 'published')`).bind(id, organizationId, name).run();
  return id;
}

async function createVenue(eventId: string, name: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO venues (id, event_id, name) VALUES (?, ?, ?)").bind(id, eventId, name).run();
  return id;
}

async function createAttendee(eventId: string, organizationId: string, options: { name?: string; venueId?: string | null; status?: "active" | "cancelled"; ticketStatus?: "issued" | "checked_in" | "cancelled" | "voided"; qrExpires?: string; tokenKeyId?: "possession-v2" | "v1" } = {}) {
  const attendeeId = crypto.randomUUID(), ticketId = crypto.randomUUID();
  const qrToken = `qr_${crypto.randomUUID()}`;
  const ticketToken = `passkey_${crypto.randomUUID()}`;
  const receptionTokenHash = options.tokenKeyId === "v1" ? await digest(qrToken) : await digest(ticketToken);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO attendees (id, organization_id, event_id, venue_id, name, affiliation, registration_source, status, cancelled_at)
      VALUES (?, ?, ?, ?, ?, 'Example affiliation', 'admin', ?, CASE WHEN ? = 'cancelled' THEN CURRENT_TIMESTAMP ELSE NULL END)`)
      .bind(attendeeId, organizationId, eventId, options.venueId ?? null, options.name ?? "Guest", options.status ?? "active", options.status ?? "active"),
    env.DB.prepare(`INSERT INTO tickets (id, attendee_id, event_id, token_hash, token_key_id, status, checked_in_at)
      VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? = 'checked_in' THEN CURRENT_TIMESTAMP ELSE NULL END)`)
      .bind(ticketId, attendeeId, eventId, receptionTokenHash, options.tokenKeyId ?? "possession-v2", options.ticketStatus ?? "issued", options.ticketStatus ?? "issued"),
    ...(options.tokenKeyId === "v1" ? [] : [env.DB.prepare("INSERT INTO ticket_qr_tokens (id, ticket_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), ticketId, await digest(qrToken), options.qrExpires ?? "2999-01-01 00:00:00")]),
  ]);
  return { attendeeId, ticketId, qrToken, ticketToken, qrLink: `${origin}/public/tickets/${ticketId}/check-in/${qrToken}` };
}

async function createDistribution(eventId: string, headers: Record<string, string>, name = "Lunch", maxPerAttendee = 1) {
  const response = await SELF.fetch(`${origin}/api/events/${eventId}/distributions`, {
    method: "POST", headers, body: JSON.stringify({ name, unit: "meal", maxPerAttendee }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ id: string }>()).id;
}

function claimRequest(eventId: string, distributionId: string, headers: Record<string, string>, input: { requestId?: string; qrLink?: string; attendeeId?: string; quantity?: number; venueId?: string | null }) {
  const { requestId = crypto.randomUUID(), quantity = 1, venueId = undefined, ...target } = input;
  return SELF.fetch(`${origin}/api/events/${eventId}/distributions/${distributionId}/claims`, {
    method: "POST", headers,
    body: JSON.stringify({ requestId, quantity, ...target, ...(venueId !== undefined ? { venueId } : {}) }),
  });
}

async function countClaims(distributionId: string) {
  return (await env.DB.prepare("SELECT COUNT(*) AS count FROM distribution_claims WHERE distribution_id = ?").bind(distributionId).first<{ count: number }>())!.count;
}

async function countAudit(eventId: string, action: string) {
  return (await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE target_type = 'distribution_claim' AND action = ? AND target_id IN (SELECT id FROM distribution_claims WHERE event_id = ?)")
    .bind(action, eventId).first<{ count: number }>())!.count;
}

describe("phase 1 distribution claims", () => {
  it("creates event-scoped distributions and limits administration and tenant access", async () => {
    const owner = await createSession("Distribution owner");
    const other = await createSession("Other distribution tenant");
    const eventId = await createEvent(owner.organizationId, "Distribution event");
    const distributionId = await createDistribution(eventId, owner.headers);

    const listed = await SELF.fetch(`${origin}/api/events/${eventId}/distributions`, { headers: owner.headers });
    await expect(listed.json()).resolves.toMatchObject({ distributions: [{ id: distributionId, name: "Lunch", unit: "meal", max_per_attendee: 1, active: true }] });
    const duplicateName = await SELF.fetch(`${origin}/api/events/${eventId}/distributions`, {
      method: "POST", headers: owner.headers, body: JSON.stringify({ name: " lunch ", unit: "meal", maxPerAttendee: 1 }),
    });
    expect(duplicateName.status).toBe(409);

    const viewer = await createMemberSession(owner.organizationId, "Distribution viewer", "viewer");
    const viewerList = await SELF.fetch(`${origin}/api/events/${eventId}/distributions`, { headers: viewer.headers });
    expect(viewerList.status).toBe(200);
    const viewerCreate = await SELF.fetch(`${origin}/api/events/${eventId}/distributions`, { method: "POST", headers: viewer.headers, body: JSON.stringify({ name: "Forbidden", unit: "item", maxPerAttendee: 1 }) });
    expect(viewerCreate.status).toBe(403);

    const crossTenant = await SELF.fetch(`${origin}/api/events/${eventId}/distributions`, { headers: other.headers });
    expect(crossTenant.status).toBe(404);
    const maxBad = await SELF.fetch(`${origin}/api/events/${eventId}/distributions`, { method: "POST", headers: owner.headers, body: JSON.stringify({ name: "Invalid", unit: "meal", maxPerAttendee: 1001 }) });
    expect(maxBad.status).toBe(400);
  });

  it("accepts an existing reception QR before or after check-in, enforces the per-round quota, and replays idempotently", async () => {
    const owner = await createSession("Quota owner");
    const eventId = await createEvent(owner.organizationId, "Quota event");
    const venueId = await createVenue(eventId, "Hall A");
    const roundId = await createDistribution(eventId, owner.headers, "Lunch", 2);
    const dinnerId = await createDistribution(eventId, owner.headers, "Dinner", 1);
    const guest = await createAttendee(eventId, owner.organizationId, { venueId, ticketStatus: "checked_in" });
    const requestId = crypto.randomUUID();

    const results = await Promise.all([
      claimRequest(eventId, roundId, owner.headers, { requestId, qrLink: guest.qrLink, quantity: 1 }),
      claimRequest(eventId, roundId, owner.headers, { requestId: crypto.randomUUID(), qrLink: guest.qrLink, quantity: 1 }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 201]);
    const bodies = await Promise.all(results.map((response) => response.json<{ outcome: string; used: number; remaining: number }>())).then((values) => values);
    expect(bodies.map((body) => body.outcome)).toEqual(["accepted", "accepted"]);
    expect(bodies.every((body) => body.used === 1 || body.used === 2)).toBe(true);

    const replay = await claimRequest(eventId, roundId, owner.headers, { requestId, qrLink: guest.qrLink, quantity: 1 });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ outcome: "accepted" });
    const mismatch = await claimRequest(eventId, roundId, owner.headers, { requestId, qrLink: guest.qrLink, quantity: 2 });
    expect(mismatch.status).toBe(409);

    const limit = await claimRequest(eventId, roundId, owner.headers, { requestId: crypto.randomUUID(), qrLink: guest.qrLink, quantity: 1 });
    expect(limit.status).toBe(201);
    await expect(limit.json()).resolves.toMatchObject({ outcome: "limit_reached", used: 2, remaining: 0 });
    const separateRound = await claimRequest(eventId, dinnerId, owner.headers, { requestId: crypto.randomUUID(), qrLink: guest.qrLink, quantity: 1 });
    expect(separateRound.status).toBe(201);
    await expect(separateRound.json()).resolves.toMatchObject({ outcome: "accepted", used: 1, remaining: 0 });

    const ticket = await env.DB.prepare("SELECT status, checked_in_at FROM tickets WHERE id = ?").bind(guest.ticketId).first<{ status: string; checked_in_at: string | null }>();
    expect(ticket?.status).toBe("checked_in");
    expect(ticket?.checked_in_at).not.toBeNull();
    expect(await countClaims(roundId)).toBe(3);
    expect(await countAudit(eventId, "distribution.claim_attempted")).toBe(4);
  });

  it("serializes the last quota slot and converges concurrent request-id retries", async () => {
    const owner = await createSession("Concurrent distribution owner");
    const eventId = await createEvent(owner.organizationId, "Concurrent distribution event");
    const oneSlot = await createDistribution(eventId, owner.headers, "Single slot", 1);
    const guest = await createAttendee(eventId, owner.organizationId);

    const competing = await Promise.all([
      claimRequest(eventId, oneSlot, owner.headers, { requestId: crypto.randomUUID(), qrLink: guest.qrLink }),
      claimRequest(eventId, oneSlot, owner.headers, { requestId: crypto.randomUUID(), qrLink: guest.qrLink }),
    ]);
    expect(competing.map((response) => response.status).sort()).toEqual([201, 201]);
    const competingBodies = await Promise.all(competing.map((response) => response.json<{ outcome: string }>()));
    expect(competingBodies.map((body) => body.outcome).sort()).toEqual(["accepted", "limit_reached"]);
    const acceptedCount = await env.DB.prepare("SELECT COALESCE(SUM(quantity), 0) AS used FROM distribution_claims WHERE distribution_id = ? AND attendee_id = ? AND outcome = 'accepted' AND reversed_at IS NULL")
      .bind(oneSlot, guest.attendeeId).first<{ used: number }>();
    expect(acceptedCount?.used).toBe(1);

    const sameRequestId = crypto.randomUUID();
    const converged = await Promise.all([
      claimRequest(eventId, oneSlot, owner.headers, { requestId: sameRequestId, qrLink: guest.qrLink }),
      claimRequest(eventId, oneSlot, owner.headers, { requestId: sameRequestId, qrLink: guest.qrLink }),
    ]);
    expect(converged.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM distribution_claims WHERE distribution_id = ? AND request_id = ?")
      .bind(oneSlot, sameRequestId).first<{ count: number }>().then((row) => row?.count)).toBe(1);

    const conflictingId = crypto.randomUUID();
    const conflicting = await Promise.all([
      claimRequest(eventId, oneSlot, owner.headers, { requestId: conflictingId, qrLink: guest.qrLink, quantity: 1 }),
      claimRequest(eventId, oneSlot, owner.headers, { requestId: conflictingId, qrLink: guest.qrLink, quantity: 2 }),
    ]);
    expect(conflicting.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM distribution_claims WHERE distribution_id = ? AND request_id = ?")
      .bind(oneSlot, conflictingId).first<{ count: number }>().then((row) => row?.count)).toBe(1);
  });

  it("allows the original actor to reconcile a committed request after QR expiry", async () => {
    const owner = await createSession("Request status owner");
    const otherActor = await createMemberSession(owner.organizationId, "Request status other actor", "admin");
    const eventId = await createEvent(owner.organizationId, "Request status event");
    const roundId = await createDistribution(eventId, owner.headers);
    const guest = await createAttendee(eventId, owner.organizationId);
    const requestId = crypto.randomUUID();
    const post = await claimRequest(eventId, roundId, owner.headers, { requestId, qrLink: guest.qrLink });
    expect(post.status).toBe(201);
    await env.DB.prepare("UPDATE ticket_qr_tokens SET expires_at = '2000-01-01 00:00:00' WHERE ticket_id = ?").bind(guest.ticketId).run();

    const statusUrl = `${origin}/api/events/${eventId}/distributions/${roundId}/claims/by-request/${requestId}`;
    const status = await SELF.fetch(statusUrl, { headers: owner.headers });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ claim: { request_id: requestId, outcome: "accepted", attendee_id: guest.attendeeId } });
    const hiddenFromOtherActor = await SELF.fetch(statusUrl, { headers: otherActor.headers });
    expect(hiddenFromOtherActor.status).toBe(404);
    const expiredPost = await claimRequest(eventId, roundId, owner.headers, { requestId, qrLink: guest.qrLink });
    expect(expiredPost.status).toBe(404);
  });

  it("rejects expired, cancelled, voided, magic-link, foreign-event, and foreign-tenant QR values", async () => {
    const owner = await createSession("QR owner");
    const other = await createSession("QR other tenant");
    const eventId = await createEvent(owner.organizationId, "QR event");
    const foreignEventId = await createEvent(other.organizationId, "Foreign QR event");
    const roundId = await createDistribution(eventId, owner.headers);
    const expired = await createAttendee(eventId, owner.organizationId, { qrExpires: "2000-01-01 00:00:00" });
    const cancelledAttendee = await createAttendee(eventId, owner.organizationId, { status: "cancelled" });
    const cancelledTicket = await createAttendee(eventId, owner.organizationId, { ticketStatus: "cancelled" });
    const voidedTicket = await createAttendee(eventId, owner.organizationId, { ticketStatus: "voided" });
    const foreignGuest = await createAttendee(foreignEventId, other.organizationId);
    const valid = await createAttendee(eventId, owner.organizationId);
    const rejectedLinks = [expired.qrLink, cancelledAttendee.qrLink, cancelledTicket.qrLink, voidedTicket.qrLink, foreignGuest.qrLink,
      `${origin}/public/magic-links/${valid.qrToken}`];
    for (const qrLink of rejectedLinks) {
      const response = await SELF.fetch(`${origin}/api/events/${eventId}/credentials/resolve`, { method: "POST", headers: owner.headers, body: JSON.stringify({ qrLink }) });
      expect(response.status).toBe(404);
    }
    const checkedIn = await createAttendee(eventId, owner.organizationId, { ticketStatus: "checked_in" });
    const resolve = await SELF.fetch(`${origin}/api/events/${eventId}/credentials/resolve`, { method: "POST", headers: owner.headers, body: JSON.stringify({ qrLink: checkedIn.qrLink }) });
    expect(resolve.status).toBe(200);
    await expect(resolve.json()).resolves.toMatchObject({ attendee_id: checkedIn.attendeeId, name: "Guest" });
    const claim = await claimRequest(eventId, roundId, owner.headers, { requestId: crypto.randomUUID(), qrLink: checkedIn.qrLink });
    expect(claim.status).toBe(201);
    await expect(claim.json()).resolves.toMatchObject({ outcome: "accepted" });

    const legacy = await createAttendee(eventId, owner.organizationId, { tokenKeyId: "v1" });
    const legacyResolve = await SELF.fetch(`${origin}/api/events/${eventId}/credentials/resolve`, { method: "POST", headers: owner.headers, body: JSON.stringify({ qrLink: legacy.qrLink }) });
    expect(legacyResolve.status).toBe(200);
    const legacyClaim = await claimRequest(eventId, roundId, owner.headers, { requestId: crypto.randomUUID(), qrLink: legacy.qrLink });
    expect(legacyClaim.status).toBe(201);
    const possessionAsQr = `${origin}/public/tickets/${checkedIn.ticketId}/check-in/${checkedIn.ticketToken}`;
    const rejectPossession = await SELF.fetch(`${origin}/api/events/${eventId}/credentials/resolve`, { method: "POST", headers: owner.headers, body: JSON.stringify({ qrLink: possessionAsQr }) });
    expect(rejectPossession.status).toBe(404);
  });

  it("enforces assigned venue scope for staff and keeps claim reversal atomic and one-time", async () => {
    const owner = await createSession("Venue distribution owner");
    const eventId = await createEvent(owner.organizationId, "Venue distribution event");
    const venueA = await createVenue(eventId, "Hall A"), venueB = await createVenue(eventId, "Hall B");
    const staff = await createMemberSession(owner.organizationId, "Distribution staff", "staff");
    await env.DB.prepare("INSERT INTO venue_staff_assignments (venue_id, user_id) VALUES (?, ?)").bind(venueA, staff.userId).run();
    const roundId = await createDistribution(eventId, owner.headers);
    const atA = await createAttendee(eventId, owner.organizationId, { venueId: venueA });
    const atB = await createAttendee(eventId, owner.organizationId, { venueId: venueB });
    const unassigned = await createAttendee(eventId, owner.organizationId);
    const allowed = await SELF.fetch(`${origin}/api/events/${eventId}/credentials/resolve`, { method: "POST", headers: staff.headers, body: JSON.stringify({ qrLink: atA.qrLink }) });
    expect(allowed.status).toBe(200);
    const wrongVenue = await SELF.fetch(`${origin}/api/events/${eventId}/credentials/resolve`, { method: "POST", headers: staff.headers, body: JSON.stringify({ qrLink: atB.qrLink }) });
    expect(wrongVenue.status).toBe(403);
    const wrongRequested = await SELF.fetch(`${origin}/api/events/${eventId}/credentials/resolve`, { method: "POST", headers: staff.headers, body: JSON.stringify({ qrLink: atA.qrLink, venueId: venueB }) });
    expect(wrongRequested.status).toBe(403);

    const claim = await claimRequest(eventId, roundId, staff.headers, { requestId: crypto.randomUUID(), qrLink: atA.qrLink });
    expect(claim.status).toBe(201);
    const unassignedResolve = await SELF.fetch(`${origin}/api/events/${eventId}/credentials/resolve`, { method: "POST", headers: staff.headers, body: JSON.stringify({ qrLink: unassigned.qrLink, venueId: venueA }) });
    expect(unassignedResolve.status).toBe(200);
    const unassignedClaim = await claimRequest(eventId, roundId, staff.headers, { requestId: crypto.randomUUID(), qrLink: unassigned.qrLink, venueId: venueA });
    expect(unassignedClaim.status).toBe(201);
    await expect(unassignedClaim.json()).resolves.toMatchObject({ outcome: "accepted", claim: { venue_id: venueA } });
    const unassignedAdminClaim = await claimRequest(eventId, roundId, owner.headers, { requestId: crypto.randomUUID(), qrLink: unassigned.qrLink, venueId: venueB });
    expect(unassignedAdminClaim.status).toBe(201);
    const claimBody = await claim.json<{ claim: { id: string } }>();
    const reverse = await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${roundId}/claims/${claimBody.claim.id}/reverse`, { method: "POST", headers: owner.headers, body: JSON.stringify({ reason: "Duplicate paper issue" }) });
    expect(reverse.status).toBe(200);
    await expect(reverse.json()).resolves.toMatchObject({ reversed: true, claim: { status: "reversed", reverse_reason: "Duplicate paper issue" } });
    const repeatReverse = await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${roundId}/claims/${claimBody.claim.id}/reverse`, { method: "POST", headers: owner.headers, body: JSON.stringify({ reason: "Again" }) });
    expect(repeatReverse.status).toBe(409);
    const refill = await claimRequest(eventId, roundId, owner.headers, { requestId: crypto.randomUUID(), attendeeId: atA.attendeeId });
    expect(refill.status).toBe(201);
    await expect(refill.json()).resolves.toMatchObject({ outcome: "accepted", used: 1, remaining: 0 });
    const staffList = await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${roundId}/claims`, { headers: staff.headers });
    await expect(staffList.json()).resolves.toMatchObject({ claims: expect.arrayContaining([expect.objectContaining({ attendee_id: atA.attendeeId })]) });
  });

  it("rolls back both claim and reversal changes when audit writes fail", async () => {
    const owner = await createSession("Audit distribution owner");
    const eventId = await createEvent(owner.organizationId, "Audit distribution event");
    const roundId = await createDistribution(eventId, owner.headers);
    const guest = await createAttendee(eventId, owner.organizationId);
    await env.DB.prepare(`CREATE TRIGGER fail_distribution_claim_audit BEFORE INSERT ON audit_logs
      WHEN NEW.action IN ('distribution.claim_attempted', 'distribution.claim_reversed')
      BEGIN SELECT RAISE(ABORT, 'audit_write_failed'); END`).run();
    try {
      const failedClaim = await claimRequest(eventId, roundId, owner.headers, { requestId: crypto.randomUUID(), qrLink: guest.qrLink });
      expect(failedClaim.status).toBe(500);
      expect(await countClaims(roundId)).toBe(0);

      await env.DB.prepare("DROP TRIGGER fail_distribution_claim_audit").run();
      const successfulClaim = await claimRequest(eventId, roundId, owner.headers, { requestId: crypto.randomUUID(), qrLink: guest.qrLink });
      expect(successfulClaim.status).toBe(201);
      const claimBody = await successfulClaim.json<{ claim: { id: string } }>();
      await env.DB.prepare(`CREATE TRIGGER fail_distribution_claim_audit BEFORE INSERT ON audit_logs
        WHEN NEW.action = 'distribution.claim_reversed'
        BEGIN SELECT RAISE(ABORT, 'audit_write_failed'); END`).run();
      const failedReverse = await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${roundId}/claims/${claimBody.claim.id}/reverse`, { method: "POST", headers: owner.headers, body: JSON.stringify({ reason: "Test rollback" }) });
      expect(failedReverse.status).toBe(500);
      await expect(env.DB.prepare("SELECT reversed_at, reverse_reason FROM distribution_claims WHERE id = ?").bind(claimBody.claim.id).first()).resolves.toMatchObject({ reversed_at: null, reverse_reason: null });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_distribution_claim_audit").run();
    }
  });
});
