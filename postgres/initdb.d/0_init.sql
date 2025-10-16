-- Initialize database schema and extensions
-- Note: This file runs before dump imports (1_migrate.sh)
-- Comment out schema.sql and indexes.sql if using a dump that includes them

\i /pg/extensions.sql
\i /pg/schema.sql
\i /pg/indexes.sql
\i /pg/api_user.sql
