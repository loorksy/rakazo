-- CreateTable
CREATE TABLE "chart_indicator_definitions" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "definitionHash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "originalFilename" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chart_indicator_definitions_pkey" PRIMARY KEY ("id","version")
);

-- CreateIndex
CREATE INDEX "chart_indicator_definitions_ownerUserId_createdAt_idx" ON "chart_indicator_definitions"("ownerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "chart_indicator_definitions_ownerUserId_definitionHash_idx" ON "chart_indicator_definitions"("ownerUserId", "definitionHash");

-- A historical definition is never edited in place, including trusted backend mistakes.
CREATE FUNCTION reject_chart_indicator_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Indicator definitions are immutable';
END;
$$;
CREATE TRIGGER chart_indicator_immutable BEFORE UPDATE ON chart_indicator_definitions
FOR EACH ROW EXECUTE FUNCTION reject_chart_indicator_update();
