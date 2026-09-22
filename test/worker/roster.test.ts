import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function createApiOrganization(name: string) {
  const organizationId = crypto.randomUUID();
  const token = `tsu_test_${crypto.randomUUID()}`;
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(organizationId, name),
    env.DB.prepare("INSERT INTO api_tokens (id, organization_id, token_hash, scopes, label) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), organizationId, hash, JSON.stringify(["admin"]), "test token"),
  ]);
  return { organizationId, token };
}

async function createOrganizerSession(name: string) {
  const organizationId = crypto.randomUUID(), userId = crypto.randomUUID(), sessionToken = `session_${crypto.randomUUID()}`;
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionToken)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(organizationId, name),
    env.DB.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").bind(userId, "Owner"),
    env.DB.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'owner')").bind(organizationId, userId),
    env.DB.prepare("INSERT INTO organizer_sessions (id, user_id, organization_id, token_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+12 hours'))")
      .bind(crypto.randomUUID(), userId, organizationId, hash),
  ]);
  return { sessionToken, organizationId, userId };
}

async function createParticipantSession(attendeeId: string) {
  const sessionToken = `participant_${crypto.randomUUID()}`;
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionToken)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("INSERT INTO participant_sessions (id, attendee_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+12 hours'))")
    .bind(crypto.randomUUID(), attendeeId, hash).run();
  return sessionToken;
}

describe("Worker D1 roster flow", () => {
  it("uses an HttpOnly organizer session without a bearer token", async () => {
    const { sessionToken } = await createOrganizerSession("Session organization");
    const response = await SELF.fetch("https://tsudoi.test/api/events", { headers: { cookie: `tsudoi_organizer=${sessionToken}` } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  it("deletes an empty draft and archives an event that was published", async () => {
    const { organizationId, token } = await createApiOrganization("Archiving organization");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const createDraft = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Disposable draft", startsAt: "2026-10-01T09:00:00Z", endsAt: "2026-10-01T10:00:00Z", registrationMode: "hybrid" }) });
    const { id: draftId } = await createDraft.json<{ id: string }>();
    const deleted = await SELF.fetch(`https://tsudoi.test/api/events/${draftId}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ action: "deleted" });
    await expect(env.DB.prepare("SELECT id FROM events WHERE id = ?").bind(draftId).first()).resolves.toBeNull();

    const createPublished = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Keep as record", startsAt: "2026-10-02T09:00:00Z", endsAt: "2026-10-02T10:00:00Z", registrationMode: "hybrid" }) });
    const { id: publishedId } = await createPublished.json<{ id: string }>();
    await SELF.fetch(`https://tsudoi.test/api/events/${publishedId}/publish`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const archived = await SELF.fetch(`https://tsudoi.test/api/events/${publishedId}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toEqual({ action: "archived" });
    await expect(env.DB.prepare("SELECT status, archived_at FROM events WHERE id = ?").bind(publishedId).first()).resolves.toMatchObject({ status: "closed" });
    const events = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { headers: { authorization: `Bearer ${token}` } });
    await expect(events.json()).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: publishedId })]));
  });

  it("creates an event and returns dynamically-added answer columns", async () => {
    const { organizationId, token } = await createApiOrganization("Test organization");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };

    const eventResponse = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Test event", startsAt: "2026-10-01T09:00:00Z", endsAt: "2026-10-01T10:00:00Z", registrationMode: "hybrid" }) });
    expect(eventResponse.status).toBe(201);
    const { id: eventId } = await eventResponse.json<{ id: string }>();

    const fieldResponse = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/form-fields`, { method: "POST", headers: auth, body: JSON.stringify({ key: "company", label: "Company", type: "text", required: true }) });
    expect(fieldResponse.status).toBe(201);

    const attendeeResponse = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/attendees`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Ada Lovelace", email: "ada@example.test", answers: { company: "Analytical Engines" } }) });
    expect(attendeeResponse.status).toBe(201);

    const roster = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/roster`, { headers: { authorization: `Bearer ${token}` } });
    expect(roster.status).toBe(200);
    await expect(roster.json()).resolves.toMatchObject({ fields: [{ field_key: "company", label: "Company" }], attendees: [{ name: "Ada Lovelace", email_normalized: "ada@example.test", answers: { company: "Analytical Engines" } }] });
  });

  it("refuses registrations after reaching an event capacity", async () => {
    const { organizationId, token } = await createApiOrganization("Capacity organization");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const eventResponse = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Limited event", startsAt: "2026-10-02T09:00:00Z", endsAt: "2026-10-02T10:00:00Z", registrationMode: "hybrid", capacity: 1 }) });
    const { id: eventId } = await eventResponse.json<{ id: string }>();
    const publish = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/publish`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(publish.status).toBe(200);

    const first = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "First attendee" }) });
    expect(first.status).toBe(201);
    const second = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Second attendee" }) });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({ error: "capacity_reached" });

    await env.DB.prepare("UPDATE attendees SET status = 'cancelled' WHERE event_id = ? AND name = 'First attendee'").bind(eventId).run();
    const replacement = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Replacement attendee" }) });
    expect(replacement.status).toBe(201);
    await expect(env.DB.prepare("SELECT active_registration_count FROM events WHERE id = ?").bind(eventId).first<{ active_registration_count: number }>()).resolves.toEqual({ active_registration_count: 1 });
  });

  it("does not accept registrations before the configured opening time", async () => {
    const { organizationId, token } = await createApiOrganization("Scheduled organization");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const eventResponse = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Future event", startsAt: "2999-10-02T09:00:00Z", endsAt: "2999-10-02T10:00:00Z", registrationMode: "hybrid", registrationOpensAt: "2999-01-01T00:00:00Z" }) });
    const { id: eventId } = await eventResponse.json<{ id: string }>();
    await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/publish`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const registration = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Too early" }) });
    expect(registration.status).toBe(404);
    await expect(registration.json()).resolves.toEqual({ error: "registration_unavailable" });
  });

  it("supports scheduling before confirming an event date", async () => {
    const { organizationId, token } = await createApiOrganization("Scheduling organization");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const eventResponse = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Date poll", schedulingEnabled: true, registrationMode: "hybrid" }) });
    expect(eventResponse.status).toBe(201);
    const { id: eventId } = await eventResponse.json<{ id: string }>();

    const optionResponse = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/schedule/options`, { method: "POST", headers: auth, body: JSON.stringify({ startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T10:00:00Z" }) });
    expect(optionResponse.status).toBe(201);
    const { id: optionId } = await optionResponse.json<{ id: string }>();
    const publicSchedule = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/schedule`);
    expect(publicSchedule.status).toBe(200);
    await expect(publicSchedule.json()).resolves.toMatchObject({ event: { name: "Date poll", schedule_status: "collecting" }, options: [{ id: optionId }] });

    const response = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/schedule/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ optionId, respondentId: "respondent-1", respondentName: "Ada Lovelace", response: "yes" }) });
    expect(response.status).toBe(201);
    const confirm = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/schedule/confirm`, { method: "POST", headers: auth, body: JSON.stringify({ optionId }) });
    expect(confirm.status).toBe(200);
    await expect(env.DB.prepare("SELECT starts_at, ends_at, schedule_status FROM events WHERE id = ?").bind(eventId).first()).resolves.toMatchObject({ starts_at: "2026-11-01T09:00:00Z", schedule_status: "confirmed" });
  });

  it("creates a schedule poll with its initial options", async () => {
    const { organizationId, token } = await createApiOrganization("Initial schedule options");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const eventResponse = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Date poll", schedulingEnabled: true, scheduleDurationMinutes: 60, registrationMode: "hybrid", initialScheduleOptions: [{ startsAt: "2026-11-01T09:00:00Z", note: "会議室 A" }, { startsAt: "2026-11-02T09:00:00Z" }] }) });
    expect(eventResponse.status).toBe(201);
    const { id: eventId } = await eventResponse.json<{ id: string }>();
    const schedule = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/schedule`);
    await expect(schedule.json()).resolves.toMatchObject({ options: [{ starts_at: "2026-11-01T09:00:00Z", ends_at: "2026-11-01T10:00:00.000Z", note: "会議室 A" }, { starts_at: "2026-11-02T09:00:00Z", ends_at: "2026-11-02T10:00:00.000Z" }] });
  });

  it("allows a fixed-date event to omit its end time", async () => {
    const { organizationId, token } = await createApiOrganization("Start time only");
    const response = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "Short event", startsAt: "2026-11-01T09:00:00Z", registrationMode: "hybrid" }) });
    expect(response.status).toBe(201);
    const { id } = await response.json<{ id: string }>();
    await expect(env.DB.prepare("SELECT starts_at, ends_at FROM events WHERE id = ?").bind(id).first()).resolves.toEqual({ starts_at: "2026-11-01T09:00:00Z", ends_at: "2026-11-01T09:00:00Z" });
  });

  it("lets a participant agent read and answer only its linked schedule", async () => {
    const { organizationId, token } = await createApiOrganization("Agent scheduling");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const created = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Agent poll", schedulingEnabled: true, registrationMode: "hybrid", initialScheduleOptions: [{ startsAt: "2026-11-01T09:00:00Z" }] }) });
    const { id: eventId } = await created.json<{ id: string }>();
    const options = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/schedule`);
    const { options: [option] } = await options.json<{ options: Array<{ id: string }> }>();
    const connection = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/schedule/agent-connections`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ respondentId: "agent-owner", respondentName: "Ada" }) });
    expect(connection.status).toBe(201);
    const { token: agentToken } = await connection.json<{ token: string }>();
    const mcpHeaders = { "content-type": "application/json", authorization: `Bearer ${agentToken}` };
    const tools = await SELF.fetch("https://tsudoi.test/mcp", { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    await expect(tools.json()).resolves.toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: "submit_schedule_availability" })]) } });
    const answer = await SELF.fetch("https://tsudoi.test/mcp", { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submit_schedule_availability", arguments: { optionId: option.id, response: "yes" } } }) });
    await expect(answer.json()).resolves.toMatchObject({ result: { content: [{ type: "text" }] } });
    await expect(env.DB.prepare("SELECT respondent_id, response FROM schedule_responses WHERE option_id = ?").bind(option.id).first()).resolves.toEqual({ respondent_id: "agent-owner", response: "yes" });
    const preferences = await SELF.fetch("https://tsudoi.test/mcp", { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "update_scheduling_preferences", arguments: { availabilityText: "Weekday evenings preferred", constraints: { maxDurationMinutes: 90, unavailableWeekdays: ["monday"] } } } }) });
    await expect(preferences.json()).resolves.toMatchObject({ result: { content: [{ type: "text" }] } });
    await expect(env.DB.prepare("SELECT availability_text, constraints_json FROM scheduling_preferences WHERE event_id = ? AND respondent_id = ?").bind(eventId, "agent-owner").first<{ availability_text: string; constraints_json: string }>()).resolves.toMatchObject({ availability_text: "Weekday evenings preferred", constraints_json: expect.stringContaining("maxDurationMinutes") });
  });

  it("revokes an agent connection and closes agent writes once a schedule is confirmed", async () => {
    const { organizationId, token } = await createApiOrganization("Agent revocation");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const created = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Revocable poll", schedulingEnabled: true, registrationMode: "hybrid", initialScheduleOptions: [{ startsAt: "2026-12-01T09:00:00Z" }] }) });
    const { id: eventId } = await created.json<{ id: string }>();
    const schedule = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/schedule`);
    const { options: [option] } = await schedule.json<{ options: Array<{ id: string }> }>();
    const issued = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/schedule/agent-connections`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ respondentId: "owner", respondentName: "Owner" }) });
    const { token: agentToken } = await issued.json<{ token: string }>();
    const listed = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/schedule/agent-connections?respondentId=owner`);
    const { connections: [connection] } = await listed.json<{ connections: Array<{ id: string }> }>();
    const revoked = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/schedule/agent-connections/${connection.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ respondentId: "owner" }) });
    expect(revoked.status).toBe(200);
    const denied = await SELF.fetch("https://tsudoi.test/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(denied.status).toBe(401);
    const fresh = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/schedule/agent-connections`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ respondentId: "owner", respondentName: "Owner" }) });
    const { token: freshToken } = await fresh.json<{ token: string }>();
    await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/schedule/confirm`, { method: "POST", headers: auth, body: JSON.stringify({ optionId: option.id }) });
    const preferenceWrite = await SELF.fetch("https://tsudoi.test/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${freshToken}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "update_scheduling_preferences", arguments: { availabilityText: "Changed" } } }) });
    await expect(preferenceWrite.json()).resolves.toMatchObject({ result: { isError: true } });
  });

  it("assigns the session creator as organizer and protects the last organizer", async () => {
    const { sessionToken, organizationId, userId } = await createOrganizerSession("Organizer organization");
    const headers = { "content-type": "application/json", cookie: `tsudoi_organizer=${sessionToken}` };
    const created = await SELF.fetch("https://tsudoi.test/api/events", { method: "POST", headers, body: JSON.stringify({ name: "Hosted event", startsAt: "2026-12-01T09:00:00Z", registrationMode: "hybrid" }) });
    const { id: eventId } = await created.json<{ id: string }>();
    const organizers = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/organizers`, { headers });
    await expect(organizers.json()).resolves.toMatchObject({ organizers: [{ user_id: userId, role: "organizer" }] });
    const removal = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/organizers/${userId}`, { method: "DELETE", headers });
    expect(removal.status).toBe(409);
    const cohostId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").bind(cohostId, "Cohost"),
      env.DB.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'staff')").bind(organizationId, cohostId),
    ]);
    const assignment = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/organizers`, { method: "POST", headers, body: JSON.stringify({ userId: cohostId, role: "cohost" }) });
    expect(assignment.status).toBe(201);
  });

  it("runs the attendee ticket, check-in, and encrypted message lifecycle", async () => {
    const { organizationId, token } = await createApiOrganization("Ticket lifecycle");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const created = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Lifecycle event", startsAt: "2026-12-10T09:00:00Z", registrationMode: "hybrid" }) });
    const { id: eventId } = await created.json<{ id: string }>();
    const venue = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/venues`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Main hall", address: "Tokyo", capacity: 30 }) });
    expect(venue.status).toBe(201);
    const field = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/form-fields`, { method: "POST", headers: auth, body: JSON.stringify({ key: "diet", label: "Diet", type: "single_select", required: true, options: ["none", "vegetarian"] }) });
    expect(field.status).toBe(201);
    await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/publish`, { method: "POST", headers: { authorization: `Bearer ${token}` } });

    const registration = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ada", email: "ada@example.test", answers: { diet: "vegetarian" } }) });
    expect(registration.status).toBe(201);
    const { attendeeId, ticketId, ticketToken } = await registration.json<{ attendeeId: string; ticketId: string; ticketToken: string }>();
    const participantToken = await createParticipantSession(attendeeId);
    const participantHeaders = { "content-type": "application/json", cookie: `tsudoi_participant=${participantToken}` };

    const ticket = await SELF.fetch("https://tsudoi.test/api/participant/ticket", { headers: participantHeaders });
    await expect(ticket.json()).resolves.toMatchObject({ id: ticketId, event_id: eventId, venue_name: null });
    const thread = await SELF.fetch(`https://tsudoi.test/api/participant/events/${eventId}/message-thread`, { method: "POST", headers: participantHeaders });
    expect(thread.status).toBe(201);
    const { id: threadId } = await thread.json<{ id: string }>();
    const participantMessage = await SELF.fetch(`https://tsudoi.test/api/participant/messages/${threadId}`, { method: "POST", headers: participantHeaders, body: JSON.stringify({ ciphertext: "AQID", algorithm: "XChaCha20", keyGeneration: 1 }) });
    expect(participantMessage.status).toBe(201);
    const organizerMessage = await SELF.fetch(`https://tsudoi.test/api/messages/${threadId}`, { method: "POST", headers: auth, body: JSON.stringify({ ciphertext: "BAUG", algorithm: "XChaCha20", keyGeneration: 1 }) });
    expect(organizerMessage.status).toBe(201);
    const envelope = await SELF.fetch(`https://tsudoi.test/api/participant/messages/${threadId}/key-envelopes`, { method: "POST", headers: participantHeaders, body: JSON.stringify({ recipientKeyId: "ada-key", encryptedKey: "BwgJ", algorithm: "X25519" }) });
    expect(envelope.status).toBe(201);
    const envelopes = await SELF.fetch(`https://tsudoi.test/api/messages/${threadId}/key-envelopes?recipientKeyId=ada-key`, { headers: { authorization: `Bearer ${token}` } });
    await expect(envelopes.json()).resolves.toEqual([expect.objectContaining({ recipient_key_id: "ada-key", encrypted_key: "BwgJ" })]);
    const messages = await SELF.fetch(`https://tsudoi.test/api/participant/messages/${threadId}`, { headers: participantHeaders });
    await expect(messages.json()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ sender_kind: "attendee", ciphertext: "AQID" }), expect.objectContaining({ sender_kind: "organizer", ciphertext: "BAUG" })]));

    const checkIn = await SELF.fetch(`https://tsudoi.test/api/tickets/${ticketId}/check-in`, { method: "POST", headers: auth, body: JSON.stringify({ ticketToken }) });
    await expect(checkIn.json()).resolves.toMatchObject({ outcome: "accepted", ticket: { id: ticketId, status: "checked_in" } });
    const duplicate = await SELF.fetch(`https://tsudoi.test/api/tickets/${ticketId}/check-in`, { method: "POST", headers: auth, body: JSON.stringify({ ticketToken }) });
    await expect(duplicate.json()).resolves.toMatchObject({ outcome: "duplicate" });
    const metrics = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/metrics`, { headers: { authorization: `Bearer ${token}` } });
    await expect(metrics.json()).resolves.toMatchObject({ registrations: 1, checked_in: 1 });
    const csv = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/attendees.csv`, { headers: { authorization: `Bearer ${token}` } });
    expect(await csv.text()).toContain("Diet");
  });

  it("allows an authenticated participant to manage a push subscription and cancel before check-in", async () => {
    const { organizationId, token } = await createApiOrganization("Participant lifecycle");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const created = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Participant event", startsAt: "2026-12-11T09:00:00Z", registrationMode: "hybrid" }) });
    const { id: eventId } = await created.json<{ id: string }>();
    await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/publish`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const registration = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Grace" }) });
    const { attendeeId } = await registration.json<{ attendeeId: string }>();
    const participantToken = await createParticipantSession(attendeeId);
    const headers = { "content-type": "application/json", cookie: `tsudoi_participant=${participantToken}` };
    const endpoint = "https://push.example.test/subscription";
    const subscribe = await SELF.fetch("https://tsudoi.test/api/participant/push-subscriptions", { method: "POST", headers, body: JSON.stringify({ endpoint, keys: { p256dh: "public-key", auth: "auth-key" } }) });
    expect(subscribe.status).toBe(201);
    const unsubscribe = await SELF.fetch("https://tsudoi.test/api/participant/push-subscriptions", { method: "DELETE", headers, body: JSON.stringify({ endpoint }) });
    expect(unsubscribe.status).toBe(204);
    const cancel = await SELF.fetch("https://tsudoi.test/api/participant/ticket/cancel", { method: "POST", headers });
    await expect(cancel.json()).resolves.toEqual({ cancelled: true });
    const logout = await SELF.fetch("https://tsudoi.test/api/participant/logout", { method: "POST", headers });
    expect(logout.status).toBe(204);
  });

  it("opens a ticket magic link and exposes only the ticket owner's passkey flows", async () => {
    const { organizationId, token } = await createApiOrganization("Ticket access");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const created = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Ticket access event", startsAt: "2026-12-12T09:00:00Z", registrationMode: "hybrid" }) });
    const { id: eventId } = await created.json<{ id: string }>();
    await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/publish`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const registration = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Lin", email: "lin@example.test" }) });
    const { attendeeId, ticketId, ticketToken } = await registration.json<{ attendeeId: string; ticketId: string; ticketToken: string }>();
    const magicToken = `magic_${crypto.randomUUID()}`;
    const magicHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(magicToken)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare("INSERT INTO magic_links (id, attendee_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, 'ticket', datetime('now', '+1 hour'))")
      .bind(crypto.randomUUID(), attendeeId, magicHash).run();
    const magic = await SELF.fetch(`https://tsudoi.test/public/magic-links/${magicToken}`, { redirect: "manual" });
    expect(magic.status).toBe(302);
    expect(magic.headers.get("set-cookie")).toContain("tsudoi_participant=");

    const passkeyOptions = await SELF.fetch(`https://tsudoi.test/public/tickets/${ticketId}/passkeys/options`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticketToken }) });
    expect(passkeyOptions.status).toBe(200);
    const { challengeId } = await passkeyOptions.json<{ challengeId: string }>();
    await expect(env.DB.prepare("SELECT purpose FROM webauthn_challenges WHERE id = ?").bind(challengeId).first()).resolves.toEqual({ purpose: "registration" });
    expect((await SELF.fetch(`https://tsudoi.test/public/attendees/${attendeeId}/passkeys/authentication/options`, { method: "POST" })).status).toBe(404);
    await env.DB.prepare("INSERT INTO passkeys (id, attendee_id, credential_id, public_key, counter, transports_json, prf_capable) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), attendeeId, "credential-test", new Uint8Array([1, 2, 3]), 0, JSON.stringify(["internal"]), 0).run();
    const authenticationOptions = await SELF.fetch(`https://tsudoi.test/public/attendees/${attendeeId}/passkeys/authentication/options`, { method: "POST" });
    expect(authenticationOptions.status).toBe(200);
    const invalidAuthentication = await SELF.fetch(`https://tsudoi.test/public/attendees/${attendeeId}/passkeys/authentication/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: "missing", response: {} }) });
    expect(invalidAuthentication.status).toBe(400);
  });

  it("lists, publishes, displays, and closes an event while preserving session boundaries", async () => {
    const { organizationId, token } = await createApiOrganization("Event operations");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const created = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Public operations", startsAt: "2026-12-13T09:00:00Z", registrationMode: "hybrid" }) });
    const { id: eventId } = await created.json<{ id: string }>();
    const list = await SELF.fetch("https://tsudoi.test/api/events", { headers: { authorization: `Bearer ${token}` } });
    await expect(list.json()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: eventId })]));
    const fields = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/form-fields`, { headers: { authorization: `Bearer ${token}` } });
    await expect(fields.json()).resolves.toEqual([]);
    const publish = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/publish`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    await expect(publish.json()).resolves.toEqual({ id: eventId, status: "published" });
    const publicEvent = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}`);
    await expect(publicEvent.json()).resolves.toMatchObject({ event: { id: eventId, name: "Public operations" }, fields: [] });
    const close = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/close`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    await expect(close.json()).resolves.toEqual({ id: eventId, status: "closed" });

    const { sessionToken } = await createOrganizerSession("Logout organization");
    const logout = await SELF.fetch("https://tsudoi.test/api/session/logout", { method: "POST", headers: { cookie: `tsudoi_organizer=${sessionToken}` } });
    expect(logout.status).toBe(204);
    expect((await SELF.fetch("https://tsudoi.test/api/session", { headers: { cookie: `tsudoi_organizer=${sessionToken}` } })).status).toBe(401);
  });
});
