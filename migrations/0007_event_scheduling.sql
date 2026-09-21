ALTER TABLE events ADD COLUMN scheduling_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN schedule_status TEXT NOT NULL DEFAULT 'not_started' CHECK(schedule_status IN ('not_started','collecting','confirmed'));

CREATE TABLE schedule_options (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, starts_at, ends_at)
);
CREATE INDEX schedule_options_event_idx ON schedule_options(event_id, starts_at);

CREATE TABLE schedule_responses (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  option_id TEXT NOT NULL REFERENCES schedule_options(id),
  respondent_id TEXT NOT NULL,
  respondent_name TEXT NOT NULL,
  response TEXT NOT NULL CHECK(response IN ('yes','maybe','no')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(option_id, respondent_id)
);
CREATE INDEX schedule_responses_event_idx ON schedule_responses(event_id, option_id, response);
