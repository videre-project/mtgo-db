\set ON_ERROR_STOP on

-- Hydrated MTGO product text. CardExporter resolves this from the product
-- object's OracleTextId; for Vanguard avatar products this is rules text.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS description TEXT NULL;

DROP INDEX IF EXISTS idx_products_search;

ALTER TABLE products
  DROP COLUMN IF EXISTS search_vector;

ALTER TABLE products
  ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(object_type, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_products_search ON products USING GIN (search_vector);
