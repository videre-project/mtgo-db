# Database Dumps

Place your PostgreSQL dump files in this directory for **automatic import** during database initialization.

> [!NOTE]
> This directory is ignored by git to prevent accidentally committing sensitive database dumps.

## Quick Start

1. **Export your database:**

   ```bash
   # Example: Export from a remote database (e.g. Neon)
   pg_dump --clean --if-exists --format=plain \
     --file "postgres/dump/mtgo_dump.sql" \
     "postgresql://user:password@host:port/database?sslmode=require"
   ```

2. **Reset your local database (if needed):**

   ```bash
   docker compose down -v
   ```

3. **Start the database:**

   ```bash
   pnpm start
   ```

   The dump will be imported automatically. You can check the logs to verify this:

   ```bash
   docker logs postgres-prod | grep "dump"
   ```

## Automatic Import

Any `.sql` files placed in this directory will be automatically imported when you:

1. Start the database for the first time: `pnpm start`
2. Reset and restart: `docker compose down -v && pnpm start`

The import process:

- Runs during Docker's initialization phase (only on fresh volumes)
- Handles owner/role mismatches automatically
- Supports dumps with `--clean --if-exists` flags
- Filters out harmless warnings

> [!NOTE]
> Automatic import only runs during first-time initialization. If your dump includes `--clean --if-exists` flags (from `pg_dump`), it will safely drop and recreate tables. To reimport, use `docker compose down -v` to reset the database before running `pnpm start`.

## Supported Formats

- `.sql` - Plain text SQL dumps (from `pg_dump --format=plain`)
- `.dump` - Custom format dumps (from `pg_dump --format=custom`)
- `.tar` - Tar archive dumps (from `pg_dump --format=tar`)

> [!NOTE]
> Automatic import is only available for `.sql` files during first-time initialization. Other formats (`.dump`, `.tar`) require manual import as described in the main [README.md](../../README.md#importing-data-from-a-dump).

## Verification

After the database starts, verify that the database dump was imported correctly:

```bash
# Check table count
docker exec postgres-prod psql -U videre1 -d mtgo-db1 -c "\dt"

# Check row counts
docker exec postgres-prod psql -U videre1 -d mtgo-db1 -c "
  SELECT 'events' as table_name, COUNT(*) as row_count FROM events
  UNION ALL SELECT 'matches', COUNT(*) FROM matches
  UNION ALL SELECT 'decks', COUNT(*) FROM decks
  ORDER BY table_name;
"
```

## Troubleshooting

**Import didn't run?**

- Ensure the file has a `.sql` extension
- Check that you used `docker compose down -v` to reset the volume
- View logs: `docker logs postgres-prod`

**"Role does not exist" errors?**

- These are harmless and filtered automatically
- The script replaces owner statements with your `POSTGRES_USER`

**Need to reimport?**

- Stop containers: `docker compose down -v`
- Update your dump file in `postgres/dump/`
- Restart: `pnpm start`

## Manual Import

For manual imports to a running database, see the main [README.md](../../README.md#importing-data-from-a-dump).
