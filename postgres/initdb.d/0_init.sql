-- Create the base database objects before optional dump imports run.
-- Dumps that already include schema objects should not be replayed with these
-- includes enabled.

\i /pg/extensions.sql
\i /pg/constants.sql
\i /pg/schemas/events.sql
\i /pg/schemas/cards.sql
\i /pg/api/objects.sql
\i /pg/indexes.sql
\i /pg/api/user.sql
