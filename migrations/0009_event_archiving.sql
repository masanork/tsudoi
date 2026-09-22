ALTER TABLE events ADD COLUMN archived_at TEXT;
CREATE INDEX events_organization_archived_idx ON events(organization_id, archived_at, starts_at);
