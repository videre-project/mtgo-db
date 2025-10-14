# Database Migration Guide

This guide explains how to migrate your MTGO-DB instance from one machine to another while preserving all data.

## Quick Migration Process

### On the Source Machine (Current Machine)

1. **Export your database:**

   ```bash
   pnpm export-dump
   ```

   This creates a dump file at `postgres/dump/mtgo_dump.sql` containing all your data.

2. **Commit or copy the repository:**

   **Option A - Using Git (recommended):**
   ```bash
   git add postgres/dump/mtgo_dump.sql
   git commit -m "Export database for migration"
   git push
   ```

   **Option B - Manual copy:**
   - Copy the entire repository folder to a USB drive or network location
   - Ensure `postgres/dump/mtgo_dump.sql` is included

### On the Target Machine (New Machine)

1. **Get the repository:**

   **Option A - Using Git:**
   ```bash
   git clone https://github.com/videre-project/mtgo-db.git
   cd mtgo-db
   ```

   **Option B - Manual copy:**
   - Copy the repository folder from your USB drive/network location

2. **Set up environment variables:**

   Copy `.env-example` to `.env` and configure your credentials:
   ```bash
   # Windows PowerShell
   Copy-Item .env-example .env
   
   # Then edit .env with your settings
   ```

3. **Install, setup, and start:**

   ```bash
   pnpm install && pnpm setup-tunnel && pnpm start
   ```

   That's it! The dump will be **automatically imported** on first startup. 🎉

## What Gets Migrated?

The export includes:
- ✓ All tables (events, players, matches, decks, standings, archetypes)
- ✓ All data and relationships
- ✓ Indexes and constraints
- ✓ Custom types and domains
- ✗ Extensions (automatically recreated from schema)

## Verification

After migration, verify the data:

```bash
# Check table counts
pnpm list-tables

# Or manually check
docker exec postgres-prod psql -U $POSTGRES_USER -d $POSTGRES_DB -c "
  SELECT 'events' as table, COUNT(*) as rows FROM events
  UNION ALL SELECT 'players', COUNT(*) FROM players
  UNION ALL SELECT 'matches', COUNT(*) FROM matches
  UNION ALL SELECT 'decks', COUNT(*) FROM decks
  UNION ALL SELECT 'standings', COUNT(*) FROM standings
  UNION ALL SELECT 'archetypes', COUNT(*) FROM archetypes
  ORDER BY table;
"
```

The row counts should match between source and target machines.

## Advanced: Custom Export Path

You can specify a custom export path:

```bash
# Export to a specific file
pnpm export-dump backups/backup-2025-10-13.sql

# Export to a different location
pnpm export-dump ../database-backups/production.sql
```

## Troubleshooting

### Export fails: "container is not running"

Start the database first:
```bash
pnpm start
# Wait for database to be healthy, then:
pnpm export-dump
```

### Import doesn't happen automatically

The import only runs on first initialization. Reset the volume:
```bash
docker compose down -v
pnpm start
```

### Different credentials on new machine

Update your `.env` file on the target machine before running `pnpm start`. The dump uses `--no-owner` and `--no-privileges` so it works with any credentials.

### Need to keep both databases running

Don't delete the dump file! You can:
1. Export again anytime: `pnpm export-dump`
2. Keep the dump file for backups
3. Import into multiple machines

## Backup Strategy

Consider regular backups:

```bash
# Weekly backup with timestamp
pnpm export-dump "backups/mtgo_dump_$(date +%Y%m%d).sql"
```

Add this to a cron job or scheduled task for automated backups.

## See Also

- [README.md](README.md) - General setup and usage
- [postgres/dump/README.md](postgres/dump/README.md) - Dump file details
- [scripts/export-dump.ts](scripts/export-dump.ts) - Export script source
- [scripts/import-dump.ts](scripts/import-dump.ts) - Manual import script
