import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { app } from "../../src/index";

const origin = "https://tsudoi.test";
async function session(organizationId = crypto.randomUUID(), role = "owner") {
  const userId = crypto.randomUUID(), token = crypto.randomUUID();
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO organizations (id, name) VALUES (?, 'Roster workflows')").bind(organizationId),
    env.DB.prepare("INSERT INTO users (id, display_name) VALUES (?, 'Organizer')").bind(userId),
    env.DB.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)").bind(organizationId, userId, role),
    env.DB.prepare("INSERT INTO organizer_sessions (id, user_id, organization_id, token_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+12 hours'))").bind(crypto.randomUUID(), userId, organizationId, hash),
  ]);
  return { organizationId, userId, headers: { cookie: `tsudoi_organizer=${token}`, "content-type": "application/json" } };
}
async function event(owner: Awaited<ReturnType<typeof session>>) {
  const response = await SELF.fetch(`${origin}/api/events`, { method: "POST", headers: owner.headers, body: JSON.stringify({ name: "Roster", startsAt: "2026-12-10", registrationMode: "hybrid" }) });
  expect(response.status).toBe(201);
  return (await response.json<{ id: string }>()).id;
}
async function field(eventId: string, headers: Record<string, string>, key = "category", type = "single_select") {
  const response = await SELF.fetch(`${origin}/api/events/${eventId}/form-fields`, { method: "POST", headers, body: JSON.stringify({ key, label: key, type, options: ["A", "B"] }) });
  expect(response.status).toBe(201);
  return (await response.json<{ id: string }>()).id;
}
async function attendee(eventId: string, organizationId: string, name = "Guest", email: string | null = null) {
  const id = crypto.randomUUID(), ticketId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO attendees (id, organization_id, event_id, name, email_normalized, affiliation, registration_source) VALUES (?, ?, ?, ?, ?, 'Original', 'admin')").bind(id, organizationId, eventId, name, email),
    env.DB.prepare("INSERT INTO tickets (id, attendee_id, event_id, token_hash, token_key_id) VALUES (?, ?, ?, ?, 'possession-v2')").bind(ticketId, id, eventId, crypto.randomUUID()),
  ]);
  return { id, ticketId, revision: 0 };
}
const request = (path: string, headers: Record<string, string>, body: unknown, method = "POST") => SELF.fetch(`${origin}/api${path}`, { method, headers, body: JSON.stringify(body) });

describe("roster management workflows", () => {
  it("edits and retires stable fields, preserves answers, and rejects used-choice deletion and stale revisions", async () => {
    const owner = await session(), eventId = await event(owner), fieldId = await field(eventId, owner.headers), person = await attendee(eventId, owner.organizationId);
    await env.DB.prepare("INSERT INTO attendee_answers (attendee_id, field_id, value_json) VALUES (?, ?, '\"A\"')").bind(person.id, fieldId).run();
    const path = `/events/${eventId}/form-fields/${fieldId}`;
    expect((await request(path, owner.headers, { revision: 0, label: "区分", required: true, sortOrder: 3 }, "PATCH")).status).toBe(200);
    expect((await request(path, owner.headers, { revision: 0, label: "Stale" }, "PATCH")).status).toBe(409);
    expect((await request(path, owner.headers, { revision: 1, options: ["B"] }, "PATCH")).status).toBe(409);
    expect((await request(path, owner.headers, { revision: 1, retired: true }, "PATCH")).status).toBe(200);
    const active = await SELF.fetch(`${origin}/api/events/${eventId}/form-fields`, { headers: owner.headers });
    expect(await active.json()).toEqual([]);
    const roster = await SELF.fetch(`${origin}/api/events/${eventId}/roster`, { headers: owner.headers });
    expect(await roster.json()).toMatchObject({ fields: [{ field_key: "category", label: "区分", retired_at: expect.any(String) }], attendees: [{ answers: { category: "A" } }] });
    const csv = await SELF.fetch(`${origin}/api/events/${eventId}/attendees.csv`, { headers: owner.headers });
    expect(await csv.text()).toContain("A");
    expect((await request(path, owner.headers, { revision: 2, retired: false }, "PATCH")).status).toBe(200);
    const audit = await env.DB.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'form_field.updated' AND target_id = ? ORDER BY rowid LIMIT 1").bind(fieldId).first<{ metadata_json: string }>();
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({ before: { label: "category", revision: 0 }, after: { label: "区分", revision: 1 } });
  });

  it("atomically handles simultaneous field changes and audit failures", async () => {
    const owner = await session(), eventId = await event(owner), fieldId = await field(eventId, owner.headers);
    const path = `/events/${eventId}/form-fields/${fieldId}`;
    const results = await Promise.all([request(path, owner.headers, { revision: 0, label: "First" }, "PATCH"), request(path, owner.headers, { revision: 0, label: "Second" }, "PATCH")]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    await env.DB.exec("CREATE TRIGGER fail_field_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'form_field.updated' BEGIN SELECT RAISE(ABORT, 'audit_unavailable'); END;");
    try { expect((await request(path, owner.headers, { revision: 1, retired: true }, "PATCH")).status).toBe(500); }
    finally { await env.DB.exec("DROP TRIGGER fail_field_audit"); }
    expect(await env.DB.prepare("SELECT revision, retired_at FROM form_fields WHERE id = ?").bind(fieldId).first()).toEqual({ revision: 1, retired_at: null });
  });

  it("isolates saved column layouts by organizer and detects stale saves", async () => {
    const owner = await session(), eventId = await event(owner), other = await session(owner.organizationId, "viewer"), foreign = await session();
    const path = `/events/${eventId}/roster/view`;
    expect((await request(path, owner.headers, { columns: ["email", "name"], revision: 0 }, "PUT")).status).toBe(200);
    expect((await request(path, owner.headers, { columns: ["name"], revision: 0 }, "PUT")).status).toBe(409);
    expect((await request(path, owner.headers, { columns: ["name"], revision: 1 }, "PUT")).status).toBe(200);
    expect(await (await SELF.fetch(`${origin}/api${path}`, { headers: other.headers })).json()).toMatchObject({ columns: null, revision: 0 });
    expect((await SELF.fetch(`${origin}/api${path}`, { headers: foreign.headers })).status).toBe(404);
    expect((await request(path, owner.headers, { columns: ["name", "answer:unknown"], revision: 2 }, "PUT")).status).toBe(400);
  });

  it("enforces administrator-only field/template mutations and removes newly hidden fields from staff layouts", async () => {
    const owner = await session(), eventId = await event(owner), fieldId = await field(eventId, owner.headers);
    const staff = await session(owner.organizationId, "staff"), viewer = await session(owner.organizationId, "viewer"), foreign = await session();
    const venueId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO venues (id, event_id, name) VALUES (?, ?, 'Staff venue')").bind(venueId, eventId),
      env.DB.prepare("INSERT INTO venue_staff_assignments (venue_id, user_id) VALUES (?, ?)").bind(venueId, staff.userId),
    ]);
    const fieldPath = `/events/${eventId}/form-fields/${fieldId}`;
    for (const member of [staff, viewer]) {
      expect((await request(fieldPath, member.headers, { revision: 0, retired: true }, "PATCH")).status).toBe(403);
      expect((await request(`/events/${eventId}/form-templates`, member.headers, { name: "Forbidden" })).status).toBe(403);
    }
    expect((await request(fieldPath, foreign.headers, { revision: 0, retired: true }, "PATCH")).status).toBe(404);
    const viewPath = `/events/${eventId}/roster/view`;
    expect((await request(viewPath, staff.headers, { columns: ["name", "answer:category"], revision: 0 }, "PUT")).status).toBe(200);
    expect((await request(fieldPath, owner.headers, { revision: 0, staffVisibility: "admin_only" }, "PATCH")).status).toBe(200);
    expect(await (await SELF.fetch(`${origin}/api${viewPath}`, { headers: staff.headers })).json()).toMatchObject({ columns: ["name"] });
    expect((await request(viewPath, staff.headers, { columns: ["name", "answer:category"], revision: 1 }, "PUT")).status).toBe(400);
    expect(await (await SELF.fetch(`${origin}/api/events/${eventId}/form-fields`, { headers: viewer.headers })).json()).toEqual([]);
    expect(await (await SELF.fetch(`${origin}/api/events/${eventId}/roster`, { headers: viewer.headers })).json()).toMatchObject({ fields: [] });
  });

  it("exports all matching pages, in requested column order, with safe cells and audit metadata", async () => {
    const owner = await session(), eventId = await event(owner), viewer = await session(owner.organizationId, "viewer");
    for (let i = 0; i < 52; i++) await attendee(eventId, owner.organizationId, i === 0 ? "=formula" : `Guest ${i}`);
    const issued = await attendee(eventId, owner.organizationId, "Exclude");
    await env.DB.prepare("UPDATE tickets SET status = 'checked_in' WHERE id = ?").bind(issued.ticketId).run();
    const path = `/events/${eventId}/attendees.csv?ticketStatus=issued&column=affiliation&column=name&column=ticket`;
    const response = await SELF.fetch(`${origin}/api${path}`, { headers: owner.headers });
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(csv.split("\r\n")).toHaveLength(54);
    expect(csv).toContain('"Affiliation","Name","Ticket"'); expect(csv).toContain("'=formula"); expect(csv).not.toContain("Exclude");
    expect((await SELF.fetch(`${origin}/api${path}`, { headers: viewer.headers })).status).toBe(403);
    const audit = await env.DB.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'attendees.exported' AND target_id = ?").bind(eventId).first<{ metadata_json: string }>();
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({ columns: ["affiliation", "name", "ticket"], count: 52 });
  });

  it("exports a displayed layout wider than the CSV import limit and still rejects invalid columns", async () => {
    const owner = await session(), eventId = await event(owner), person = await attendee(eventId, owner.organizationId);
    const fields = Array.from({ length: 103 }, (_, index) => ({ id: crypto.randomUUID(), key: `field_${index}`, label: `Field ${index}` }));
    await env.DB.batch(fields.map((field, index) => env.DB.prepare("INSERT INTO form_fields (id, event_id, field_key, label, field_type, sort_order) VALUES (?, ?, ?, ?, 'text', ?)")
      .bind(field.id, eventId, field.key, field.label, index)));
    await env.DB.prepare("INSERT INTO attendee_answers (attendee_id, field_id, value_json) VALUES (?, ?, '\"Last answer\"')").bind(person.id, fields.at(-1)!.id).run();
    const columns = ["name", "affiliation", "email", "venue", "ticket", ...fields.map((field) => `answer:${field.key}`)];
    const path = `/api/events/${eventId}/attendees.csv`;
    const params = new URLSearchParams(columns.map((column) => ["column", column]));
    const response = await SELF.fetch(`${origin}${path}?${params}`, { headers: owner.headers });
    expect(response.status).toBe(200);
    const lines = (await response.text()).replace(/^\uFEFF/, "").trimEnd().split("\r\n");
    expect(lines[0].split(",")).toEqual(["Name", "Affiliation", "Email", "Venue", "Ticket", ...fields.map((field) => field.label)].map((value) => `"${value}"`));
    expect(lines[1].split(",")).toHaveLength(108);
    expect(lines[1]).toMatch(/,"Last answer"$/);
    for (const extra of ["name", "answer:unknown"]) {
      const invalid = new URLSearchParams(params); invalid.append("column", extra);
      expect((await SELF.fetch(`${origin}${path}?${invalid}`, { headers: owner.headers })).status).toBe(400);
    }
  });

  it("reuses organization templates with new IDs and no attendee information; key collisions roll back", async () => {
    const owner = await session(), source = await event(owner), destination = await event(owner), foreign = await session();
    const fieldId = await field(source, owner.headers); await attendee(source, owner.organizationId, "Private name");
    const saved = await request(`/events/${source}/form-templates`, owner.headers, { name: "標準項目" });
    expect(saved.status).toBe(201); const { id } = await saved.json<{ id: string }>();
    expect(await (await SELF.fetch(`${origin}/api/form-templates`, { headers: foreign.headers })).json()).toEqual({ templates: [] });
    expect((await request(`/events/${destination}/form-templates/${id}/apply`, foreign.headers, {})).status).toBe(404);
    expect((await request(`/events/${destination}/form-templates/${id}/apply`, owner.headers, {})).status).toBe(201);
    const newField = await env.DB.prepare("SELECT id, field_key FROM form_fields WHERE event_id = ?").bind(destination).first<{ id: string; field_key: string }>();
    expect(newField?.id).not.toBe(fieldId); expect(newField?.field_key).toBe("category");
    expect((await request(`/events/${destination}/form-templates/${id}/apply`, owner.headers, {})).status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM attendees WHERE event_id = ?").bind(destination).first()).toEqual({ n: 0 });
    const stored = await env.DB.prepare("SELECT fields_json FROM form_templates WHERE id = ?").bind(id).first<{ fields_json: string }>();
    expect(stored?.fields_json).not.toContain("Private name");
  });

  it("bulk-updates 100 people atomically with typed answers, per-person audits, and preserved tickets", async () => {
    const owner = await session(), eventId = await event(owner), fieldId = await field(eventId, owner.headers, "count", "number");
    const people = [];
    for (let i = 0; i < 100; i++) people.push(await attendee(eventId, owner.organizationId));
    const path = `/events/${eventId}/roster/bulk-update`;
    const response = await request(path, owner.headers, { attendees: people, patch: { affiliation: "Updated", answers: { count: 0 } } });
    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM attendees WHERE event_id = ? AND affiliation = 'Updated' AND revision = 1").bind(eventId).first()).toEqual({ n: 100 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM attendee_answers WHERE field_id = ? AND value_json = '0'").bind(fieldId).first()).toEqual({ n: 100 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'attendee.bulk_updated' AND organization_id = ?").bind(owner.organizationId).first()).toEqual({ n: 100 });
    expect((await request(path, owner.headers, { attendees: people, patch: { affiliation: "Stale" } })).status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE event_id = ? AND status = 'issued'").bind(eventId).first()).toEqual({ n: 100 });
  });

  it("rejects the entire bulk update for any stale, cross-event, checked-in venue, or unauthorized row", async () => {
    const owner = await session(), eventId = await event(owner), another = await event(owner), viewer = await session(owner.organizationId, "viewer"), foreign = await session();
    const first = await attendee(eventId, owner.organizationId), second = await attendee(eventId, owner.organizationId), outsider = await attendee(another, owner.organizationId);
    const path = `/events/${eventId}/roster/bulk-update`, patch = { affiliation: "Must not save" };
    expect((await request(path, owner.headers, { attendees: [first, outsider], patch })).status).toBe(409);
    expect((await request(path, viewer.headers, { attendees: [first], patch })).status).toBe(403);
    expect((await request(path, foreign.headers, { attendees: [first], patch })).status).toBe(404);
    await env.DB.prepare("UPDATE tickets SET status = 'checked_in' WHERE id = ?").bind(second.ticketId).run();
    const venueId = crypto.randomUUID(); await env.DB.prepare("INSERT INTO venues (id, event_id, name) VALUES (?, ?, 'New venue')").bind(venueId, eventId).run();
    expect((await request(path, owner.headers, { attendees: [first, second], patch: { ...patch, venueId } })).status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM attendees WHERE event_id = ? AND revision = 0 AND affiliation = 'Original'").bind(eventId).first()).toEqual({ n: 2 });
  });

  it("rolls back bulk updates on audit failure and allows only one concurrent revision to commit", async () => {
    const owner = await session(), eventId = await event(owner), person = await attendee(eventId, owner.organizationId);
    const path = `/events/${eventId}/roster/bulk-update`, payload = { attendees: [person], patch: { affiliation: "Changed" } };
    await env.DB.exec("CREATE TRIGGER fail_bulk_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'attendee.bulk_updated' BEGIN SELECT RAISE(ABORT, 'audit_unavailable'); END;");
    try { expect((await request(path, owner.headers, payload)).status).toBe(500); }
    finally { await env.DB.exec("DROP TRIGGER fail_bulk_audit"); }
    expect(await env.DB.prepare("SELECT affiliation, revision FROM attendees WHERE id = ?").bind(person.id).first()).toEqual({ affiliation: "Original", revision: 0 });
    const outcomes = await Promise.all([request(path, owner.headers, payload), request(path, owner.headers, payload)]);
    expect(outcomes.map((response) => response.status).sort()).toEqual([200, 409]);
    const logs = await env.DB.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'attendee.bulk_updated' AND target_id = ?").bind(person.id).all<{ metadata_json: string }>();
    expect(logs.results).toHaveLength(1);
    expect(JSON.parse(logs.results[0].metadata_json)).toMatchObject({ before: { affiliation: "Original", revision: 0 }, after: { affiliation: "Changed", revision: 1 } });
  });

  it("previews and queues announcements without scheduling and deduplicates active email recipients", async () => {
    const owner = await session(), eventId = await event(owner);
    await attendee(eventId, owner.organizationId, "First", "same@example.test"); await attendee(eventId, owner.organizationId, "Second", "same@example.test");
    const cancelled = await attendee(eventId, owner.organizationId, "Cancelled", "cancelled@example.test");
    await env.DB.prepare("UPDATE attendees SET status = 'cancelled' WHERE id = ?").bind(cancelled.id).run();
    const send = vi.fn().mockResolvedValue(undefined);
    const queue = new Proxy(env.NOTIFICATION_QUEUE, { get(target, key, receiver) { return key === "send" ? send : Reflect.get(target, key, receiver); } });
    const fetchAnnouncement = (preview: boolean) => app.fetch(new Request(`${origin}/api/events/${eventId}/announcements`, { method: "POST", headers: owner.headers, body: JSON.stringify({ subject: "集合場所", message: "会場へお越しください", preview }) }), { ...env, NOTIFICATION_QUEUE: queue });
    expect(await (await fetchAnnouncement(true)).json()).toEqual({ recipients: 1 }); expect(send).not.toHaveBeenCalled();
    expect((await fetchAnnouncement(false)).status).toBe(202); expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "same@example.test", subject: "集合場所" }));
  });
});
