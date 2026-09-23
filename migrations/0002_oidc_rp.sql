CREATE TABLE oidc_login_transactions (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_path TEXT NOT NULL,
  bootstrap_allowed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'complete')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX oidc_login_transactions_expiry_idx ON oidc_login_transactions(expires_at);

CREATE TABLE oidc_bootstrap_lock (id INTEGER PRIMARY KEY CHECK(id = 1));

CREATE TABLE oidc_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (issuer, subject),
  UNIQUE (issuer, user_id)
);

ALTER TABLE organizer_sessions ADD COLUMN oidc_sid TEXT;
ALTER TABLE organizer_sessions ADD COLUMN oidc_sub TEXT;
ALTER TABLE organizer_sessions ADD COLUMN oidc_auth_time INTEGER;
ALTER TABLE organizer_sessions ADD COLUMN oidc_lease_expires_at INTEGER;
ALTER TABLE organizer_sessions ADD COLUMN oidc_parent_expires_at INTEGER;
ALTER TABLE organizer_sessions ADD COLUMN oidc_idle_timeout INTEGER;
CREATE INDEX organizer_sessions_oidc_sid_idx ON organizer_sessions(oidc_sid);
