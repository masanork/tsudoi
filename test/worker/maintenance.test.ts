import { createScheduledController, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { cleanupExpiredImportPreviews } from "../../src/maintenance";

async function createImportFixture(name: string) {
  const organizationId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(organizationId, name),
    env.DB.prepare("INSERT INTO events (id, organization_id, name, starts_at, ends_at, registration_mode) VALUES (?, ?, ?, ?, ?, 'hybrid')")
      .bind(eventId, organizationId, `${name} event`, "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"),
  ]);
  return { organizationId, eventId };
}

async function insertPreview(options: {
  organizationId: string;
  eventId: string;
  actorId?: string;
  expiresAt: string;
  consumedAt?: string | null;
  rowsJson?: string;
}) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO roster_import_previews
    (id, organization_id, event_id, actor_id, rows_json, expires_at, consumed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, options.organizationId, options.eventId, options.actorId ?? "maintenance-test", options.rowsJson ?? "[]", options.expiresAt, options.consumedAt ?? null)
    .run();
  return id;
}

async function previewCount(eventId: string) {
  return (await env.DB.prepare("SELECT COUNT(*) AS total FROM roster_import_previews WHERE event_id = ?").bind(eventId).first<{ total: number }>())!.total;
}

describe("expired roster import preview maintenance", () => {
  it("deletes expired and boundary rows across events while preserving valid or consumed previews and roster data", async () => {
    const first = await createImportFixture("Cleanup organization one");
    const second = await createImportFixture("Cleanup organization two");
    const attendeeId = crypto.randomUUID();
    const ticketId = crypto.randomUUID();
    const ticketHash = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO attendees (id, organization_id, event_id, name, registration_source) VALUES (?, ?, ?, ?, 'admin')")
        .bind(attendeeId, first.organizationId, first.eventId, "Keep roster row"),
      env.DB.prepare("INSERT INTO tickets (id, attendee_id, event_id, token_hash, token_key_id) VALUES (?, ?, ?, ?, 'test')")
        .bind(ticketId, attendeeId, first.eventId, ticketHash),
      env.DB.prepare("INSERT INTO audit_logs (id, organization_id, actor_id, action, target_type, target_id, metadata_json) VALUES (?, ?, NULL, 'maintenance.fixture', 'attendee', ?, '{}')")
        .bind(crypto.randomUUID(), first.organizationId, attendeeId),
    ]);
    const expired = await insertPreview({ ...first, expiresAt: "2000-01-01 00:00:00", rowsJson: '[{"email":"expired@example.test"}]' });
    const boundary = await insertPreview({ ...second, expiresAt: "CURRENT_TIMESTAMP" });
    const future = await insertPreview({ ...first, expiresAt: "2999-01-01 00:00:00" });
    const consumedFuture = await insertPreview({ ...second, expiresAt: "2999-01-01 00:00:00", consumedAt: "2026-10-04 10:00:00" });
    await env.DB.prepare("UPDATE roster_import_previews SET expires_at = CURRENT_TIMESTAMP WHERE id = ?").bind(boundary).run();
    const before = (await env.DB.prepare("SELECT COUNT(*) AS total FROM roster_import_previews WHERE event_id IN (?, ?)")
      .bind(first.eventId, second.eventId).first<{ total: number }>())!.total;
    const beforeRoster = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM attendees WHERE id = ?) AS attendees,
      (SELECT COUNT(*) FROM tickets WHERE id = ?) AS tickets,
      (SELECT COUNT(*) FROM audit_logs WHERE target_id = ?) AS audits`).bind(attendeeId, ticketId, attendeeId).first();

    expect(await cleanupExpiredImportPreviews(env.DB)).toBe(2);
    expect((await env.DB.prepare("SELECT COUNT(*) AS total FROM roster_import_previews WHERE event_id IN (?, ?)")
      .bind(first.eventId, second.eventId).first<{ total: number }>())!.total).toBe(before - 2);
    await expect(env.DB.prepare("SELECT id FROM roster_import_previews WHERE id IN (?, ?)").bind(expired, boundary).all()).resolves.toMatchObject({ results: [] });
    await expect(env.DB.prepare("SELECT rows_json FROM roster_import_previews WHERE id = ?").bind(expired).first()).resolves.toBeNull();
    const preserved = await env.DB.prepare("SELECT id, consumed_at FROM roster_import_previews WHERE id IN (?, ?) ORDER BY id").bind(future, consumedFuture).all<{ id: string; consumed_at: string | null }>();
    expect(preserved.results.map((row) => row.id).sort()).toEqual([future, consumedFuture].sort());
    await expect(env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM attendees WHERE id = ?) AS attendees,
      (SELECT COUNT(*) FROM tickets WHERE id = ?) AS tickets,
      (SELECT COUNT(*) FROM audit_logs WHERE target_id = ?) AS audits`).bind(attendeeId, ticketId, attendeeId).first()).resolves.toEqual(beforeRoster);
    expect(await cleanupExpiredImportPreviews(env.DB)).toBe(0);
  });

  it("removes at most 1000 rows per invocation and drains a larger backlog on a later run", async () => {
    const fixture = await createImportFixture("Large cleanup organization");
    const rows = Array.from({ length: 1005 }, (_, index) => index);
    await env.DB.prepare(`INSERT INTO roster_import_previews (id, organization_id, event_id, actor_id, rows_json, expires_at)
      SELECT lower(hex(randomblob(16))), ?, ?, 'large-cleanup', '[]', '2000-01-01 00:00:00' FROM json_each(?)`)
      .bind(fixture.organizationId, fixture.eventId, JSON.stringify(rows)).run();

    expect(await cleanupExpiredImportPreviews(env.DB)).toBe(1000);
    expect(await previewCount(fixture.eventId)).toBe(5);
    expect(await cleanupExpiredImportPreviews(env.DB)).toBe(5);
    expect(await previewCount(fixture.eventId)).toBe(0);
  });

  it("runs from the scheduled handler and emits its bounded deletion count", async () => {
    let cleared: number;
    do { cleared = await cleanupExpiredImportPreviews(env.DB); } while (cleared === 1000);
    const fixture = await createImportFixture("Scheduled cleanup organization");
    await insertPreview({ ...fixture, expiresAt: "2000-01-01 00:00:00" });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await worker.scheduled!(createScheduledController({ scheduledTime: new Date("2026-10-05T00:00:00Z") }), env);
      expect(info).toHaveBeenCalledWith(JSON.stringify({ event: "import_preview_cleanup", deletedCount: 1, limitReached: false }));
      expect(await previewCount(fixture.eventId)).toBe(0);
    } finally {
      info.mockRestore();
    }
  });

  it("propagates D1 failures from both the helper and scheduled handler", async () => {
    const failure = new Error("D1 cleanup failure");
    const run = vi.fn().mockRejectedValue(failure);
    const fakeStatement = { bind: vi.fn(() => fakeStatement), run };
    const fakeDb = { prepare: vi.fn(() => fakeStatement) } as unknown as D1Database;
    await expect(cleanupExpiredImportPreviews(fakeDb)).rejects.toBe(failure);

    const fakeEnv = { ...env, DB: fakeDb } as Cloudflare.Env;
    await expect(worker.scheduled!(createScheduledController(), fakeEnv)).rejects.toBe(failure);
    expect(run).toHaveBeenCalled();
  });
});
