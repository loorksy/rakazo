ALTER TABLE trading_mission_wakes ADD CONSTRAINT mission_wake_format CHECK ("formatVersion" = 1);
ALTER TABLE trading_mission_wakes ADD CONSTRAINT mission_wake_kind CHECK (kind IN ('START', 'REEVALUATE', 'EXPIRE'));
ALTER TABLE trading_mission_wakes ADD CONSTRAINT mission_wake_status CHECK (
  status IN ('WAITING', 'DELIVERY_NEEDED', 'QUEUED', 'COMPLETED', 'NEEDS_ATTENTION', 'COALESCED', 'CANCELLED')
);
ALTER TABLE trading_mission_wakes ADD CONSTRAINT mission_wake_receipt CHECK (
  (status IN ('COMPLETED', 'NEEDS_ATTENTION', 'COALESCED')) = ("completedAt" IS NOT NULL)
);
CREATE FUNCTION protect_mission_wake_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Mission wake receipt cannot be deleted'; END IF;
  IF ROW(NEW.id, NEW."formatVersion", NEW."mandateId", NEW."wakeKey", NEW.kind, NEW."dueAt", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD.id, OLD."formatVersion", OLD."mandateId", OLD."wakeKey", OLD.kind, OLD."dueAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'Mission wake identity is immutable';
  END IF;
  IF OLD."completedAt" IS NOT NULL AND ROW(NEW.status, NEW."completedAt", NEW."runId")
    IS DISTINCT FROM ROW(OLD.status, OLD."completedAt", OLD."runId") THEN
    RAISE EXCEPTION 'Mission wake receipt is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_mission_wake_identity BEFORE UPDATE OR DELETE ON trading_mission_wakes
  FOR EACH ROW EXECUTE FUNCTION protect_mission_wake_identity();
