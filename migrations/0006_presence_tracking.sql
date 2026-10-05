CREATE TABLE attendee_presence (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  state TEXT NOT NULL DEFAULT 'out' CHECK (state IN ('out', 'in')),
  venue_id TEXT REFERENCES venues(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_request_id TEXT,
  UNIQUE (event_id, attendee_id),
  CHECK ((state = 'out' AND venue_id IS NULL) OR (state = 'in' AND venue_id IS NOT NULL))
);
CREATE INDEX attendee_presence_event_state_idx ON attendee_presence(event_id, state, venue_id, updated_at);
CREATE INDEX attendee_presence_attendee_idx ON attendee_presence(attendee_id, event_id);

CREATE TABLE presence_movements (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  request_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('enter', 'exit')),
  venue_id TEXT NOT NULL REFERENCES venues(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  occurred_at TEXT NOT NULL,
  UNIQUE (event_id, attendee_id, revision)
);
CREATE INDEX presence_movements_event_recorded_idx ON presence_movements(event_id, recorded_at, revision, id);
CREATE INDEX presence_movements_attendee_recorded_idx ON presence_movements(attendee_id, recorded_at, id);
CREATE INDEX presence_movements_venue_recorded_idx ON presence_movements(venue_id, recorded_at, id);

CREATE TABLE presence_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  action TEXT NOT NULL CHECK (action IN ('enter', 'exit')),
  venue_id TEXT NOT NULL REFERENCES venues(id),
  expected_revision INTEGER CHECK (expected_revision IS NULL OR expected_revision >= 0),
  created_by TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'accepted', 'state_conflict', 'revision_conflict')),
  movement_id TEXT UNIQUE REFERENCES presence_movements(id),
  result_state TEXT NOT NULL CHECK (result_state IN ('in', 'out')),
  result_venue_id TEXT REFERENCES venues(id),
  result_revision INTEGER NOT NULL CHECK (result_revision >= 0),
  result_updated_at TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, event_id, request_id),
  CHECK ((result_state = 'out' AND result_venue_id IS NULL) OR (result_state = 'in' AND result_venue_id IS NOT NULL)),
  CHECK ((outcome = 'accepted' AND movement_id IS NOT NULL) OR (outcome != 'accepted' AND movement_id IS NULL))
);
CREATE INDEX presence_requests_actor_idx ON presence_requests(organization_id, event_id, created_by, request_id);
CREATE INDEX presence_requests_attendee_idx ON presence_requests(attendee_id, created_at);
