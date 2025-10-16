-- Create a read-only user for API access and replication
CREATE USER api WITH REPLICATION PASSWORD 'replace_with_a_strong_password';

-- Grant connect access to the database
GRANT CONNECT ON DATABASE mtgo TO api;

-- Grant usage on the public schema
GRANT USAGE ON SCHEMA public TO api;

-- Grant select on all existing tables in the public schema
GRANT SELECT ON ALL TABLES IN SCHEMA public TO api;

-- Grant select on future tables in the public schema
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO api;
