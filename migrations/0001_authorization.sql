PRAGMA foreign_keys = ON;

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  clerk_user_id TEXT UNIQUE,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE roles (
  key TEXT PRIMARY KEY,
  name_es TEXT NOT NULL,
  description_es TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 1 CHECK (is_system IN (0, 1))
);

CREATE TABLE permissions (
  key TEXT PRIMARY KEY,
  description_es TEXT NOT NULL
);

CREATE TABLE role_permissions (
  role_key TEXT NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_key)
);

CREATE TABLE person_roles (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL REFERENCES roles(key) ON DELETE RESTRICT,
  assigned_by TEXT REFERENCES people(id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (person_id, role_key)
);

CREATE TABLE units (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE ownerships (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  ownership_share REAL,
  starts_on TEXT,
  ends_on TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

CREATE TABLE occupancies (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  occupancy_type TEXT NOT NULL CHECK (occupancy_type IN ('owner_resident', 'tenant', 'authorized_occupant')),
  starts_on TEXT NOT NULL,
  ends_on TEXT,
  verified_by TEXT REFERENCES people(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  clerk_invitation_id TEXT UNIQUE,
  email TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'accepted', 'failed', 'revoked', 'expired')),
  error_message TEXT,
  created_by TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_people_clerk_user ON people(clerk_user_id);
CREATE INDEX idx_person_roles_role ON person_roles(role_key);
CREATE INDEX idx_ownerships_person ON ownerships(person_id);
CREATE INDEX idx_ownerships_unit ON ownerships(unit_id);
CREATE INDEX idx_occupancies_person ON occupancies(person_id);
CREATE INDEX idx_occupancies_unit ON occupancies(unit_id);
CREATE INDEX idx_audit_created_at ON audit_events(created_at DESC);

INSERT INTO roles (key, name_es, description_es) VALUES
  ('administrator', 'Administración', 'Gestiona usuarios, roles, documentos y configuración del portal.'),
  ('security', 'Seguridad', 'Acceso operativo a visitantes y registros de entrada y salida.'),
  ('board_member', 'Junta directiva', 'Acceso de supervisión y consulta definido por la administración.');

INSERT INTO permissions (key, description_es) VALUES
  ('people.read', 'Consultar personas y sus relaciones.'),
  ('people.manage', 'Crear, invitar, activar y desactivar personas.'),
  ('roles.assign', 'Cambiar los roles de una persona.'),
  ('documents.read', 'Consultar documentos publicados.'),
  ('documents.manage', 'Publicar y administrar documentos.'),
  ('visitors.read', 'Consultar visitantes autorizados.'),
  ('visitors.manage', 'Registrar entradas y salidas de visitantes.'),
  ('reservations.manage', 'Administrar reservas de áreas comunes.'),
  ('audit.read', 'Consultar el historial de acciones administrativas.');

INSERT INTO role_permissions (role_key, permission_key)
SELECT 'administrator', key FROM permissions;

INSERT INTO role_permissions (role_key, permission_key) VALUES
  ('security', 'visitors.read'),
  ('security', 'visitors.manage'),
  ('board_member', 'documents.read');
