CREATE TABLE agent_connections (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  respondent_id TEXT NOT NULL,
  respondent_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'schedule:read schedule:write',
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX agent_connections_token_idx ON agent_connections(token_hash, expires_at);
CREATE INDEX agent_connections_event_respondent_idx ON agent_connections(event_id, respondent_id);
