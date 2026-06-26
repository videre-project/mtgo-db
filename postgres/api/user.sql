-- The API role can read public data and execute stable read-only helpers, but
-- it does not own or mutate schema objects.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'api'
  ) THEN
    CREATE USER api WITH PASSWORD 'replace_with_a_strong_password';
  END IF;
END
$$;

ALTER ROLE api WITH LOGIN NOREPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE api SET statement_timeout = '10s';

REVOKE ALL PRIVILEGES ON DATABASE mtgo FROM api;
GRANT CONNECT ON DATABASE mtgo TO api;

REVOKE ALL PRIVILEGES ON SCHEMA public FROM api;
GRANT USAGE ON SCHEMA public TO api;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM api;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM api;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM api;

DO $$
DECLARE
  app_function regprocedure;
BEGIN
  FOR app_function IN
    SELECT p.oid::regprocedure
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_catalog.pg_depend d
      ON d.classid = 'pg_catalog.pg_proc'::regclass
     AND d.objid = p.oid
     AND d.deptype = 'e'
    WHERE n.nspname = 'public'
      AND d.objid IS NULL
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC', app_function);
  END LOOP;
END
$$;

GRANT SELECT ON TABLE
  archetypes,
  card_catalog_variants,
  card_faces,
  card_legalities,
  cards,
  decks,
  events,
  matches,
  oracle_cards,
  products,
  sets,
  standings
TO api;

DO $$
DECLARE
  api_function regprocedure;
BEGIN
  FOR api_function IN
    SELECT p.oid::regprocedure
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (
        p.proname LIKE 'api\_%' ESCAPE '\'
        OR p.proname IN (
          'card_color_constants',
          'card_rarity_alias_constants',
          'card_rarity_constants',
          'card_type_constants',
          'cdn_card_image_base_url',
          'cdn_product_image_base_url'
        )
      )
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO api', api_function);
  END LOOP;
END
$$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
