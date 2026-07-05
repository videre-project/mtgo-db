-- Shared editable constants used by event data, card catalog data, and API helpers.

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

CREATE OR REPLACE FUNCTION card_type_constants()
RETURNS TABLE(type_name TEXT, type_bit INT)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  VALUES
    ('Artifact',        1),
    ('Creature',        2),
    ('Enchantment',     4),
    ('Instant',         8),
    ('Land',           16),
    ('Planeswalker',   32),
    ('Sorcery',        64),
    ('Battle',        128),
    ('Kindred',       256)
$function$;

CREATE OR REPLACE FUNCTION card_color_constants()
RETURNS TABLE(color_symbol TEXT, color_name TEXT, color_bit INT)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  VALUES
    ('W', 'WHITE', 1),
    ('U', 'BLUE',  2),
    ('B', 'BLACK', 4),
    ('R', 'RED',   8),
    ('G', 'GREEN', 16)
$function$;

CREATE OR REPLACE FUNCTION card_rarity_constants()
RETURNS TABLE(rarity_name TEXT, rarity_rank INT)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  VALUES
    ('common',   1),
    ('uncommon', 2),
    ('rare',     3),
    ('mythic',   4)
$function$;

CREATE OR REPLACE FUNCTION card_rarity_alias_constants()
RETURNS TABLE(rarity_alias TEXT, rarity_name TEXT)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  VALUES
    ('c',           'common'),
    ('u',           'uncommon'),
    ('r',           'rare'),
    ('m',           'mythic'),
    ('mythicrare',  'mythic'),
    ('mythic rare', 'mythic'),
    ('basic',       'basic land'),
    ('basicland',   'basic land')
$function$;

CREATE OR REPLACE FUNCTION cdn_card_image_base_url()
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT 'https://r2.videreproject.com/cards/'
$function$;

CREATE OR REPLACE FUNCTION cdn_product_image_base_url()
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT 'https://r2.videreproject.com/products/'
$function$;
