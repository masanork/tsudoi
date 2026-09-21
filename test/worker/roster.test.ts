import { SELF } from "cloudflare:test";
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
});
