INSERT OR IGNORE INTO permissions (key, description_es) VALUES
  ('reservations.release', 'Registrar la entrega operativa de un área reservada antes de su uso.');

INSERT OR IGNORE INTO role_permissions (role_key, permission_key) VALUES
  ('administrator', 'reservations.release'),
  ('security', 'reservations.release');

CREATE TABLE reservation_security_releases (
  reservation_id TEXT PRIMARY KEY REFERENCES reservations(id) ON DELETE RESTRICT,
  release_type TEXT NOT NULL CHECK (release_type IN ('access_key', 'checklist')),
  checklist_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  completed_by_person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_reservation_security_releases_completed
  ON reservation_security_releases(completed_at DESC);
