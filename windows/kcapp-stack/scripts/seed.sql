-- Starter data so the site is usable immediately after setup.
-- Edit names in the kcapp UI later; set the board's UUID in the venue
-- configuration once discovered (see the bridge README).
INSERT INTO office (name, is_global, is_active) VALUES ('Test Office', 0, 1);
SET @office_id = LAST_INSERT_ID();
INSERT INTO venue (name, office_id, description) VALUES ('Test Venue', @office_id, 'Windows test rig');
SET @venue_id = LAST_INSERT_ID();
INSERT INTO venue_configuration (venue_id, has_smartboard, smartboard_uuid, smartboard_button_number)
VALUES (@venue_id, 1, NULL, 20);
INSERT INTO player (first_name, last_name, nickname, office_id) VALUES
  ('Player', 'One', 'P1', @office_id),
  ('Player', 'Two', 'P2', @office_id);
