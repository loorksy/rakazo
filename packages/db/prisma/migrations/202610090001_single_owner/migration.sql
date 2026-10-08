ALTER TABLE deployment_settings
  ADD COLUMN "singleOwnerEnforced" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ownerBootstrapCompleted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ownerBootstrapProofHash" TEXT;

-- Claim and user insertion share a transaction. The singleton row serializes
-- API processes; no race can admit a second human. Ownership survives deletion.
CREATE FUNCTION enforce_trading_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE settings deployment_settings%ROWTYPE;
BEGIN
  IF lower(NEW.email) LIKE '%@messaging.invalid' THEN RETURN NEW; END IF;
  SELECT * INTO settings FROM deployment_settings WHERE id = 'default' FOR UPDATE;
  IF NOT FOUND OR NOT settings."singleOwnerEnforced" THEN RETURN NEW; END IF;
  IF settings."ownerBootstrapCompleted" OR settings."ownerUserId" IS NOT NULL OR
     EXISTS (SELECT 1 FROM "user" WHERE lower(email) NOT LIKE '%@messaging.invalid') THEN
    RAISE EXCEPTION 'Owner registration is closed' USING ERRCODE = '23514';
  END IF;
  UPDATE deployment_settings SET "ownerUserId" = NEW.id,
    "ownerBootstrapCompleted" = true, "ownerBootstrapProofHash" = NULL,
    "signupsEnabled" = false WHERE id = 'default';
  RETURN NEW;
END $$;
CREATE TRIGGER trading_owner_insert BEFORE INSERT ON "user"
  FOR EACH ROW EXECUTE FUNCTION enforce_trading_owner();

-- Updating a non-human service identity must not create another human owner.
CREATE FUNCTION prevent_trading_identity_conversion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF lower(OLD.email) LIKE '%@messaging.invalid' AND
     lower(NEW.email) NOT LIKE '%@messaging.invalid' AND
     EXISTS (SELECT 1 FROM deployment_settings WHERE id = 'default' AND "singleOwnerEnforced") THEN
    RAISE EXCEPTION 'Service identities cannot become human owners' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trading_identity_update BEFORE UPDATE OF email ON "user"
  FOR EACH ROW EXECUTE FUNCTION prevent_trading_identity_conversion();
