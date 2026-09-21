CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX push_subscriptions_attendee_idx ON push_subscriptions(attendee_id);
