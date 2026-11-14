ALTER TABLE units ADD COLUMN reservations_enabled INTEGER NOT NULL DEFAULT 1 CHECK (reservations_enabled IN (0, 1));
ALTER TABLE units ADD COLUMN reservation_block_reason TEXT;
ALTER TABLE units ADD COLUMN updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z';

WITH RECURSIVE unit_numbers(number) AS (
  SELECT 1
  UNION ALL
  SELECT number + 1 FROM unit_numbers WHERE number < 68
)
INSERT OR IGNORE INTO units (id, number)
SELECT printf('unit-%02d', number), CAST(number AS TEXT) FROM unit_numbers;

INSERT OR IGNORE INTO permissions (key, description_es) VALUES
  ('reservations.read', 'Consultar el calendario y la disponibilidad de áreas comunes.'),
  ('reservations.read_details', 'Consultar la vivienda y la persona responsable de una reservación.'),
  ('reservations.manage', 'Crear áreas reservables, reglas y administrar reservaciones.');

INSERT OR IGNORE INTO role_permissions (role_key, permission_key)
SELECT 'administrator', key
  FROM permissions
 WHERE key IN ('reservations.read', 'reservations.read_details', 'reservations.manage');

INSERT OR IGNORE INTO role_permissions (role_key, permission_key) VALUES
  ('security', 'reservations.read'),
  ('security', 'reservations.read_details'),
  ('board_member', 'reservations.read');

CREATE TABLE reservable_areas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#A84132',
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  terms_text TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES people(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE area_reservation_rules (
  area_id TEXT PRIMARY KEY REFERENCES reservable_areas(id) ON DELETE CASCADE,
  min_notice_minutes INTEGER NOT NULL DEFAULT 0 CHECK (min_notice_minutes >= 0),
  max_advance_days INTEGER NOT NULL DEFAULT 365 CHECK (max_advance_days >= 0),
  max_reservations_per_unit_month INTEGER CHECK (max_reservations_per_unit_month IS NULL OR max_reservations_per_unit_month > 0),
  cancellation_cutoff_minutes INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_cutoff_minutes >= 0),
  max_guests INTEGER CHECK (max_guests IS NULL OR max_guests >= 0),
  fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  deposit_cents INTEGER NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),
  requires_approval INTEGER NOT NULL DEFAULT 0 CHECK (requires_approval IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE area_time_slots (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES reservable_areas(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  day_of_week INTEGER CHECK (day_of_week IS NULL OR day_of_week BETWEEN 0 AND 6),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (starts_at GLOB '[0-2][0-9]:[0-5][0-9]'),
  CHECK (ends_at GLOB '[0-2][0-9]:[0-5][0-9]'),
  CHECK (ends_at > starts_at)
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES reservable_areas(id) ON DELETE RESTRICT,
  slot_id TEXT NOT NULL REFERENCES area_time_slots(id) ON DELETE RESTRICT,
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  created_by_person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  reservation_date TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled', 'rejected')),
  guest_count INTEGER NOT NULL DEFAULT 0 CHECK (guest_count >= 0),
  notes TEXT NOT NULL DEFAULT '',
  cancelled_at TEXT,
  cancelled_by TEXT REFERENCES people(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (reservation_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  CHECK (ends_at > starts_at)
);

CREATE UNIQUE INDEX idx_reservations_active_slot
  ON reservations(area_id, reservation_date, slot_id)
  WHERE status IN ('pending', 'confirmed');
CREATE INDEX idx_reservations_calendar ON reservations(reservation_date, area_id, status);
CREATE INDEX idx_reservations_unit ON reservations(unit_id, reservation_date, status);
CREATE INDEX idx_area_slots_area ON area_time_slots(area_id, active, display_order);

INSERT INTO reservable_areas (id, name, description, color, capacity, active, terms_text) VALUES
  ('area-bbq', 'Zona BBQ', 'Área de parrilla y convivencia.', '#B84A3A', NULL, 1,
   'Apagar abanicos y parrillas al finalizar. Limpiar mesas y sillas y depositar los residuos en los recipientes asignados. Si se agota el gas, notificar a seguridad.'),
  ('area-spa', 'Spa', 'Sauna, jacuzzi, tina y camilla de masajes.', '#4F7C78', NULL, 0,
   'Apagar el sauna, drenar jacuzzi y tina y dejar limpia la camilla. Solicitar el control del aire acondicionado a seguridad. No usar aromatizadores o difusores personales.'),
  ('area-clubhouse', 'Casa Club', 'Espacio para eventos privados.', '#7B5C8D', 40, 0,
   'La piscina no está incluida en la reserva. Retirar toda decoración y dejar el espacio limpio y ordenado. Los daños son responsabilidad del residente que reserva.');

INSERT INTO area_reservation_rules (area_id) VALUES
  ('area-bbq'),
  ('area-spa'),
  ('area-clubhouse');

INSERT INTO area_time_slots (id, area_id, name, starts_at, ends_at, display_order) VALUES
  ('slot-bbq-morning', 'area-bbq', 'Mañana', '09:00', '16:00', 1),
  ('slot-bbq-evening', 'area-bbq', 'Tarde', '17:00', '22:00', 2);
