ALTER TABLE area_reservation_rules ADD COLUMN allow_sundays INTEGER NOT NULL DEFAULT 0 CHECK (allow_sundays IN (0, 1));
ALTER TABLE area_reservation_rules ADD COLUMN allow_holidays INTEGER NOT NULL DEFAULT 0 CHECK (allow_holidays IN (0, 1));
