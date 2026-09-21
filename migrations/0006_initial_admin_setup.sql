CREATE TABLE initial_admin_challenges (
  id TEXT PRIMARY KEY,
  organization_name TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
