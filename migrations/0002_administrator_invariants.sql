-- Database-level safety net: API checks provide friendly errors, while these
-- triggers prevent concurrent or future code paths from leaving Naia without
-- an active administrator.

CREATE TRIGGER prevent_last_active_administrator_role_removal
BEFORE DELETE ON person_roles
WHEN OLD.role_key = 'administrator'
  AND EXISTS (
    SELECT 1 FROM people
     WHERE id = OLD.person_id AND status = 'active'
  )
  AND (
    SELECT COUNT(*)
      FROM person_roles pr
      JOIN people p ON p.id = pr.person_id
     WHERE pr.role_key = 'administrator' AND p.status = 'active'
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_administrator');
END;

CREATE TRIGGER prevent_last_active_administrator_deactivation
BEFORE UPDATE OF status ON people
WHEN OLD.status = 'active'
  AND NEW.status <> 'active'
  AND EXISTS (
    SELECT 1 FROM person_roles
     WHERE person_id = OLD.id AND role_key = 'administrator'
  )
  AND (
    SELECT COUNT(*)
      FROM person_roles pr
      JOIN people p ON p.id = pr.person_id
     WHERE pr.role_key = 'administrator' AND p.status = 'active'
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_administrator');
END;

CREATE TRIGGER prevent_last_active_administrator_deletion
BEFORE DELETE ON people
WHEN OLD.status = 'active'
  AND EXISTS (
    SELECT 1 FROM person_roles
     WHERE person_id = OLD.id AND role_key = 'administrator'
  )
  AND (
    SELECT COUNT(*)
      FROM person_roles pr
      JOIN people p ON p.id = pr.person_id
     WHERE pr.role_key = 'administrator' AND p.status = 'active'
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_administrator');
END;
