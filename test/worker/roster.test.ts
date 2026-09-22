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
  return sessionToken;
}

describe("Worker D1 roster flow", () => {
  it("uses an HttpOnly organizer session without a bearer token", async () => {
    const sessionToken = await createOrganizerSession("Session organization");
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
});
