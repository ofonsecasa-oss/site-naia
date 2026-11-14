CREATE TABLE unit_area_reservation_locks (
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  area_id TEXT NOT NULL REFERENCES reservable_areas(id) ON DELETE CASCADE,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (unit_id, area_id)
);

INSERT INTO unit_area_reservation_locks (unit_id, area_id, reservation_id)
SELECT r.unit_id, r.area_id, r.id
  FROM reservations r
 WHERE r.status IN ('pending', 'confirmed')
   AND datetime(r.reservation_date || 'T' || r.ends_at || ':00-06:00') > datetime('now')
   AND r.id = (
     SELECT current.id
       FROM reservations current
      WHERE current.unit_id = r.unit_id
        AND current.area_id = r.area_id
        AND current.status IN ('pending', 'confirmed')
        AND datetime(current.reservation_date || 'T' || current.ends_at || ':00-06:00') > datetime('now')
      ORDER BY current.reservation_date, current.starts_at, current.created_at
      LIMIT 1
   );
