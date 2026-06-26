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
  ADD COLUMN IF NOT EXISTS card_type_mask INTEGER
    GENERATED ALWAYS AS (api_card_type_mask(card_types)) STORED;

ALTER TABLE card_faces
  ADD COLUMN IF NOT EXISTS card_type_mask INTEGER
    GENERATED ALWAYS AS (api_card_type_mask(card_types)) STORED;
