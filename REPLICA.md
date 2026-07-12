# Running an MTGO-DB Replica

MTGO-DB publishes a versioned, monthly baseline on the orphan
[`replica-data`](https://github.com/videre-project/mtgo-db/tree/replica-data) branch. The main repository mounts that branch at `postgres/dump/replica` as a Git submodule. Use the baseline for bulk history, then use the bounded `public_api` connection for incremental updates.

## Requirements

- Git with submodule support.
- Node.js 22.6 or newer and pnpm.
- PostgreSQL 17 or newer, including the `psql` client.
- `cloudflared` for incremental synchronization from the public database.

The target database belongs to you. The scripts only read from the `public_api` role and write to the target connection string you provide.

## Clone the baseline

For a new clone:

```sh
git clone --recurse-submodules https://github.com/videre-project/mtgo-db.git
cd mtgo-db
pnpm install
```

For an existing checkout:

```sh
git submodule update --init postgres/dump/replica
pnpm install
```

The submodule contains one directory per published month, plus `INDEX.json`.
Each `REPLICA-MANIFEST.json` records the profiles, files, writable PostgreSQL
columns, and file sizes for that month.

## Create the target schema

Create an empty database, set `TARGET_DATABASE_URL`, and initialize the schema:

```sh
export TARGET_DATABASE_URL='postgresql://user:password@127.0.0.1:5432/mtgo_replica'

psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f postgres/extensions.sql \
  -f postgres/constants.sql \
  -f postgres/schemas/events.sql \
  -f postgres/schemas/cards.sql \
  -f postgres/api/objects.sql \
  -f postgres/indexes.sql
```

Run these commands as a role allowed to create extensions, types, tables, functions, and indexes in the target database. Do not apply `postgres/api/user.sql`; that file configures Videre's hosted roles and is not needed by a downstream replica.

## Restore the monthly baseline

Restore every profile into a fresh database:

```sh
pnpm run replica-restore "$TARGET_DATABASE_URL" --profile all
```

Or restore only the data you need:

```sh
pnpm run replica-restore "$TARGET_DATABASE_URL" --profile events
pnpm run replica-restore "$TARGET_DATABASE_URL" --profile prices
pnpm run replica-restore "$TARGET_DATABASE_URL" --profile cards
```

The restore command processes months chronologically, loads tables in foreign key order, omits generated columns, and upserts through temporary tables. A fresh cards database must be restored from the beginning because a later printing can reference an oracle identity introduced in an earlier month.

This carries the limitation that `--from` should only be used when updating an existing replica and not for bootstrapping an isolated month.

To restore a bounded range into an existing replica:

```sh
pnpm run replica-restore "$TARGET_DATABASE_URL" \
  --profile events --from 2025-01 --to 2025-12
```

## Connect to `public_api`

The supported public hostname is:

```text
public-db.videreproject.com
```

Cloudflare TCP access requires a local bridge. Keep this running in a separate terminal; choose any unused local port:

```sh
cloudflared access tcp \
  --hostname public-db.videreproject.com \
  --url 127.0.0.1:15432
```

Verify the passwordless, read-only connection:

```sh
psql 'postgresql://public_api@127.0.0.1:15432/mtgo?sslmode=disable' \
  -c 'SELECT max(date) FROM events'
```

`public_api` has short statement and idle timeouts and is intended for bounded incremental reads. We advist against using it to repeatedly export the full database as that is what the monthly replica branch is intended for. See [PUBLIC-API.md](PUBLIC-API.md) for the complete access policy.

## Synchronize after the baseline

Point the sync script at the local Cloudflare bridge with environment variables and pass your database as the target:

```sh
export API_DB_HOST=127.0.0.1
export API_DB_PORT=15432
export API_DB_DATABASE=mtgo
export API_DB_USER=public_api
export API_DB_SSL=false

pnpm run replica-sync "$TARGET_DATABASE_URL" --profile events
pnpm run replica-sync "$TARGET_DATABASE_URL" --profile cards
pnpm run replica-sync "$TARGET_DATABASE_URL" \
  --profile prices --since 2026-07-01T00:00:00Z
```

The profiles behave differently:

- `events` pulls events with IDs above the local maximum, then their dependent matches, decks, standings, archetypes, and players.
- `prices` upserts reference data and pulls price history on or after the date supplied with `--since`. Always supply the last successful price-sync time.
- `cards` pages through the complete public cards surface and upserts it This is intended as errata and migrations can change historical rows.

The sync scripts upsert rows but do not delete local rows that disappeared from the source. For exact reconciliation after a card identity moves or is deleted, rebuild the cards profile from the latest monthly baseline.

## Pull monthly baseline updates

Record the old submodule commit, update it, and inspect which month directories changed:

```sh
old=$(git -C postgres/dump/replica rev-parse HEAD)
git submodule update --remote postgres/dump/replica
new=$(git -C postgres/dump/replica rev-parse HEAD)

git -C postgres/dump/replica diff --name-only "$old" "$new"
```

New event and price months can also be restored directly. Though because cards are mutable, historical month directories may also change retroactively. To replay each changed month into an existing replica, or rerun the full cards profile when exact reconciliation is required:

```sh
pnpm run replica-restore "$TARGET_DATABASE_URL" \
  --profile all --from 2026-06 --to 2026-06
```

Monthly commits are authored and committed with the month they represent, so the submodule history can be filtered by date:

```sh
git -C postgres/dump/replica log \
  --since=2025-01-01 --until=2025-12-31 --oneline
```

Corrections to an already-published month retain their actual correction date, so Git history distinguishes the original publication of card data from later erratas.

## Maintainer workflow

The publication commands are primarily intended for maintainers or contributors to the Videre Project with access to the source containers and repository remote:

```sh
pnpm run replica-backfill
pnpm run replica-validate
pnpm run replica-publish -- --push
```

The `replica-backfill` script excludes the in-progress month by default, whereas the `replica-validate` script performs a dry-run that checks gzip integrity, manifests, source totals, primary-key uniqueness,
monthly card partitions, and real PostgreSQL restore contracts before
publication.
