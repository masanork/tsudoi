CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('registration','authentication')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX webauthn_challenges_lookup_idx ON webauthn_challenges(attendee_id, purpose, expires_at);
