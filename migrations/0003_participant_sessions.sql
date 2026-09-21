CREATE TABLE participant_sessions (
  id TEXT PRIMARY KEY,
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX participant_sessions_token_idx ON participant_sessions(token_hash, expires_at);
