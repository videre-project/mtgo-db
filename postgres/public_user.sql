-- Create a read-only user for public access and replication
CREATE USER public_user WITH REPLICATION PASSWORD 'replace_with_a_strong_password';

-- Grant connect access to the database
GRANT CONNECT ON DATABASE postgres TO public_user;

-- Grant usage on the public schema
GRANT USAGE ON SCHEMA public TO public_user;

-- Grant select on all existing tables in the public schema
GRANT SELECT ON ALL TABLES IN SCHEMA public TO public_user;

-- Grant select on future tables in the public schema
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO public_user;
