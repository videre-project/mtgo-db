-- Card catalog schema used by CardExporter and videre-api.
-- This file is safe to reapply because it only creates missing catalog objects.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS sets (
  code              TEXT PRIMARY KEY,
  name              TEXT NULL,
  release_date      DATE NULL,
  age               INTEGER NULL,
  set_type          TEXT NULL,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw               JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS oracle_cards (
  id                  UUID PRIMARY KEY,
  name                TEXT NULL,
  name_normalized     TEXT GENERATED ALWAYS AS (lower(coalesce(name, ''))) STORED,
  mana_cost           TEXT NULL,
  mana_value          NUMERIC NULL,
  type_line           TEXT NULL,
  oracle_text         TEXT NULL,
  colors              JSONB NOT NULL DEFAULT '[]'::jsonb,
  color_identity      JSONB NOT NULL DEFAULT '[]'::jsonb,
  color_mask          INTEGER NOT NULL DEFAULT 0,
  color_identity_mask INTEGER NOT NULL DEFAULT 0,
  supertypes          JSONB NOT NULL DEFAULT '[]'::jsonb,
  card_types          JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtypes            JSONB NOT NULL DEFAULT '[]'::jsonb,
  power               TEXT NULL,
  toughness           TEXT NULL,
  loyalty             TEXT NULL,
  defense             TEXT NULL,
  is_token            BOOLEAN NULL,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_vector       TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(type_line, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(oracle_text, '')), 'C')
  ) STORED
);

CREATE TABLE IF NOT EXISTS cards (
  id                INTEGER PRIMARY KEY,
  oracle_id         UUID NOT NULL REFERENCES oracle_cards (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  set_code          TEXT NULL REFERENCES sets (code) ON UPDATE CASCADE ON DELETE SET NULL,
  collector_number  TEXT NULL,
  name              TEXT NULL,
  name_normalized   TEXT GENERATED ALWAYS AS (lower(coalesce(name, ''))) STORED,
  art_id            INTEGER NULL,
  artist            TEXT NULL,
  card_texture_number INTEGER NULL,
  other_face_texture_number INTEGER NULL,
  split_card_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
  split_parent_card_id INTEGER NULL,
  split_other_card_id INTEGER NULL,
  colors            JSONB NOT NULL DEFAULT '[]'::jsonb,
  color_identity    JSONB NOT NULL DEFAULT '[]'::jsonb,
  color_mask        INTEGER NOT NULL DEFAULT 0,
  color_identity_mask INTEGER NOT NULL DEFAULT 0,
  mana_value        NUMERIC NULL,
  flavor_text       TEXT NULL,
  mana_cost         TEXT NULL,
  type_line         TEXT NULL,
  oracle_text       TEXT NULL,
  supertypes        JSONB NOT NULL DEFAULT '[]'::jsonb,
  card_types        JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtypes          JSONB NOT NULL DEFAULT '[]'::jsonb,
  power             TEXT NULL,
  toughness         TEXT NULL,
  loyalty           TEXT NULL,
  defense           TEXT NULL,
  rarity            TEXT NULL,
  frame_style       INTEGER NULL,
  promo_label       TEXT NULL,
  has_activated_ability BOOLEAN NULL,
  should_work       BOOLEAN NULL,
  is_foil           BOOLEAN NULL,
  is_token          BOOLEAN NULL,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw               JSONB NOT NULL DEFAULT '{}'::jsonb,
  search_vector     TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(type_line, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(oracle_text, '')), 'C') ||
    setweight(to_tsvector('english'::regconfig, coalesce(flavor_text, '')), 'D')
  ) STORED
);

CREATE TABLE IF NOT EXISTS products (
  id                  INTEGER PRIMARY KEY,
  set_code            TEXT NULL REFERENCES sets (code) ON UPDATE CASCADE ON DELETE SET NULL,
  name                TEXT NULL,
  name_normalized     TEXT GENERATED ALWAYS AS (lower(coalesce(name, ''))) STORED,
  object_type         TEXT NULL,
  texture_number      INTEGER NULL,
  is_tradable         BOOLEAN NULL,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  search_vector       TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(object_type, '')), 'B')
  ) STORED,
  CONSTRAINT chk_products_no_tokens CHECK (object_type IS NULL OR object_type <> 'TOKN')
);

CREATE TABLE IF NOT EXISTS card_catalog_variants (
  catalog_id          INTEGER PRIMARY KEY,
  card_id             INTEGER NOT NULL REFERENCES cards (id) ON UPDATE CASCADE ON DELETE CASCADE,
  variant_type        TEXT NOT NULL,
  set_code            TEXT NULL REFERENCES sets (code) ON UPDATE CASCADE ON DELETE SET NULL,
  name                TEXT NULL,
  name_normalized     TEXT GENERATED ALWAYS AS (lower(coalesce(name, ''))) STORED,
  card_texture_number INTEGER NULL,
  is_foil             BOOLEAN NULL,
  is_token            BOOLEAN NULL,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT chk_card_catalog_variants_not_self CHECK (catalog_id <> card_id)
);

CREATE TABLE IF NOT EXISTS card_faces (
  card_id           INTEGER NOT NULL REFERENCES cards (id) ON UPDATE CASCADE ON DELETE CASCADE,
  face_index        SMALLINT NOT NULL,
  source_catalog_id INTEGER NULL,
  name              TEXT NULL,
  name_normalized   TEXT GENERATED ALWAYS AS (lower(coalesce(name, ''))) STORED,
  colors            JSONB NOT NULL DEFAULT '[]'::jsonb,
  color_mask        INTEGER NOT NULL DEFAULT 0,
  mana_value        NUMERIC NULL,
  flavor_text       TEXT NULL,
  mana_cost         TEXT NULL,
  type_line         TEXT NULL,
  oracle_text       TEXT NULL,
  supertypes        JSONB NOT NULL DEFAULT '[]'::jsonb,
  card_types        JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtypes          JSONB NOT NULL DEFAULT '[]'::jsonb,
  power             TEXT NULL,
  toughness         TEXT NULL,
  loyalty           TEXT NULL,
  defense           TEXT NULL,
  artist            TEXT NULL,
  art_id            INTEGER NULL,
  raw               JSONB NOT NULL DEFAULT '{}'::jsonb,
  search_vector     TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(type_line, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(oracle_text, '')), 'C') ||
    setweight(to_tsvector('english'::regconfig, coalesce(flavor_text, '')), 'D')
  ) STORED,
  PRIMARY KEY (card_id, face_index)
);

CREATE TABLE IF NOT EXISTS formats (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  display_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS card_legalities (
  oracle_id          UUID NOT NULL REFERENCES oracle_cards (id) ON UPDATE CASCADE ON DELETE CASCADE,
  format_code        TEXT NOT NULL REFERENCES formats (code) ON UPDATE CASCADE ON DELETE CASCADE,
  status             TEXT NOT NULL CHECK (
    status IN ('legal', 'not_legal', 'banned', 'restricted', 'suspended')
  ),
  source_rule_set_id TEXT NULL,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (oracle_id, format_code)
);

CREATE TABLE IF NOT EXISTS pending_image_sync (
  catalog_id    INTEGER PRIMARY KEY,
  reason        TEXT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO formats (code, name, display_order)
SELECT
  lower(format_name),
  format_name,
  format_ordinal::integer * 10
FROM format_type_constants() WITH ORDINALITY AS formats(format_name, format_ordinal)
ORDER BY format_ordinal
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  display_order = EXCLUDED.display_order;
