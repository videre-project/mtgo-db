-- Derived database helpers over the base event and card catalog schemas.

CREATE OR REPLACE FUNCTION api_numeric_text_value(value_filter TEXT)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN value_filter ~ '^[+-]?[0-9]+([.][0-9]+)?$' THEN value_filter::numeric
    ELSE NULL
  END
$function$;

CREATE OR REPLACE FUNCTION api_card_type_masks()
RETURNS TABLE(type_name TEXT, type_bit INT)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT type_name, type_bit
  FROM card_type_constants()
$function$;

CREATE OR REPLACE FUNCTION api_card_type_mask(types JSONB)
RETURNS INT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT coalesce(bit_or(type_bit), 0)
  FROM api_card_type_masks()
  WHERE coalesce(types, '[]'::jsonb) ? type_name
$function$;

ALTER TABLE oracle_cards
  ADD COLUMN IF NOT EXISTS card_type_mask INTEGER
    GENERATED ALWAYS AS (api_card_type_mask(card_types)) STORED;

ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS printed_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS printed_name_normalized TEXT
    GENERATED ALWAYS AS (lower(coalesce(printed_name, ''))) STORED,
  ADD COLUMN IF NOT EXISTS card_type_mask INTEGER
    GENERATED ALWAYS AS (api_card_type_mask(card_types)) STORED;

ALTER TABLE card_faces
  ADD COLUMN IF NOT EXISTS printed_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS printed_name_normalized TEXT
    GENERATED ALWAYS AS (lower(coalesce(printed_name, ''))) STORED,
  ADD COLUMN IF NOT EXISTS card_type_mask INTEGER
    GENERATED ALWAYS AS (api_card_type_mask(card_types)) STORED;

DROP VIEW IF EXISTS api_card_search_attributes;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'cards'
      AND column_name = 'search_vector'
      AND generation_expression NOT ILIKE '%printed_name%'
  ) THEN
    ALTER TABLE cards DROP COLUMN search_vector;
    ALTER TABLE cards ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
      setweight(to_tsvector('english'::regconfig, coalesce(name, '')), 'A') ||
      setweight(to_tsvector('english'::regconfig, coalesce(printed_name, '')), 'A') ||
      setweight(to_tsvector('english'::regconfig, coalesce(type_line, '')), 'B') ||
      setweight(to_tsvector('english'::regconfig, coalesce(oracle_text, '')), 'C') ||
      setweight(to_tsvector('english'::regconfig, coalesce(flavor_text, '')), 'D')
    ) STORED;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'card_faces'
      AND column_name = 'search_vector'
      AND generation_expression NOT ILIKE '%printed_name%'
  ) THEN
    ALTER TABLE card_faces DROP COLUMN search_vector;
    ALTER TABLE card_faces ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
      setweight(to_tsvector('english'::regconfig, coalesce(name, '')), 'A') ||
      setweight(to_tsvector('english'::regconfig, coalesce(printed_name, '')), 'A') ||
      setweight(to_tsvector('english'::regconfig, coalesce(type_line, '')), 'B') ||
      setweight(to_tsvector('english'::regconfig, coalesce(oracle_text, '')), 'C') ||
      setweight(to_tsvector('english'::regconfig, coalesce(flavor_text, '')), 'D')
    ) STORED;
  END IF;
END $$;

CREATE OR REPLACE VIEW api_card_search_attributes AS
SELECT
  c.id AS card_id,
  FALSE AS is_face,
  0 AS face_index,
  c.name_normalized,
  c.printed_name_normalized,
  c.search_vector,
  c.type_line,
  c.oracle_text,
  c.artist,
  c.flavor_text,
  c.mana_cost,
  c.art_id,
  c.power,
  c.toughness,
  c.loyalty,
  c.defense,
  c.card_types,
  c.supertypes,
  c.subtypes,
  c.card_type_mask
FROM cards c
UNION ALL
SELECT
  cf.card_id,
  TRUE AS is_face,
  cf.face_index,
  cf.name_normalized,
  cf.printed_name_normalized,
  cf.search_vector,
  cf.type_line,
  cf.oracle_text,
  cf.artist,
  cf.flavor_text,
  cf.mana_cost,
  cf.art_id,
  cf.power,
  cf.toughness,
  cf.loyalty,
  cf.defense,
  cf.card_types,
  cf.supertypes,
  cf.subtypes,
  cf.card_type_mask
FROM card_faces cf;
