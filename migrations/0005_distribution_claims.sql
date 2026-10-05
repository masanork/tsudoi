CREATE TABLE distributions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  max_per_attendee INTEGER NOT NULL CHECK (max_per_attendee BETWEEN 1 AND 1000),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_change_id TEXT,
  UNIQUE (event_id, name COLLATE NOCASE)
);
CREATE INDEX distributions_event_active_idx ON distributions(event_id, active, created_at, id);

CREATE TABLE distribution_claims (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  distribution_id TEXT NOT NULL REFERENCES distributions(id),
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  venue_id TEXT REFERENCES venues(id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'limit_reached')),
  used_after INTEGER NOT NULL CHECK (used_after >= 0),
  remaining_after INTEGER NOT NULL CHECK (remaining_after >= 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reversed_at TEXT,
  reversal_id TEXT UNIQUE,
  reversed_by TEXT,
  reverse_reason TEXT,
  UNIQUE (distribution_id, request_id)
);
CREATE INDEX distribution_claims_quota_idx ON distribution_claims(distribution_id, attendee_id, outcome, reversed_at);
CREATE INDEX distribution_claims_page_idx ON distribution_claims(distribution_id, created_at DESC, id DESC);
