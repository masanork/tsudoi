export function rosterFilter(params: URLSearchParams, eventId: string) {
  const q = (params.get("q") ?? "").trim();
  const status = params.get("status") ?? "";
  const source = params.get("source") ?? "";
  const venueId = params.get("venueId") ?? "";
  const ticketStatus = params.get("ticketStatus") ?? "";
  if (q.length > 100 || !["", "active", "cancelled"].includes(status)
    || !["", "public_form", "walk_in", "admin"].includes(source)
    || !["", "issued", "checked_in", "cancelled", "voided"].includes(ticketStatus)) return null;
  return {
    sql: `a.event_id = ? AND (? = '' OR instr(lower(a.name), lower(?)) > 0
      OR instr(lower(COALESCE(a.email_normalized, '')), lower(?)) > 0 OR instr(lower(a.affiliation), lower(?)) > 0)
      AND (? = '' OR a.status = ?) AND (? = '' OR a.registration_source = ?) AND (? = '' OR a.venue_id = ?)
      AND (? = '' OR t.status = ?)`,
    values: [eventId, q, q, q, q, status, status, source, source, venueId, venueId, ticketStatus, ticketStatus],
  };
}
