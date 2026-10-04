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

    const optionResponse = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/schedule/options`, { method: "POST", headers: auth, body: JSON.stringify({ date: "2026-11-01" }) });
    expect(optionResponse.status).toBe(201);
    const { id: optionId } = await optionResponse.json<{ id: string }>();
    const publicSchedule = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/schedule`);
    expect(publicSchedule.status).toBe(200);
    await expect(publicSchedule.json()).resolves.toMatchObject({ event: { name: "Date poll", schedule_status: "collecting" }, options: [{ id: optionId }] });

    const response = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/schedule/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ optionId, respondentId: "respondent-1", respondentName: "Ada Lovelace", response: "yes" }) });
    expect(response.status).toBe(201);
    const confirm = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/schedule/confirm`, { method: "POST", headers: auth, body: JSON.stringify({ optionId }) });
    expect(confirm.status).toBe(200);
    await expect(env.DB.prepare("SELECT starts_at, ends_at, schedule_status FROM events WHERE id = ?").bind(eventId).first()).resolves.toMatchObject({ starts_at: "2026-11-01", ends_at: "2026-11-01", schedule_status: "confirmed" });
  });

  it("creates a date-only schedule poll with its initial options", async () => {
    const { organizationId, token } = await createApiOrganization("Initial schedule options");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const eventResponse = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Date poll", schedulingEnabled: true, registrationMode: "hybrid", initialScheduleOptions: [{ date: "2026-11-01", note: "会議室 A" }, { date: "2026-11-02" }] }) });
    expect(eventResponse.status).toBe(201);
    const { id: eventId } = await eventResponse.json<{ id: string }>();
    const schedule = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/schedule`);
    await expect(schedule.json()).resolves.toMatchObject({ options: [{ date: "2026-11-01", note: "会議室 A" }, { date: "2026-11-02" }] });
  });

  it("allows a fixed-date event to use a date without a time", async () => {
    const { organizationId, token } = await createApiOrganization("Start time only");
    const response = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "Short event", startsAt: "2026-11-01", registrationMode: "hybrid" }) });
    expect(response.status).toBe(201);
    const { id } = await response.json<{ id: string }>();
    await expect(env.DB.prepare("SELECT starts_at, ends_at FROM events WHERE id = ?").bind(id).first()).resolves.toEqual({ starts_at: "2026-11-01", ends_at: "2026-11-01" });
  });

  it("lets a participant agent read and answer only its linked schedule", async () => {
    const { organizationId, token } = await createApiOrganization("Agent scheduling");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const created = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Agent poll", schedulingEnabled: true, registrationMode: "hybrid", initialScheduleOptions: [{ date: "2026-11-01" }] }) });
    const { id: eventId } = await created.json<{ id: string }>();
    const options = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/schedule`);
    const { options: [option] } = await options.json<{ options: Array<{ id: string }> }>();
    const connection = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/schedule/agent-connections`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ respondentId: "agent-owner", respondentName: "Ada" }) });
    expect(connection.status).toBe(201);
    const { token: agentToken } = await connection.json<{ token: string }>();
    const mcpHeaders = { "content-type": "application/json", authorization: `Bearer ${agentToken}` };
    const initialize = await SELF.fetch("https://tsudoi.test/mcp", { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } }) });
    await expect(initialize.json()).resolves.toMatchObject({ result: { protocolVersion: "2025-06-18", serverInfo: { name: "tsudoi-scheduling" } } });
    const tools = await SELF.fetch("https://tsudoi.test/mcp", { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    await expect(tools.json()).resolves.toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: "submit_schedule_availability" })]) } });
    const answer = await SELF.fetch("https://tsudoi.test/mcp", { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submit_schedule_availability", arguments: { optionId: option.id, response: "yes" } } }) });
    await expect(answer.json()).resolves.toMatchObject({ result: { content: [{ type: "text" }] } });
    await expect(env.DB.prepare("SELECT respondent_id, response FROM schedule_responses WHERE option_id = ?").bind(option.id).first()).resolves.toEqual({ respondent_id: "agent-owner", response: "yes" });
    const preferences = await SELF.fetch("https://tsudoi.test/mcp", { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "update_scheduling_preferences", arguments: { availabilityText: "Weekday evenings preferred", constraints: { maxDurationMinutes: 90, unavailableWeekdays: ["monday"] } } } }) });
    await expect(preferences.json()).resolves.toMatchObject({ result: { content: [{ type: "text" }] } });
    await expect(env.DB.prepare("SELECT availability_text, constraints_json FROM scheduling_preferences WHERE event_id = ? AND respondent_id = ?").bind(eventId, "agent-owner").first<{ availability_text: string; constraints_json: string }>()).resolves.toMatchObject({ availability_text: "Weekday evenings preferred", constraints_json: expect.stringContaining("durationMinutes") });
    const savedPreferences = await SELF.fetch("https://tsudoi.test/mcp", { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_scheduling_preferences", arguments: {} } }) });
    await expect(savedPreferences.json()).resolves.toMatchObject({ result: { content: [{ text: expect.stringContaining("Weekday evenings preferred") }] } });
    const scheduleStatus = await SELF.fetch("https://tsudoi.test/mcp", { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_schedule_status", arguments: {} } }) });
    await expect(scheduleStatus.json()).resolves.toMatchObject({ result: { content: [{ text: expect.stringContaining("collecting") }] } });
  });

  it("revokes an agent connection and closes agent writes once a schedule is confirmed", async () => {
    const { organizationId, token } = await createApiOrganization("Agent revocation");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const created = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Revocable poll", schedulingEnabled: true, registrationMode: "hybrid", initialScheduleOptions: [{ date: "2026-12-01" }] }) });
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
    const profile = await SELF.fetch("https://tsudoi.test/api/profile", { headers });
    await expect(profile.json()).resolves.toMatchObject({ display_name: "Owner" });
    const updatedProfile = await SELF.fetch("https://tsudoi.test/api/profile", { method: "PATCH", headers, body: JSON.stringify({ displayName: "Updated owner", email: "owner@example.test" }) });
    expect(updatedProfile.status).toBe(200);
    const members = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/members`, { headers });
    await expect(members.json()).resolves.toMatchObject({ members: [{ id: userId, display_name: "Updated owner" }] });
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
    const { attendeeId, ticketId, qrToken: ticketToken } = await registration.json<{ attendeeId: string; ticketId: string; qrToken: string }>();
    const announcement = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/announcements`, { method: "POST", headers: auth, body: JSON.stringify({ subject: "Welcome", message: "Please check your event details." }) });
    await expect(announcement.json()).resolves.toEqual({ queued: 1 });
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
    const ciphertextBytes = new Uint8Array([3, 8, 13, 21]);
    const attachment = await SELF.fetch(`https://tsudoi.test/api/participant/messages/${threadId}/attachments`, { method: "PUT", headers: { cookie: `tsudoi_participant=${participantToken}`, "content-type": "application/octet-stream" }, body: ciphertextBytes });
    expect(attachment.status).toBe(201);
    const { id: attachmentId } = await attachment.json<{ id: string }>();
    const downloaded = await SELF.fetch(`https://tsudoi.test/api/messages/${threadId}/attachments/${attachmentId}`, { headers: auth });
    expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(ciphertextBytes);
    const foreign = await createApiOrganization("Foreign attachment reader");
    expect((await SELF.fetch(`https://tsudoi.test/api/messages/${threadId}/attachments/${attachmentId}`, { headers: { authorization: `Bearer ${foreign.token}` } })).status).toBe(404);

    const checkIn = await SELF.fetch(`https://tsudoi.test/api/tickets/${ticketId}/check-in`, { method: "POST", headers: auth, body: JSON.stringify({ ticketToken }) });
    await expect(checkIn.json()).resolves.toMatchObject({ outcome: "accepted", ticket: { id: ticketId, status: "checked_in" } });
    const duplicate = await SELF.fetch(`https://tsudoi.test/api/tickets/${ticketId}/check-in`, { method: "POST", headers: auth, body: JSON.stringify({ ticketToken }) });
    await expect(duplicate.json()).resolves.toMatchObject({ outcome: "duplicate" });
    const metrics = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/metrics`, { headers: { authorization: `Bearer ${token}` } });
    await expect(metrics.json()).resolves.toMatchObject({ registrations: 1, checked_in: 1 });
    const csv = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/attendees.csv`, { headers: { authorization: `Bearer ${token}` } });
    expect(await csv.text()).toContain("Diet");
  });

  it("issues a separate QR for a participant session and rejects a QR from another ticket", async () => {
    const { organizationId, token } = await createApiOrganization("QR separation");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const created = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "QR event", startsAt: "2026-12-10", registrationMode: "hybrid" }) });
    const { id: eventId } = await created.json<{ id: string }>();
    await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/publish`, { method: "POST", headers: auth });
    const first = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/register`, { method: "POST", headers: auth, body: JSON.stringify({ name: "First", email: "first@example.test" }) });
    const { attendeeId, ticketId } = await first.json<{ attendeeId: string; ticketId: string }>();
    const second = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/register`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Second" }) });
    const { ticketId: otherTicketId } = await second.json<{ ticketId: string }>();
    const session = await createParticipantSession(attendeeId);
    const qr = await SELF.fetch("https://tsudoi.test/api/participant/ticket/qr", { method: "POST", headers: { cookie: `tsudoi_participant=${session}` } });
    expect(qr.status).toBe(200);
    const { url } = await qr.json<{ url: string }>();
    const qrToken = url.split("/").at(-1)!;
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM ticket_qr_tokens WHERE ticket_id = ?").bind(ticketId).first<{ count: number }>())?.count).toBeGreaterThanOrEqual(2);
    const wrongTicket = await SELF.fetch(`https://tsudoi.test/api/tickets/${otherTicketId}/check-in`, { method: "POST", headers: auth, body: JSON.stringify({ ticketToken: qrToken }) });
    expect(wrongTicket.status).toBe(403);
    const accepted = await SELF.fetch(`https://tsudoi.test/api/tickets/${ticketId}/check-in`, { method: "POST", headers: auth, body: JSON.stringify({ ticketToken: qrToken }) });
    await expect(accepted.json()).resolves.toMatchObject({ outcome: "accepted" });
    expect((await SELF.fetch("https://tsudoi.test/api/participant/ticket/qr", { method: "POST", headers: { cookie: `tsudoi_participant=${session}` } })).status).toBe(409);
  });

  it("limits repeated public registrations from one IP and creates discoverable Passkey challenges", async () => {
    const eventId = crypto.randomUUID();
    const url = `https://tsudoi.test/public/events/${eventId}/register`;
    const headers = { "content-type": "application/json", "cf-connecting-ip": "192.0.2.72" };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await SELF.fetch(url, { method: "POST", headers, body: JSON.stringify({ name: "Unavailable" }) });
      expect(response.status).toBe(404);
    }
    const limited = await SELF.fetch(url, { method: "POST", headers, body: JSON.stringify({ name: "Unavailable" }) });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("300");
    const options = await SELF.fetch("https://tsudoi.test/public/participant/passkeys/authentication/options", { method: "POST" });
    expect(options.status).toBe(200);
    const { challengeId, options: credentialOptions } = await options.json<{ challengeId: string; options: { challenge: string } }>();
    expect(credentialOptions.challenge).toBeTruthy();
    await expect(env.DB.prepare("SELECT id FROM participant_auth_challenges WHERE id = ?").bind(challengeId).first()).resolves.toEqual({ id: challengeId });
  });

  it("limits staff check-in to an assigned venue in the same event", async () => {
    const { sessionToken, organizationId } = await createOrganizerSession("Venue authorization");
    const owner = { "content-type": "application/json", cookie: `tsudoi_organizer=${sessionToken}` };
    const created = await SELF.fetch("https://tsudoi.test/api/events", { method: "POST", headers: owner, body: JSON.stringify({ name: "Venue event", startsAt: "2026-12-10", registrationMode: "hybrid" }) });
    const { id: eventId } = await created.json<{ id: string }>();
    const venueResponse = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/venues`, { method: "POST", headers: owner, body: JSON.stringify({ name: "Main hall" }) });
    const { id: venueId } = await venueResponse.json<{ id: string }>();
    const otherEvent = await SELF.fetch("https://tsudoi.test/api/events", { method: "POST", headers: owner, body: JSON.stringify({ name: "Other event", startsAt: "2026-12-11", registrationMode: "hybrid" }) });
    const { id: otherEventId } = await otherEvent.json<{ id: string }>();
    const otherVenueResponse = await SELF.fetch(`https://tsudoi.test/api/events/${otherEventId}/venues`, { method: "POST", headers: owner, body: JSON.stringify({ name: "Other hall" }) });
    const { id: otherVenueId } = await otherVenueResponse.json<{ id: string }>();
    const attendee = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/attendees`, { method: "POST", headers: owner, body: JSON.stringify({ name: "Guest" }) });
    const { ticketId } = await attendee.json<{ ticketId: string }>();
    const qrToken = "staff_qr_token";
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(qrToken)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare("INSERT INTO ticket_qr_tokens (id, ticket_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))").bind(crypto.randomUUID(), ticketId, hash).run();
    const staffId = crypto.randomUUID();
    const staffSession = `staff_${crypto.randomUUID()}`;
    const staffHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(staffSession)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, display_name) VALUES (?, 'Staff')").bind(staffId),
      env.DB.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'staff')").bind(organizationId, staffId),
      env.DB.prepare("INSERT INTO organizer_sessions (id, user_id, organization_id, token_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+12 hours'))").bind(crypto.randomUUID(), staffId, organizationId, staffHash),
    ]);
    const staff = { "content-type": "application/json", cookie: `tsudoi_organizer=${staffSession}` };
    const request = (venue?: string) => SELF.fetch(`https://tsudoi.test/api/tickets/${ticketId}/check-in`, { method: "POST", headers: staff, body: JSON.stringify({ ticketToken: qrToken, venueId: venue }) });
    await expect((await request()).json()).resolves.toMatchObject({ error: "venue_required" });
    await expect((await request(otherVenueId)).json()).resolves.toMatchObject({ error: "invalid_venue" });
    await expect((await request(venueId)).json()).resolves.toMatchObject({ error: "venue_not_assigned" });
    const assigned = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/venues/${venueId}/staff/${staffId}`, { method: "PUT", headers: owner });
    expect(assigned.status).toBe(200);
    await expect((await request(venueId)).json()).resolves.toMatchObject({ outcome: "accepted" });
  });

  it("lets only an organizer session issue and revoke scoped API tokens", async () => {
    const { sessionToken } = await createOrganizerSession("Token management");
    const headers = { "content-type": "application/json", cookie: `tsudoi_organizer=${sessionToken}` };
    const issued = await SELF.fetch("https://tsudoi.test/api/tokens", { method: "POST", headers, body: JSON.stringify({ label: "Metrics client", scopes: ["roster:read"] }) });
    expect(issued.status).toBe(201);
    const { id, token } = await issued.json<{ id: string; token: string }>();
    expect(token).toMatch(/^tsu_/);
    const listed = await SELF.fetch("https://tsudoi.test/api/tokens", { headers });
    await expect(listed.json()).resolves.toMatchObject({ tokens: [expect.objectContaining({ id, label: "Metrics client", scopes: ["roster:read"] })] });
    expect((await SELF.fetch("https://tsudoi.test/api/tokens", { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    expect((await SELF.fetch("https://tsudoi.test/api/events", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await SELF.fetch("https://tsudoi.test/api/events", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "Denied", startsAt: "2026-12-10", registrationMode: "hybrid" }) })).status).toBe(403);
    expect((await SELF.fetch(`https://tsudoi.test/api/tokens/${id}`, { method: "DELETE", headers })).status).toBe(204);
    expect((await SELF.fetch("https://tsudoi.test/api/events", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("creates an organization invitation with a Passkey challenge", async () => {
    const { sessionToken, organizationId } = await createOrganizerSession("Inviting organization");
    const headers = { "content-type": "application/json", cookie: `tsudoi_organizer=${sessionToken}` };
    const invalid = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/invites`, { method: "POST", headers, body: JSON.stringify({ role: "owner" }) });
    expect(invalid.status).toBe(400);
    const issued = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/invites`, { method: "POST", headers, body: JSON.stringify({ role: "staff", email: "staff@example.test" }) });
    expect(issued.status).toBe(201);
    const { url } = await issued.json<{ url: string }>();
    const token = url.split("/").at(-1)!;
    const publicInfo = await SELF.fetch(`https://tsudoi.test/public/invites/${token}`);
    await expect(publicInfo.json()).resolves.toEqual({ organizationName: "Inviting organization", role: "staff", email: "staff@example.test" });
    const options = await SELF.fetch(`https://tsudoi.test/public/invites/${token}/passkey/options`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "New staff" }) });
    expect(options.status).toBe(200);
    const { challengeId } = await options.json<{ challengeId: string }>();
    await expect(env.DB.prepare("SELECT display_name FROM invite_webauthn_challenges WHERE id = ?").bind(challengeId).first()).resolves.toEqual({ display_name: "New staff" });
    const invalidVerify = await SELF.fetch(`https://tsudoi.test/public/invites/${token}/passkey/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId, response: {} }) });
    expect(invalidVerify.status).toBe(400);
  });

  it("pages the roster and filters by name, status, and registration source", async () => {
    const { organizationId, token } = await createApiOrganization("Roster pagination");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const created = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Large roster", startsAt: "2026-12-10", registrationMode: "hybrid" }) });
    const { id: eventId } = await created.json<{ id: string }>();
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 51; index += 1) {
      const attendeeId = crypto.randomUUID();
      statements.push(env.DB.prepare("INSERT INTO attendees (id, organization_id, event_id, name, registration_source, status) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(attendeeId, organizationId, eventId, index === 0 ? "Search Needle" : `Guest ${index}`, index === 0 ? "walk_in" : "public_form", index === 0 ? "cancelled" : "active"));
      statements.push(env.DB.prepare("INSERT INTO tickets (id, attendee_id, event_id, token_hash, token_key_id, status) VALUES (?, ?, ?, ?, 'v1', ?)")
        .bind(crypto.randomUUID(), attendeeId, eventId, crypto.randomUUID(), index === 0 ? "cancelled" : "issued"));
    }
    await env.DB.batch(statements);
    const first = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/roster`, { headers: auth });
    const firstPage = await first.json<{ attendees: Array<{ id: string }>; nextCursor: string | null }>();
    expect(firstPage.attendees).toHaveLength(50);
    expect(firstPage.nextCursor).toBeTruthy();
    const second = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/roster?after=${firstPage.nextCursor}`, { headers: auth });
    const secondPage = await second.json<{ attendees: Array<{ id: string }>; nextCursor: string | null }>();
    expect(secondPage.attendees).toHaveLength(1);
    expect(new Set([...firstPage.attendees, ...secondPage.attendees].map((attendee) => attendee.id)).size).toBe(51);
    const filtered = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/roster?q=Needle&status=cancelled&source=walk_in`, { headers: auth });
    await expect(filtered.json()).resolves.toMatchObject({ attendees: [{ name: "Search Needle" }], nextCursor: null });
  });

  it("checks in by roster identity and records a reason when an admin reverses it", async () => {
    const { organizationId, token } = await createApiOrganization("Manual check-in");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const created = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Manual event", startsAt: "2026-12-10", registrationMode: "hybrid" }) });
    const { id: eventId } = await created.json<{ id: string }>();
    const attendee = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/attendees`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Walk-in" }) });
    const { attendeeId, ticketId } = await attendee.json<{ attendeeId: string; ticketId: string }>();
    const accepted = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/attendees/${attendeeId}/check-in`, { method: "POST", headers: auth, body: "{}" });
    await expect(accepted.json()).resolves.toMatchObject({ outcome: "accepted", ticket: { id: ticketId } });
    const duplicate = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/attendees/${attendeeId}/check-in`, { method: "POST", headers: auth, body: "{}" });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ outcome: "duplicate" });
    const missingReason = await SELF.fetch(`https://tsudoi.test/api/tickets/${ticketId}/reverse-check-in`, { method: "POST", headers: auth, body: "{}" });
    expect(missingReason.status).toBe(400);
    const reversed = await SELF.fetch(`https://tsudoi.test/api/tickets/${ticketId}/reverse-check-in`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "Wrong participant" }) });
    await expect(reversed.json()).resolves.toEqual({ reversed: true });
    await expect(env.DB.prepare("SELECT status, checked_in_at FROM tickets WHERE id = ?").bind(ticketId).first()).resolves.toEqual({ status: "issued", checked_in_at: null });
    await expect(env.DB.prepare("SELECT reason FROM check_ins WHERE ticket_id = ? AND outcome = 'reversed'").bind(ticketId).first()).resolves.toEqual({ reason: "Wrong participant" });
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
    const metrics = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/metrics`, { headers: auth });
    await expect(metrics.json()).resolves.toMatchObject({ registrations: 0, issued: 0, cancelled: 1, checked_in: 0 });
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

  it("issues ticket links and consumes a check-in link exactly once", async () => {
    const { organizationId, token } = await createApiOrganization("Ticket link operations");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const created = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Ticket link event", startsAt: "2026-12-14T09:00:00Z", registrationMode: "hybrid" }) });
    const { id: eventId } = await created.json<{ id: string }>();
    await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/publish`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const registration = await SELF.fetch(`https://tsudoi.test/public/events/${eventId}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Margaret", email: "margaret@example.test" }) });
    const { attendeeId, ticketId } = await registration.json<{ attendeeId: string; ticketId: string }>();
    const resend = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/attendees/${attendeeId}/ticket-link`, { method: "POST", headers: auth });
    expect(resend.status).toBe(202);
    const linkToken = `checkin_${crypto.randomUUID()}`;
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(linkToken)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare("INSERT INTO magic_links (id, attendee_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, 'ticket', datetime('now', '+1 hour'))")
      .bind(crypto.randomUUID(), attendeeId, hash).run();
    const checkIn = await SELF.fetch("https://tsudoi.test/api/tickets/check-in-link", { method: "POST", headers: auth, body: JSON.stringify({ linkToken }) });
    await expect(checkIn.json()).resolves.toMatchObject({ outcome: "accepted", ticket: { id: ticketId, status: "checked_in" } });
    const duplicate = await SELF.fetch("https://tsudoi.test/api/tickets/check-in-link", { method: "POST", headers: auth, body: JSON.stringify({ linkToken }) });
    expect(duplicate.status).toBe(404);
  });

  it("lets two OAuth-connected agents find a shared time and a confirmed calendar event", async () => {
    const discovery = await SELF.fetch("https://tsudoi.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(discovery.status).toBe(401);
    expect(discovery.headers.get("WWW-Authenticate")).toContain("resource_metadata=\"https://tsudoi.test/.well-known/oauth-protected-resource/mcp\"");
    const metadata = await SELF.fetch("https://tsudoi.test/.well-known/oauth-protected-resource/mcp");
    await expect(metadata.json()).resolves.toMatchObject({ resource: "https://tsudoi.test/mcp", authorization_servers: ["https://tsudoi.test"] });
    const authorizationServer = await SELF.fetch("https://tsudoi.test/.well-known/oauth-authorization-server");
    await expect(authorizationServer.json()).resolves.toMatchObject({ code_challenge_methods_supported: ["S256"], registration_endpoint: "https://tsudoi.test/oauth/register" });
    expect((await SELF.fetch("https://tsudoi.test/mcp")).status).toBe(405);

    const { organizationId, token } = await createApiOrganization("Grok coordination");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const created = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Bot planning", schedulingEnabled: true, registrationMode: "hybrid" }) });
    const { id: eventId } = await created.json<{ id: string }>();
    const invite = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/schedule/invites`, { method: "POST", headers: auth, body: JSON.stringify({ role: "required" }) });
    const { url } = await invite.json<{ url: string }>();
    const ada = await connectSchedulingAgent("Ada");
    const bea = await connectSchedulingAgent("Bea");
    const adaJoined = await schedulingTool(ada.accessToken, "join_poll", { inviteToken: url });
    const beaJoined = await schedulingTool(bea.accessToken, "join_poll", { inviteToken: url });
    expect(adaJoined.value).toMatchObject({ joined: true, eventId, role: "required" });
    expect(beaJoined.value).toMatchObject({ joined: true, role: "required" });
    await schedulingTool(ada.accessToken, "update_scheduling_preferences", { eventId, availabilityText: "Tuesday morning", constraints: { timeZone: "Asia/Tokyo", durationMinutes: 60, windows: [{ start: "2026-11-03T10:00:00+09:00", end: "2026-11-03T13:00:00+09:00" }] } });
    await schedulingTool(bea.accessToken, "update_scheduling_preferences", { eventId, availabilityText: "Tuesday late morning", constraints: { timeZone: "UTC", durationMinutes: 90, windows: [{ start: "2026-11-03T02:00:00Z", end: "2026-11-03T05:00:00Z" }] } });
    const suggestion = await schedulingTool(ada.accessToken, "suggest_slots", { eventId });
    expect(suggestion.value.slots[0]).toEqual({ start: "2026-11-03T02:00:00.000Z", end: "2026-11-03T03:00:00.000Z" });
    const proposed = await schedulingTool(bea.accessToken, "propose_schedule_option", { eventId, start: suggestion.value.slots[0].start, end: suggestion.value.slots[0].end, note: "overlap" });
    const optionId = proposed.value.id as string;
    const adaVote = await schedulingTool(ada.accessToken, "submit_schedule_availability", { eventId, responses: [{ optionId, response: "yes" }] });
    const beaVote = await schedulingTool(bea.accessToken, "submit_schedule_availability", { eventId, responses: [{ optionId, response: "yes" }] });
    expect(adaVote.value.saved).toBe(true);
    expect(beaVote.value.saved).toBe(true);
    const poll = await schedulingTool(ada.accessToken, "get_poll", { eventId });
    expect(poll.value.readyToConfirm).toContain(optionId);
    expect(poll.value.options.find((option: { id: string }) => option.id === optionId).myResponse).toBe("yes");
    expect(poll.value.unanswered).toEqual([]);
    const listed = await schedulingTool(ada.accessToken, "list_my_polls", {});
    expect(listed.value.polls).toEqual([expect.objectContaining({ eventId, name: "Bot planning" })]);
    const confirmed = await SELF.fetch(`https://tsudoi.test/api/events/${eventId}/schedule/confirm`, { method: "POST", headers: auth, body: JSON.stringify({ optionId }) });
    expect(confirmed.status).toBe(200);
    const finalPoll = await schedulingTool(bea.accessToken, "get_schedule_status", { eventId });
    expect(finalPoll.value.calendar.icalendar).toContain("BEGIN:VEVENT");
    expect(finalPoll.value.calendar.icalendar).toContain("DTSTART:20261103T020000Z");
    const changes = await schedulingTool(ada.accessToken, "get_schedule_changes", { eventId, since: 0 });
    expect(changes.value.changes.map((change: { kind: string }) => change.kind)).toContain("confirmed");
    const closed = await schedulingTool(ada.accessToken, "propose_schedule_option", { eventId, date: "2026-11-04" });
    expect(closed.error).toBe(true);
    const refreshed = await SELF.fetch("https://tsudoi.test/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: ada.refreshToken, client_id: ada.clientId, resource: "https://tsudoi.test/mcp" }) });
    const next = await refreshed.json<{ access_token: string }>();
    expect((await schedulingTool(next.access_token, "list_my_polls", {})).value.polls).toHaveLength(1);
    const reused = await SELF.fetch("https://tsudoi.test/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: ada.refreshToken, client_id: ada.clientId }) });
    expect(reused.status).toBe(400);
  });
});

async function connectSchedulingAgent(name: string, scope = "schedule:read schedule:write") {
  const session = await SELF.fetch("https://tsudoi.test/oauth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: name }) });
  const cookie = session.headers.get("set-cookie")?.split(";")[0] ?? "";
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = btoa(String.fromCharCode(...verifierBytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const challengeBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...challengeBytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const registered = await SELF.fetch("https://tsudoi.test/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Grok", redirect_uris: ["https://grok.example/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }) });
  const { client_id: clientId } = await registered.json<{ client_id: string }>();
  const approved = await SELF.fetch("https://tsudoi.test/oauth/authorize", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ response_type: "code", client_id: clientId, redirect_uri: "https://grok.example/callback", code_challenge: challenge, code_challenge_method: "S256", resource: "https://tsudoi.test/mcp", scope, state: crypto.randomUUID(), approve: "yes" }) });
  const { redirect } = await approved.json<{ redirect: string }>();
  const code = new URL(redirect).searchParams.get("code") ?? "";
  const token = await SELF.fetch("https://tsudoi.test/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://grok.example/callback", client_id: clientId, code_verifier: verifier, resource: "https://tsudoi.test/mcp" }) });
  const issued = await token.json<{ access_token: string; refresh_token: string }>();
  return { accessToken: issued.access_token, refreshToken: issued.refresh_token, clientId, code, verifier };
}

describe("OAuth scheduling boundaries", () => {
  it("limits a read-only grant and refuses access to an unjoined poll", async () => {
    const readonly = await connectSchedulingAgent("Read only", "schedule:read");
    expect((await schedulingTool(readonly.accessToken, "list_my_polls", {})).error).toBe(false);
    expect((await schedulingTool(readonly.accessToken, "join_poll", { inviteToken: "a".repeat(32) })).error).toBe(true);
    const organization = await createApiOrganization("Private poll");
    const created = await SELF.fetch("https://tsudoi.test/api/events", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${organization.token}` }, body: JSON.stringify({ name: "Private", schedulingEnabled: true, registrationMode: "hybrid" }) });
    const { id: eventId } = await created.json<{ id: string }>();
    expect((await schedulingTool(readonly.accessToken, "get_poll", { eventId })).error).toBe(true);
  });

  it("refuses reused authorization codes, revoked access tokens, and insecure redirects", async () => {
    const agent = await connectSchedulingAgent("Revoked");
    const reused = await SELF.fetch("https://tsudoi.test/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: agent.code, redirect_uri: "https://grok.example/callback", client_id: agent.clientId, code_verifier: agent.verifier, resource: "https://tsudoi.test/mcp" }) });
    expect(reused.status).toBe(400);
    const revoked = await SELF.fetch("https://tsudoi.test/oauth/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: agent.accessToken }) });
    expect(revoked.status).toBe(200);
    const denied = await SELF.fetch("https://tsudoi.test/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${agent.accessToken}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(denied.status).toBe(401);
    const insecure = await SELF.fetch("https://tsudoi.test/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://example.test/callback"] }) });
    expect(insecure.status).toBe(400);
  });
});

async function schedulingTool(token: string, name: string, args: unknown) {
  const response = await SELF.fetch("https://tsudoi.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const body = await response.json<{ result: { isError?: boolean; content: Array<{ text: string }> } }>();
  const text = body.result.content[0]?.text ?? "";
  return { error: body.result.isError === true, value: body.result.isError ? { text } : JSON.parse(text) as Record<string, any> };
}
