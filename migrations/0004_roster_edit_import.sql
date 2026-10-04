ALTER TABLE attendees ADD COLUMN affiliation TEXT NOT NULL DEFAULT '';
ALTER TABLE attendees ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE roster_import_previews (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  claim_id TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX roster_import_previews_expiry_idx ON roster_import_previews(expires_at);
