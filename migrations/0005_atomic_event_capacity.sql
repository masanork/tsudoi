ALTER TABLE events ADD COLUMN active_registration_count INTEGER NOT NULL DEFAULT 0;

UPDATE events
SET active_registration_count = (
  SELECT COUNT(*) FROM attendees
  WHERE attendees.event_id = events.id AND attendees.status = 'active'
);

CREATE TRIGGER attendees_capacity_before_insert
BEFORE INSERT ON attendees
WHEN NEW.status = 'active' AND EXISTS (
  SELECT 1 FROM events
  WHERE id = NEW.event_id
    AND capacity IS NOT NULL
    AND active_registration_count >= capacity
)
BEGIN
  SELECT RAISE(ABORT, 'capacity_reached');
END;

CREATE TRIGGER attendees_capacity_before_reactivate
BEFORE UPDATE OF status ON attendees
WHEN OLD.status != 'active' AND NEW.status = 'active' AND EXISTS (
  SELECT 1 FROM events
  WHERE id = NEW.event_id
    AND capacity IS NOT NULL
    AND active_registration_count >= capacity
)
BEGIN
  SELECT RAISE(ABORT, 'capacity_reached');
END;

CREATE TRIGGER attendees_capacity_after_insert
AFTER INSERT ON attendees
WHEN NEW.status = 'active'
BEGIN
  UPDATE events SET active_registration_count = active_registration_count + 1 WHERE id = NEW.event_id;
END;

CREATE TRIGGER attendees_capacity_after_cancel
AFTER UPDATE OF status ON attendees
WHEN OLD.status = 'active' AND NEW.status != 'active'
BEGIN
  UPDATE events SET active_registration_count = active_registration_count - 1 WHERE id = NEW.event_id;
END;

CREATE TRIGGER attendees_capacity_after_reactivate
AFTER UPDATE OF status ON attendees
WHEN OLD.status != 'active' AND NEW.status = 'active'
BEGIN
  UPDATE events SET active_registration_count = active_registration_count + 1 WHERE id = NEW.event_id;
END;
