-- Browser sessions are deliberately separate from API tokens.  The latter are
-- reserved for future integrations and are never persisted in the web client.
CREATE TABLE organizer_webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE organizer_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX organizer_sessions_token_idx ON organizer_sessions(token_hash, expires_at);

-- These tokens existed only to let the previous browser UI authenticate.  A
-- deployed installation can now sign in with its already-registered Passkey,
-- so invalidate them during the transition instead of leaving a hidden admin
-- credential in localStorage.
UPDATE api_tokens
SET revoked_at = CURRENT_TIMESTAMP
WHERE label = 'initial administrator token' AND revoked_at IS NULL;
