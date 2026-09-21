PRAGMA foreign_keys = ON;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email_normalized TEXT UNIQUE,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('owner','admin','staff','viewer')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, user_id)
);
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  label TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  registration_opens_at TEXT,
  registration_closes_at TEXT,
  capacity INTEGER,
  registration_mode TEXT NOT NULL CHECK(registration_mode IN ('advance','walk_in','hybrid')),
  cancellation_closes_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','closed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX events_organization_idx ON events(organization_id, starts_at);
CREATE TABLE venues (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  opens_at TEXT,
  capacity INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE form_fields (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK(field_type IN ('text','textarea','number','date','single_select','multi_select','checkbox','consent')),
  required INTEGER NOT NULL DEFAULT 0,
  options_json TEXT NOT NULL DEFAULT '[]',
  staff_visibility TEXT NOT NULL DEFAULT 'visible' CHECK(staff_visibility IN ('visible','admin_only')),
  searchable INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  retired_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, field_key)
);
CREATE TABLE attendees (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  venue_id TEXT REFERENCES venues(id),
  name TEXT NOT NULL,
  email_normalized TEXT,
  registration_source TEXT NOT NULL CHECK(registration_source IN ('public_form','walk_in','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_at TEXT
);
CREATE INDEX attendees_event_idx ON attendees(event_id, status, created_at);
CREATE TABLE attendee_answers (
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  field_id TEXT NOT NULL REFERENCES form_fields(id),
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (attendee_id, field_id)
);
CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  attendee_id TEXT NOT NULL UNIQUE REFERENCES attendees(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  token_hash TEXT NOT NULL UNIQUE,
  token_key_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','checked_in','cancelled','voided')),
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checked_in_at TEXT,
  checked_in_by TEXT,
  checked_in_venue_id TEXT REFERENCES venues(id)
);
CREATE TABLE check_ins (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  venue_id TEXT REFERENCES venues(id),
  staff_user_id TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','duplicate','rejected','reversed')),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE magic_links (
  id TEXT PRIMARY KEY,
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK(purpose IN ('ticket','cancel','recover')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  attendee_id TEXT REFERENCES attendees(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT NOT NULL DEFAULT '[]',
  prf_capable INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((user_id IS NOT NULL) != (attendee_id IS NOT NULL))
);
CREATE TABLE message_threads (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  key_generation INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, attendee_id)
);
CREATE TABLE encrypted_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES message_threads(id),
  sender_kind TEXT NOT NULL CHECK(sender_kind IN ('attendee','organizer')),
  ciphertext BLOB NOT NULL,
  algorithm TEXT NOT NULL,
  key_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE key_envelopes (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES message_threads(id),
  recipient_key_id TEXT NOT NULL,
  encrypted_key BLOB NOT NULL,
  algorithm TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX audit_logs_organization_idx ON audit_logs(organization_id, created_at);
