CREATE TABLE scheduling_preferences (
  event_id TEXT NOT NULL REFERENCES events(id),
  respondent_id TEXT NOT NULL,
  availability_text TEXT NOT NULL DEFAULT '',
  constraints_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, respondent_id)
);
