\set ON_ERROR_STOP on

-- Event schema expansion needed for historical MTGO data.
--
-- This migration is intentionally additive except for relaxing Standings.rank
-- to allow source result rows that have records but no reliable placement.
-- It was restore-tested against a cloned mtgo-db database before being applied
-- to the live local database.

CREATE OR REPLACE FUNCTION event_type_constants()
RETURNS TABLE(event_name TEXT)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  VALUES
    ('League'),
    ('Preliminary'),
    ('Challenge'),
    ('Showcase'),
    ('Qualifier'),
    ('Daily'),
    ('Premier'),
    ('Championship')
$function$;

CREATE OR REPLACE FUNCTION format_type_constants()
RETURNS TABLE(format_name TEXT)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  VALUES
    ('Standard'),
    ('Modern'),
    ('Pioneer'),
    ('Vintage'),
    ('Legacy'),
    ('Pauper'),
    ('Premodern'),
    ('Extended'),
    ('Classic')
$function$;

DO $$
DECLARE
  event_name TEXT;
  expected_event_types TEXT[];
  actual_event_types TEXT[];
BEGIN
  FOR event_name IN
    SELECT value
    FROM event_type_constants() AS events(value)
  LOOP
    EXECUTE format('ALTER TYPE EventType ADD VALUE IF NOT EXISTS %L', event_name);
  END LOOP;

  SELECT array_agg(value ORDER BY ordinality)
  INTO expected_event_types
  FROM event_type_constants() WITH ORDINALITY AS events(value, ordinality);

  SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
  INTO actual_event_types
  FROM pg_enum e
  INNER JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'eventtype';

  IF actual_event_types IS DISTINCT FROM expected_event_types THEN
    RAISE EXCEPTION 'EventType enum drift: expected %, got %',
      expected_event_types,
      actual_event_types;
  END IF;
END
$$;

ALTER TYPE FormatType ADD VALUE IF NOT EXISTS 'Extended';
ALTER TYPE FormatType ADD VALUE IF NOT EXISTS 'Classic';

ALTER TABLE Standings ALTER COLUMN rank DROP NOT NULL;

-- Optional source/provenance marker for selected archetype labels (for example
-- mtggoldfish, mtgtop8, mtgo-stats, mtgpulse, deckcheck). This marks the source
-- of the stored label, not whether the row is suitable for canonical metagame
-- aggregation; archetype_id remains that signal.
--
-- Existing mtgo-db rows with archetype/archetype_id came from the
-- MTGGoldfish-backed live pipeline. Keep the repair UPDATE outside the
-- column-add branch so rerunning this migration fixes databases where the column
-- was added before this backfill was finalized.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'archetypes'
      AND column_name = 'provider'
  ) THEN
    ALTER TABLE Archetypes ADD COLUMN provider TEXT NULL;
  END IF;
END $$;

UPDATE Archetypes
SET provider = 'mtggoldfish'
WHERE provider IS NULL
  AND (archetype IS NOT NULL OR archetype_id IS NOT NULL);

-- Older historical MTGGoldfish labels are imported with provider already set.
-- This scoped repair covers pre-provider live mtgo-db rows written by MTGOBot
-- starting in Nov. 2022, where MTGGoldfish supplied a name-only label but no
-- mapped archetype/archetype_id.
UPDATE Archetypes a
SET provider = 'mtggoldfish'
FROM Decks d
INNER JOIN Events e ON e.id = d.event_id
WHERE a.provider IS NULL
  AND a.deck_id = d.id
  AND a.name IS NOT NULL
  AND a.archetype IS NULL
  AND a.archetype_id IS NULL
  AND e.date >= DATE '2022-11-01'
  AND e.kind IN ('Challenge', 'Preliminary', 'Qualifier', 'Showcase');
