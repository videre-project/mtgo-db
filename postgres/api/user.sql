-- API-facing readers share one grant role, while each login keeps its own
-- connection/resource policy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'api_reader'
  ) THEN
    CREATE ROLE api_reader NOLOGIN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'api'
  ) THEN
    CREATE USER api WITH PASSWORD 'replace_with_a_strong_password';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'public_api'
  ) THEN
    CREATE USER public_api;
  END IF;
END
$$;

ALTER ROLE api_reader WITH
  NOLOGIN
  NOREPLICATION
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE;

-- Service role for videre-api and other first-party consumers. This remains
-- read-only by privilege, but avoids the stricter public connection limits.
ALTER ROLE api WITH
  LOGIN
  NOREPLICATION
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  CONNECTION LIMIT -1;

ALTER ROLE api SET statement_timeout = '10s';
ALTER ROLE api RESET default_transaction_read_only;
ALTER ROLE api RESET idle_in_transaction_session_timeout;
ALTER ROLE api RESET idle_session_timeout;
ALTER ROLE api RESET lock_timeout;
ALTER ROLE api RESET temp_file_limit;
ALTER ROLE api RESET work_mem;

-- Anonymous public SQL role. Pgpool/HBA can trust this login because the role
-- itself is constrained to read-only, bounded exploratory access.
ALTER ROLE public_api WITH
  LOGIN
  NOREPLICATION
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  CONNECTION LIMIT 20;

ALTER ROLE public_api SET default_transaction_read_only = on;
ALTER ROLE public_api SET statement_timeout = '5s';
ALTER ROLE public_api SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE public_api SET idle_session_timeout = '60s';
ALTER ROLE public_api SET lock_timeout = '500ms';
ALTER ROLE public_api SET temp_file_limit = '64MB';
ALTER ROLE public_api SET work_mem = '4MB';

GRANT api_reader TO api;
GRANT api_reader TO public_api;

REVOKE ALL PRIVILEGES ON DATABASE mtgo FROM api, public_api, api_reader;
GRANT CONNECT ON DATABASE mtgo TO api_reader;

REVOKE ALL PRIVILEGES ON SCHEMA public FROM api, public_api, api_reader;
GRANT USAGE ON SCHEMA public TO api_reader;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM api, public_api, api_reader;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM api, public_api, api_reader;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM api, public_api, api_reader;

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
  catalog_items,
  catalog_price_definitions,
  catalog_price_history,
  cards,
  decks,
  events,
  formats,
  matches,
  oracle_cards,
  players,
  products,
  sets,
  standings
TO api_reader;

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
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO api_reader', api_function);
  END LOOP;
END
$$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM public_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM api_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
