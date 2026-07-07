\set ON_ERROR_STOP on

-- GoatBots price history storage.
--
-- The price feed is keyed by MTGO catalog ID, but those IDs can point at
-- cards, card catalog variants, or products. catalog_items provides one FK
-- target for that shared namespace.

CREATE TABLE IF NOT EXISTS catalog_items (
  catalog_id    INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('card', 'card_variant', 'product')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_price_definitions (
  source         TEXT NOT NULL,
  catalog_id     INTEGER NOT NULL REFERENCES catalog_items (catalog_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  source_name    TEXT NULL,
  source_cardset TEXT NULL,
  source_rarity  TEXT NULL,
  source_version TEXT NULL,
  source_foil    BOOLEAN NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw            JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (source, catalog_id)
);

CREATE TABLE IF NOT EXISTS catalog_price_history (
  source        TEXT NOT NULL,
  price_date    DATE NOT NULL,
  catalog_id    INTEGER NOT NULL REFERENCES catalog_items (catalog_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  sell_price    NUMERIC NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, price_date, catalog_id)
);

CREATE INDEX IF NOT EXISTS idx_catalog_items_kind ON catalog_items (kind);
CREATE INDEX IF NOT EXISTS idx_catalog_price_history_catalog_date ON catalog_price_history (catalog_id, price_date DESC);
CREATE INDEX IF NOT EXISTS idx_catalog_price_history_source_date ON catalog_price_history (source, price_date DESC);

WITH catalog_union AS (
  SELECT id AS catalog_id, 'card' AS kind, 3 AS priority FROM cards
  UNION ALL
  SELECT catalog_id, 'card_variant' AS kind, 2 AS priority FROM card_catalog_variants
  UNION ALL
  SELECT id AS catalog_id, 'product' AS kind, 1 AS priority FROM products
),
catalog_ranked AS (
  SELECT DISTINCT ON (catalog_id) catalog_id, kind
  FROM catalog_union
  ORDER BY catalog_id, priority
)
INSERT INTO catalog_items (catalog_id, kind, last_seen_at)
SELECT catalog_id, kind, now()
FROM catalog_ranked
ON CONFLICT (catalog_id) DO UPDATE SET
  kind = EXCLUDED.kind,
  last_seen_at = now();

GRANT SELECT ON TABLE
  catalog_items,
  catalog_price_definitions,
  catalog_price_history
TO api_reader;
