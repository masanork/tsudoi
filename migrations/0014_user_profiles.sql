ALTER TABLE users ADD COLUMN avatar_url TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE initial_admin_challenges ADD COLUMN display_name TEXT;
ALTER TABLE initial_admin_challenges ADD COLUMN email_normalized TEXT;
