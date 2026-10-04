type CheckInResult = {
  outcome: "accepted" | "duplicate" | "rejected";
  id: string;
  status: string;
  checked_in_at: string | null;
  checked_in_by: string | null;
  checked_in_by_display_name: string;
};

/** Keep the ticket transition, attempt record, and audit in one D1 transaction. */
export async function checkIn(db: D1Database, input: {
  ticketId: string;
  venueId?: string;
  actorId: string;
  organizationId: string;
  action: string;
  magicLinkId?: string;
}) {
  const attemptId = crypto.randomUUID();
  const statements = [
    db.prepare(`UPDATE tickets SET status = 'checked_in', checked_in_at = CURRENT_TIMESTAMP,
      checked_in_by = ?, checked_in_venue_id = ? WHERE id = ? AND status = 'issued'
      AND EXISTS (SELECT 1 FROM attendees a WHERE a.id = tickets.attendee_id AND (a.venue_id IS NULL OR a.venue_id IS ?))`)
      .bind(input.actorId, input.venueId ?? null, input.ticketId, input.venueId ?? null),
    // changes() refers to the immediately preceding ticket UPDATE in this batch.
    db.prepare(`INSERT INTO check_ins (id, ticket_id, venue_id, staff_user_id, outcome)
      SELECT ?, id, ?, ?, CASE WHEN changes() = 1 THEN 'accepted'
        WHEN status = 'checked_in' THEN 'duplicate' ELSE 'rejected' END FROM tickets WHERE id = ?`)
      .bind(attemptId, input.venueId ?? null, input.actorId, input.ticketId),
    db.prepare(`INSERT INTO audit_logs (id, organization_id, actor_id, action, target_type, target_id, metadata_json)
      SELECT ?, ?, ?, ?, 'ticket', ticket_id, json_object('outcome', outcome, 'venueId', venue_id)
      FROM check_ins WHERE id = ?`)
      .bind(crypto.randomUUID(), input.organizationId, input.actorId, input.action, attemptId),
  ];
  if (input.magicLinkId) statements.push(db.prepare(`UPDATE magic_links SET consumed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND EXISTS (SELECT 1 FROM check_ins WHERE id = ? AND outcome = 'accepted')`)
    .bind(input.magicLinkId, attemptId));
  statements.push(db.prepare(`SELECT ci.outcome, t.id, t.status, t.checked_in_at, t.checked_in_by, COALESCE(u.display_name, t.checked_in_by, '') AS checked_in_by_display_name
    FROM check_ins ci JOIN tickets t ON t.id = ci.ticket_id LEFT JOIN users u ON u.id = t.checked_in_by WHERE ci.id = ?`).bind(attemptId));
  const results = await db.batch<CheckInResult>(statements);
  const row = results.at(-1)?.results[0];
  if (!row) throw new Error("Check-in result missing");
  const { outcome, ...ticket } = row;
  return { outcome, ticket };
}
