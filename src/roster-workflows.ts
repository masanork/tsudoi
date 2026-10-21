import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AppEnv, EventRow, FieldRow, OrganizerAuth } from "./index";

type Field = FieldRow & { label: string; staff_visibility: string; searchable: number; sort_order: number; retired_at: string | null; revision: number };
type Dependencies = {
  requireSession: MiddlewareHandler<AppEnv>;
  requireScope: (scope: string) => MiddlewareHandler<AppEnv>;
  eventForAuth: (c: Context<AppEnv>) => Promise<EventRow | null>;
  jsonBody: (c: Context<AppEnv>) => Promise<Record<string, unknown>>;
  audit: (db: D1Database, auth: OrganizerAuth, action: string, targetType: string, targetId: string, metadata?: Record<string, unknown>) => Promise<void>;
  isValidFieldAnswer: (field: FieldRow, answer: unknown) => boolean;
  hasRequiredAnswer: (field: FieldRow, answer: unknown) => boolean;
};
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 200) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null;
// A failed assertion aborts the entire D1 batch, including its audit records.
const assertion = (db: D1Database, condition: string) => db.prepare(`INSERT INTO attendee_answers (attendee_id, field_id, value_json) SELECT NULL, NULL, NULL WHERE ${condition}`);
const conflict = (error: unknown) => error instanceof Error && /NOT NULL constraint failed: attendee_answers|UNIQUE constraint failed/.test(error.message);

export function registerRosterWorkflows(app: Hono<AppEnv>, d: Dependencies) {
  const admin = [d.requireSession, d.requireScope("admin")] as const;

  app.patch("/api/events/:eventId/form-fields/:fieldId", ...admin, async (c) => {
    const event = await d.eventForAuth(c);
    if (!event) return c.json({ error: "not_found" }, 404);
    const current = await c.env.DB.prepare("SELECT * FROM form_fields WHERE id = ? AND event_id = ?").bind(c.req.param("fieldId"), event.id).first<Field>();
    if (!current) return c.json({ error: "not_found" }, 404);
    const body = await d.jsonBody(c);
    if (body.revision !== current.revision) return c.json({ error: "revision_conflict" }, 409);
    if (Object.keys(body).some((key) => !["revision", "label", "required", "options", "staffVisibility", "searchable", "sortOrder", "retired"].includes(key))) return c.json({ error: "immutable_or_unknown_field" }, 400);
    const label = body.label === undefined ? current.label : text(body.label);
    const options = body.options === undefined ? JSON.parse(current.options_json) as string[] : body.options;
    if (!label || !Array.isArray(options) || options.length > 100 || options.some((option) => !text(option)) || new Set(options).size !== options.length
      || (["single_select", "multi_select"].includes(current.field_type) && options.length === 0)
      || ["required", "searchable", "retired"].some((key) => body[key] !== undefined && typeof body[key] !== "boolean")
      || (body.staffVisibility !== undefined && !["visible", "admin_only"].includes(String(body.staffVisibility)))
      || (body.sortOrder !== undefined && (!Number.isInteger(body.sortOrder) || Number(body.sortOrder) < 0 || Number(body.sortOrder) > 10000))) return c.json({ error: "invalid_field" }, 400);
    const after = {
      label, required: body.required === undefined ? current.required : Number(body.required), options_json: JSON.stringify(options),
      staff_visibility: body.staffVisibility ?? current.staff_visibility, searchable: body.searchable === undefined ? current.searchable : Number(body.searchable),
      sort_order: body.sortOrder ?? current.sort_order, retired_at: body.retired === undefined ? current.retired_at : body.retired ? current.retired_at ?? new Date().toISOString() : null,
      revision: current.revision + 1,
    };
    const statements = [];
    if (["single_select", "multi_select"].includes(current.field_type)) statements.push(assertion(c.env.DB, `EXISTS (
      SELECT 1 FROM attendee_answers a, json_each(a.value_json) used WHERE a.field_id = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(?) option WHERE option.value = used.value))`).bind(current.id, after.options_json));
    statements.push(c.env.DB.prepare(`UPDATE form_fields SET label = ?, required = ?, options_json = ?, staff_visibility = ?, searchable = ?, sort_order = ?, retired_at = ?, revision = revision + 1
      WHERE id = ? AND event_id = ? AND revision = ?`).bind(after.label, after.required, after.options_json, after.staff_visibility, after.searchable, after.sort_order, after.retired_at, current.id, event.id, current.revision));
    statements.push(assertion(c.env.DB, "changes() != 1"));
    statements.push(c.env.DB.prepare("INSERT INTO audit_logs (id, organization_id, actor_id, action, target_type, target_id, metadata_json) VALUES (?, ?, ?, 'form_field.updated', 'form_field', ?, ?)")
      .bind(crypto.randomUUID(), c.get("auth").organizationId, c.get("auth").actorId, current.id, JSON.stringify({ before: current, after })));
    try { await c.env.DB.batch(statements); }
    catch (error) { if (conflict(error)) return c.json({ error: "field_conflict_or_option_in_use" }, 409); throw error; }
    return c.json({ updated: true, revision: after.revision });
  });

  app.get("/api/events/:eventId/roster/view", d.requireSession, d.requireScope("roster:read"), async (c) => {
    const event = await d.eventForAuth(c);
    if (!event) return c.json({ error: "not_found" }, 404);
    const row = await c.env.DB.prepare("SELECT columns_json, revision FROM roster_views WHERE event_id = ? AND user_id = ?")
      .bind(event.id, c.get("auth").actorId).first<{ columns_json: string; revision: number }>();
    const fields = await c.env.DB.prepare("SELECT field_key FROM form_fields WHERE event_id = ? AND (? NOT IN ('staff', 'viewer') OR staff_visibility = 'visible')")
      .bind(event.id, c.get("auth").role).all<{ field_key: string }>();
    const allowed = new Set(["name", "affiliation", "email", "venue", "ticket", ...fields.results.map((field) => `answer:${field.field_key}`)]);
    return c.json({ columns: row ? (JSON.parse(row.columns_json) as string[]).filter((key) => allowed.has(key)) : null, revision: row?.revision ?? 0 });
  });
  app.put("/api/events/:eventId/roster/view", d.requireSession, d.requireScope("roster:read"), async (c) => {
    const event = await d.eventForAuth(c);
    if (!event) return c.json({ error: "not_found" }, 404);
    const body = await d.jsonBody(c), auth = c.get("auth");
    const fields = await c.env.DB.prepare("SELECT field_key FROM form_fields WHERE event_id = ? AND (? NOT IN ('staff', 'viewer') OR staff_visibility = 'visible')").bind(event.id, auth.role).all<{ field_key: string }>();
    const allowed = new Set(["name", "affiliation", "email", "venue", "ticket", ...fields.results.map((field) => `answer:${field.field_key}`)]);
    if (!Number.isInteger(body.revision) || Number(body.revision) < 0 || !Array.isArray(body.columns) || body.columns.length > allowed.size
      || !body.columns.includes("name") || new Set(body.columns).size !== body.columns.length || body.columns.some((key) => typeof key !== "string" || !allowed.has(key))) return c.json({ error: "invalid_columns" }, 400);
    const result = Number(body.revision) === 0
      ? await c.env.DB.prepare("INSERT INTO roster_views (event_id, user_id, columns_json, revision) VALUES (?, ?, ?, 1) ON CONFLICT(event_id, user_id) DO NOTHING")
        .bind(event.id, auth.actorId, JSON.stringify(body.columns)).run()
      : await c.env.DB.prepare("UPDATE roster_views SET columns_json = ?, revision = revision + 1 WHERE event_id = ? AND user_id = ? AND revision = ?")
        .bind(JSON.stringify(body.columns), event.id, auth.actorId, body.revision).run();
    if (!result.meta.changes) return c.json({ error: "revision_conflict" }, 409);
    return c.json({ saved: true, revision: Number(body.revision) + 1 });
  });

  app.get("/api/form-templates", ...admin, async (c) => {
    const rows = await c.env.DB.prepare("SELECT id, name, json_array_length(fields_json) AS field_count FROM form_templates WHERE organization_id = ? ORDER BY created_at DESC, id")
      .bind(c.get("auth").organizationId).all();
    return c.json({ templates: rows.results });
  });
  app.post("/api/events/:eventId/form-templates", ...admin, async (c) => {
    const event = await d.eventForAuth(c);
    if (!event) return c.json({ error: "not_found" }, 404);
    const body = await d.jsonBody(c), name = text(body.name, 100), auth = c.get("auth");
    if (!name) return c.json({ error: "invalid_template_name" }, 400);
    const fields = await c.env.DB.prepare("SELECT field_key, label, field_type, required, options_json, staff_visibility, searchable, sort_order FROM form_fields WHERE event_id = ? AND retired_at IS NULL ORDER BY sort_order, created_at, id")
      .bind(event.id).all();
    if (!fields.results.length || fields.results.length > 100) return c.json({ error: "template_requires_1_to_100_fields" }, 400);
    const id = crypto.randomUUID(), fieldsJson = JSON.stringify(fields.results);
    if (new TextEncoder().encode(fieldsJson).byteLength > 200_000) return c.json({ error: "template_too_large" }, 413);
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO form_templates (id, organization_id, name, fields_json, created_by) VALUES (?, ?, ?, ?, ?)").bind(id, auth.organizationId, name, fieldsJson, auth.actorId),
      c.env.DB.prepare("INSERT INTO audit_logs (id, organization_id, actor_id, action, target_type, target_id, metadata_json) VALUES (?, ?, ?, 'form_template.created', 'form_template', ?, ?)")
        .bind(crypto.randomUUID(), auth.organizationId, auth.actorId, id, JSON.stringify({ eventId: event.id, name, fieldCount: fields.results.length })),
    ]);
    return c.json({ id }, 201);
  });
  app.delete("/api/form-templates/:templateId", ...admin, async (c) => {
    const auth = c.get("auth"), id = c.req.param("templateId");
    const result = await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM form_templates WHERE id = ? AND organization_id = ?").bind(id, auth.organizationId),
      c.env.DB.prepare("INSERT INTO audit_logs (id, organization_id, actor_id, action, target_type, target_id) SELECT ?, ?, ?, 'form_template.deleted', 'form_template', ? WHERE changes() = 1")
        .bind(crypto.randomUUID(), auth.organizationId, auth.actorId, id),
    ]);
    return result[0].meta.changes ? c.json({ deleted: true }) : c.json({ error: "not_found" }, 404);
  });
  app.post("/api/events/:eventId/form-templates/:templateId/apply", ...admin, async (c) => {
    const event = await d.eventForAuth(c);
    if (!event) return c.json({ error: "not_found" }, 404);
    const auth = c.get("auth");
    const template = await c.env.DB.prepare("SELECT fields_json FROM form_templates WHERE id = ? AND organization_id = ?").bind(c.req.param("templateId"), auth.organizationId).first<{ fields_json: string }>();
    if (!template) return c.json({ error: "not_found" }, 404);
    const fields = (JSON.parse(template.fields_json) as Field[]).map((field) => ({ ...field, id: crypto.randomUUID() }));
    try { await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO form_fields (id, event_id, field_key, label, field_type, required, options_json, staff_visibility, searchable, sort_order)
        SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.field_key'), json_extract(value, '$.label'), json_extract(value, '$.field_type'),
          json_extract(value, '$.required'), json_extract(value, '$.options_json'), json_extract(value, '$.staff_visibility'), json_extract(value, '$.searchable'), json_extract(value, '$.sort_order') FROM json_each(?)`)
        .bind(event.id, JSON.stringify(fields)),
      c.env.DB.prepare("INSERT INTO audit_logs (id, organization_id, actor_id, action, target_type, target_id, metadata_json) VALUES (?, ?, ?, 'form_template.applied', 'event', ?, ?)")
        .bind(crypto.randomUUID(), auth.organizationId, auth.actorId, event.id, JSON.stringify({ templateId: c.req.param("templateId"), fieldCount: fields.length })),
    ]); } catch (error) { if (conflict(error)) return c.json({ error: "template_field_key_conflict" }, 409); throw error; }
    return c.json({ added: fields.length }, 201);
  });

  app.post("/api/events/:eventId/roster/bulk-update", ...admin, async (c) => {
    const event = await d.eventForAuth(c);
    if (!event) return c.json({ error: "not_found" }, 404);
    const body = await d.jsonBody(c), auth = c.get("auth"), attendees = body.attendees, patch = body.patch;
    if (!Array.isArray(attendees) || !attendees.length || attendees.length > 100 || !record(patch)
      || attendees.some((row) => !record(row) || !text(row.id, 64) || !Number.isInteger(row.revision) || Number(row.revision) < 0)
      || new Set(attendees.map((row) => row.id)).size !== attendees.length
      || !Object.keys(patch).length || Object.keys(patch).some((key) => !["affiliation", "venueId", "answers"].includes(key))
      || (patch.affiliation !== undefined && (typeof patch.affiliation !== "string" || patch.affiliation.length > 200))
      || (patch.venueId !== undefined && patch.venueId !== null && !text(patch.venueId, 64))
      || (patch.answers !== undefined && (!record(patch.answers) || !Object.keys(patch.answers).length || Object.keys(patch.answers).length > 100))) return c.json({ error: "invalid_bulk_update" }, 400);
    const fields = await c.env.DB.prepare("SELECT * FROM form_fields WHERE event_id = ? AND retired_at IS NULL").bind(event.id).all<Field>();
    const answerChanges: { fieldId: string; fieldKey: string; valueJson: string | null; revision: number }[] = [];
    for (const [key, value] of Object.entries(record(patch.answers) ? patch.answers : {})) {
      const field = fields.results.find((f) => f.field_key === key);
      if (!field || ((value === null || value === "") ? field.required === 1 : !d.isValidFieldAnswer(field, value) || (field.required === 1 && !d.hasRequiredAnswer(field, value)))) return c.json({ error: "invalid_bulk_answer", field: key }, 400);
      answerChanges.push({ fieldId: field.id, fieldKey: key, valueJson: value === null || value === "" ? null : JSON.stringify(value), revision: field.revision });
    }
    const records = JSON.stringify(attendees.map((row) => ({ id: row.id, revision: row.revision, auditId: crypto.randomUUID() })));
    const answers = JSON.stringify(answerChanges), hasVenue = Number(patch.venueId !== undefined), venueId = patch.venueId ?? null;
    const hasAffiliation = Number(patch.affiliation !== undefined), affiliation = typeof patch.affiliation === "string" ? patch.affiliation.trim() : "";
    const statements = [
      assertion(c.env.DB, `EXISTS (SELECT 1 FROM json_each(?) r LEFT JOIN attendees a ON a.id = json_extract(r.value, '$.id') AND a.event_id = ? AND a.organization_id = ?
        LEFT JOIN tickets t ON t.attendee_id = a.id WHERE a.id IS NULL OR a.revision != json_extract(r.value, '$.revision') OR (? = 1 AND ? IS NOT a.venue_id AND t.status = 'checked_in'))
        OR (? = 1 AND ? IS NOT NULL AND NOT EXISTS (SELECT 1 FROM venues WHERE id = ? AND event_id = ?))
        OR EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN form_fields f ON f.id = json_extract(j.value, '$.fieldId') AND f.event_id = ?
          WHERE f.id IS NULL OR f.retired_at IS NOT NULL OR f.revision != json_extract(j.value, '$.revision'))`)
        .bind(records, event.id, auth.organizationId, hasVenue, venueId, hasVenue, venueId, venueId, event.id, answers, event.id),
      c.env.DB.prepare(`INSERT INTO audit_logs (id, organization_id, actor_id, action, target_type, target_id, metadata_json)
        SELECT json_extract(r.value, '$.auditId'), ?, ?, 'attendee.bulk_updated', 'attendee', a.id,
          json_object('before', json_object('affiliation', a.affiliation, 'venueId', a.venue_id, 'revision', a.revision,
            'answers', json(COALESCE((SELECT json_group_object(f.field_key, json(aa.value_json)) FROM attendee_answers aa JOIN form_fields f ON f.id = aa.field_id
              WHERE aa.attendee_id = a.id AND f.id IN (SELECT json_extract(value, '$.fieldId') FROM json_each(?))), '{}'))),
            'after', json_object('affiliation', CASE WHEN ? THEN ? ELSE a.affiliation END, 'venueId', CASE WHEN ? THEN ? ELSE a.venue_id END,
              'answers', json(?), 'revision', a.revision + 1))
        FROM json_each(?) r JOIN attendees a ON a.id = json_extract(r.value, '$.id') AND a.event_id = ?`)
        .bind(auth.organizationId, auth.actorId, answers, hasAffiliation, affiliation, hasVenue, venueId, JSON.stringify(patch.answers ?? {}), records, event.id),
      c.env.DB.prepare(`UPDATE attendees SET affiliation = CASE WHEN ? THEN ? ELSE affiliation END, venue_id = CASE WHEN ? THEN ? ELSE venue_id END, revision = revision + 1
        WHERE event_id = ? AND organization_id = ? AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`)
        .bind(hasAffiliation, affiliation, hasVenue, venueId, event.id, auth.organizationId, records),
      assertion(c.env.DB, "changes() != ?").bind(attendees.length),
      c.env.DB.prepare(`DELETE FROM attendee_answers WHERE attendee_id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
        AND field_id IN (SELECT json_extract(value, '$.fieldId') FROM json_each(?))`).bind(records, answers),
      c.env.DB.prepare(`INSERT INTO attendee_answers (attendee_id, field_id, value_json) SELECT json_extract(r.value, '$.id'), json_extract(j.value, '$.fieldId'), json_extract(j.value, '$.valueJson')
        FROM json_each(?) r CROSS JOIN json_each(?) j WHERE json_extract(j.value, '$.valueJson') IS NOT NULL`).bind(records, answers),
    ];
    try { await c.env.DB.batch(statements); }
    catch (error) { if (conflict(error)) return c.json({ error: "bulk_conflict_refresh_required" }, 409); throw error; }
    return c.json({ updated: attendees.length });
  });
}
