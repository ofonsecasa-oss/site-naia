PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO permissions (key, description_es) VALUES
  ('visitors.create', 'Preautorizar visitantes para la vivienda donde reside.'),
  ('security.incidents.read', 'Consultar la bitácora de seguridad.'),
  ('security.incidents.manage', 'Registrar incidentes en la bitácora de seguridad.');

INSERT OR IGNORE INTO role_permissions (role_key, permission_key) VALUES
  ('administrator', 'visitors.create'),
  ('administrator', 'security.incidents.read'),
  ('administrator', 'security.incidents.manage'),
  ('security', 'security.incidents.read'),
  ('security', 'security.incidents.manage');

CREATE TABLE visitor_authorizations (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  created_by_person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  visitor_name TEXT NOT NULL,
  visitor_type TEXT NOT NULL CHECK (visitor_type IN ('guest', 'delivery', 'domestic_worker', 'service', 'contractor', 'transport', 'other')),
  vehicle_plate TEXT,
  notes TEXT,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('one_time', 'weekly')),
  one_time_at TEXT,
  recurring_start_date TEXT,
  recurring_end_date TEXT,
  recurring_time TEXT,
  weekdays_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  cancelled_at TEXT,
  cancelled_by_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (schedule_type = 'one_time' AND one_time_at IS NOT NULL AND recurring_start_date IS NULL AND recurring_end_date IS NULL AND recurring_time IS NULL)
    OR
    (schedule_type = 'weekly' AND one_time_at IS NULL AND recurring_start_date IS NOT NULL AND recurring_end_date IS NOT NULL AND recurring_time IS NOT NULL)
  ),
  CHECK (recurring_end_date IS NULL OR recurring_end_date >= recurring_start_date)
);

CREATE INDEX idx_visitor_authorizations_creator ON visitor_authorizations(created_by_person_id, active, created_at DESC);
CREATE INDEX idx_visitor_authorizations_unit ON visitor_authorizations(unit_id, active);

CREATE TABLE visitor_access_events (
  id TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL REFERENCES visitor_authorizations(id) ON DELETE RESTRICT,
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  visitor_name TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'allowed_resident_authorized',
    'allowed_administration_authorized',
    'denied_resident',
    'denied_documents',
    'denied_protocol',
    'cancelled_by_visitor',
    'no_show'
  )),
  notes TEXT,
  recorded_by_person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (authorization_id, scheduled_for)
);

CREATE INDEX idx_visitor_access_events_scheduled ON visitor_access_events(scheduled_for DESC);

CREATE TABLE security_incidents (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  description TEXT NOT NULL,
  created_by_person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_security_incidents_occurred ON security_incidents(occurred_at DESC);
