import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Worker D1 roster flow", () => {
  it("creates an event and returns dynamically-added answer columns", async () => {
    const bootstrap = await SELF.fetch("https://tsudoi.test/api/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationName: "Test organization" }) });
    expect(bootstrap.status).toBe(201);
    const { organizationId, token } = await bootstrap.json<{ organizationId: string; token: string }>();
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
    const bootstrap = await SELF.fetch("https://tsudoi.test/api/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationName: "Capacity organization" }) });
    const { organizationId, token } = await bootstrap.json<{ organizationId: string; token: string }>();
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const eventResponse = await SELF.fetch(`https://tsudoi.test/api/organizations/${organizationId}/events`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Limited event", startsAt: "2026-10-02T09:00:00Z", endsAt: "2026-10-02T10:00:00Z", registrationMode: "hybrid", capacity: 1 }) });
    const { id: eventId } = await eventResponse.json<{ id: string }>();
    await env.DB.prepare("UPDATE events SET status = 'published' WHERE id = ?").bind(eventId).run();

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
});
