ALTER TABLE visitor_authorizations
  ADD COLUMN open_ended INTEGER NOT NULL DEFAULT 0 CHECK (open_ended IN (0, 1));
