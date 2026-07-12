# MTGO-DB Replica Dumps

This branch (`replica-data`) hosts **monthly, per-table dumps** of the public MTGO-DB database, so users can maintain their own replica of the data they care about from the production database.

Each month is a directory named `YYYY-MM` containing one gzip-compressed CSV dump per table. Three profiles are published where data exists for that month:

- **events** (2008-09 → present): `events`, `matches`, `decks`, `standings`, `archetypes`, `players`
- **prices** (2023-01 → present): `catalog_items`, `catalog_price_definitions`, `catalog_price_history`
- **cards** (1993-08 → present, bucketed by set release date): `sets`, `cards`, `products`, `card_catalog_variants`, `card_faces`, `oracle_cards`, `formats`, `card_legalities`

```
2008-09/
  events.dump.gz
  matches.dump.gz
  decks.dump.gz
  standings.dump.gz
  archetypes.dump.gz
  players.dump.gz
1993-08/                # cards profile: a set released this month
  sets.dump.gz
  cards.dump.gz
  products.dump.gz
  card_catalog_variants.dump.gz
  card_faces.dump.gz
  oracle_cards.dump.gz  # only oracles whose FIRST printing is in 1993-08
  formats.dump.gz
  card_legalities.dump.gz
2023-01/
  ... (events + prices profiles, if any)
  ... (cards profile, if any set released this month)
2026-06/
  ...
INDEX.json
```

`INDEX.json` lists every published month, the profiles it contains, its commit, and per-table file sizes.

## How to consume

### Option A — as a git submodule (recommended)

The main `mtgo-db` repository mounts this branch as a submodule at
`postgres/dump/replica/`. After cloning mtgo-db:

```sh
git submodule update --init
# dumps now live at postgres/dump/replica/2008-09/...
```

To pull new months later:

```sh
git submodule update --remote postgres/dump/replica
```

### Option B — clone this branch directly

```sh
git clone --branch replica-data --single-branch \
  https://github.com/videre-project/mtgo-db.git mtgo-replica
```

Because each month is committed with a **backdated author/committer date** (`YYYY-MM-01`), you can filter the branch history by date:

```sh
git log --since=2009-03 --until=2010-01 --oneline
```

## Restoring a month

The dumps are gzip-compressed, headerless CSV. Each month's
`REPLICA-MANIFEST.json` records the exact writable columns and their order;
generated PostgreSQL columns are deliberately omitted and recomputed by the
target database. Always pass the manifest's column list to `COPY`.

For example, to load `events` from one month:

```sh
columns=$(jq -r '.tables[] | select(.name == "events") | .columns | map("\\\"" + . + "\\\"") | join(",")' \
  2026-06/REPLICA-MANIFEST.json)
gunzip -c 2026-06/events.dump.gz | \
  psql -d <your-db> -c "COPY events ($columns) FROM STDIN WITH (FORMAT csv)"
```

Load months in chronological order. `players`, `catalog_items`,
`catalog_price_definitions`, and `formats` are repeated reference data; load
them once or COPY through a staging table and upsert into the destination.
PostgreSQL `COPY` itself does not support `ON CONFLICT`.

### Cards profile layout

Cards are organized by **set release date**, not by when we ingested them:

- `sets` is the spine — each set is dumped into the month of its `release_date`.
- `cards`, `products`, `card_catalog_variants`, `card_faces` are pulled in via `set_code` (the set released that month).
- `oracle_cards` is emitted into the month of each oracle identity's **first appearance** (the earliest set that prints it), so restoring months in order accumulates each oracle row exactly once at the point it first shows up.
- `card_legalities` follows the same first-appearance partition as its oracle, preserving foreign-key closure during chronological restores.
- `formats` is repeated reference data and may be loaded once.

Because card data is **mutable** (erratas and migrations can change past rows), the cards profile is a *point-in-time baseline*, not an immutable history. Corrected historical month directories are replaced by later commits on this branch. Re-pull the branch and upsert changed months, or rebuild the cards baseline when exact deletion/move reconciliation is required. For day-to-day currency after a baseline, use the incremental sync below.

## Keeping current after a baseline

Once you have a baseline (this branch, or the full `replica-dump` snapshot from the main repo), stay current with the incremental sync against the public read-only role:

```sh
# events bundle:
pnpm run replica-sync "<your-connection-string>" --profile events --since "<watermark>"
# prices bundle:
pnpm run replica-sync "<your-connection-string>" --profile prices --since "<watermark>"
# cards bundle (full upsert of reference + changed rows):
pnpm run replica-sync "<your-connection-string>" --profile cards --since "<watermark>"
```

See `PUBLIC-API.md` in the main repo for how to connect as `public_api` via the Cloudflare Tunnel bridge.

## Notes

- The **current (in-progress) month is excluded** from these dumps; it appears once complete in the next publish cycle.
- Three profiles are published per month where data exists: **events** (2008-09+), **prices** (2023-01+), and **cards** (1993-08+, bucketed by set release date). `INDEX.json` records which profiles each month contains.
- Dumps are generated from the read replica, so they never place load on the primary.
