CREATE TABLE event_organizers (
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('organizer', 'cohost')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_organizers_user_idx ON event_organizers(user_id, event_id);
