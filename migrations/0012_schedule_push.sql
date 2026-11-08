CREATE TABLE schedule_push_subscriptions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  owner_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, endpoint)
);
CREATE TABLE schedule_push_deliveries (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES schedule_push_subscriptions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(event_id, subscription_id, revision)
);
CREATE INDEX schedule_push_due_idx ON schedule_push_deliveries(next_attempt_at);
CREATE TRIGGER schedule_push_after_change AFTER UPDATE OF schedule_detail_revision ON events
WHEN NEW.schedule_detail_revision > OLD.schedule_detail_revision AND NEW.schedule_status = 'confirmed'
BEGIN
  INSERT INTO schedule_push_deliveries (event_id, subscription_id, revision)
    SELECT NEW.id, id, NEW.schedule_detail_revision FROM schedule_push_subscriptions WHERE event_id = NEW.id;
END;
