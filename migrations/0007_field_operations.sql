CREATE TABLE households (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_change_id TEXT,
  archived_at TEXT
);
CREATE INDEX households_event_idx ON households(event_id, archived_at, name, id);

CREATE TABLE household_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_by TEXT,
  removed_operation_id TEXT,
  removed_at TEXT
);
CREATE UNIQUE INDEX household_memberships_active_attendee_idx ON household_memberships(event_id, attendee_id) WHERE removed_at IS NULL;
CREATE INDEX household_memberships_household_idx ON household_memberships(household_id, removed_at, attendee_id);

CREATE TABLE ticket_qr_card_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('additional','replacement')),
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  venue_id TEXT REFERENCES venues(id),
  card_id TEXT,
  revoked_count INTEGER NOT NULL DEFAULT 0,
  legacy_credential_invalidated INTEGER NOT NULL DEFAULT 0 CHECK(legacy_credential_invalidated IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id,event_id,request_id)
);
CREATE INDEX ticket_qr_card_requests_actor_idx ON ticket_qr_card_requests(organization_id,event_id,created_by,request_id);

CREATE TABLE ticket_qr_cards (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  qr_token_id TEXT NOT NULL UNIQUE REFERENCES ticket_qr_tokens(id),
  venue_id TEXT REFERENCES venues(id),
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('additional','replacement')),
  reason TEXT,
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(ticket_id,request_id)
);
CREATE INDEX ticket_qr_cards_ticket_idx ON ticket_qr_cards(ticket_id, issued_at DESC);

CREATE TABLE distribution_proxy_claims (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  distribution_id TEXT NOT NULL REFERENCES distributions(id),
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id),
  household_name_snapshot TEXT NOT NULL,
  collector_id TEXT NOT NULL REFERENCES attendees(id),
  collector_name_snapshot TEXT NOT NULL,
  venue_id TEXT REFERENCES venues(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','limit_reached')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reversed_at TEXT,
  reversal_id TEXT UNIQUE,
  reversed_by TEXT,
  reverse_reason TEXT,
  UNIQUE(distribution_id,request_id)
);
CREATE INDEX distribution_proxy_claims_page_idx ON distribution_proxy_claims(distribution_id,created_at DESC,id DESC);

CREATE TABLE distribution_proxy_items (
  id TEXT PRIMARY KEY,
  proxy_claim_id TEXT NOT NULL REFERENCES distribution_proxy_claims(id),
  claim_id TEXT REFERENCES distribution_claims(id),
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  attendee_name_snapshot TEXT NOT NULL,
  affiliation_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000),
  used_after INTEGER NOT NULL CHECK(used_after >= 0),
  remaining_after INTEGER NOT NULL CHECK(remaining_after >= 0),
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','limit_reached')),
  UNIQUE(proxy_claim_id,attendee_id)
);
CREATE INDEX distribution_proxy_items_claim_idx ON distribution_proxy_items(claim_id);

ALTER TABLE distribution_claims ADD COLUMN proxy_group_id TEXT REFERENCES distribution_proxy_claims(id);
CREATE INDEX distribution_claims_proxy_group_idx ON distribution_claims(proxy_group_id);
