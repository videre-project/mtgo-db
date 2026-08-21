# Public Database Access

This document describes the public read-only SQL path for Videre's MTGO
database.

The HTTP API documentation lives in `api-services`. This page is about direct
PostgreSQL access through `mtgo-db`, which is better suited for bulk exports,
local analysis, and clients that need SQL-level joins.

Direct SQL access is not the same interface as the HTTP API. It exposes the
database shape more directly, so consumers get more flexibility and more
responsibility. Prefer the HTTP API for user-facing apps that only need the
published route shapes. Prefer SQL when the work is analytical, batch-oriented,
or would otherwise require many paginated HTTP requests.

## Connection Path

Public SQL access uses the public Cloudflare Tunnel hostname:

```text
public-db.videreproject.com
```

The tunnel routes to the public Pgpool service:

```text
public-db.videreproject.com
  -> pgpool-public
  -> PostgreSQL read replica pool
  -> public_api
```

This is separate from the Worker/API hostname:

```text
worker-db.videreproject.com
  -> pgbouncer-internal (transaction pool)
  -> pgpool-internal
  -> api
```

Do not use the Worker hostname for public SQL clients. It is intended for
first-party services and can be protected by Cloudflare Access Service Auth.

The public path exists so unauthenticated researchers and downstream tools can
query bounded read-only data without sharing the same Pgpool capacity or role
policy as Videre's first-party Worker.

## Connecting With `cloudflared`

Cloudflare arbitrary TCP access requires a local `cloudflared` bridge. Start the
bridge in one terminal:

```sh
cloudflared access tcp \
  --hostname public-db.videreproject.com \
  --url 127.0.0.1:5432
```

Then connect a PostgreSQL client to the local forwarded port:

```sh
psql 'postgresql://public_api@127.0.0.1:5432/mtgo?sslmode=disable'
```

The local connection to `127.0.0.1:5432` is not TLS because it is only the
client side of the local bridge. Cloudflare carries the tunnel traffic between
the bridge and the remote service.

If port `5432` is already in use locally, choose another local port:

```sh
cloudflared access tcp \
  --hostname public-db.videreproject.com \
  --url 127.0.0.1:15432

psql 'postgresql://public_api@127.0.0.1:15432/mtgo?sslmode=disable'
```

Keep the `cloudflared` process running while the SQL client is connected. When
the bridge exits, local SQL connections through that port will fail.

Most PostgreSQL tools can use the same local bridge:

| Setting | Value |
|---|---|
| Host | `127.0.0.1` |
| Port | `5432`, or the local port you selected |
| Database | `mtgo` |
| User | `public_api` |
| Password | empty |
| SSL mode | `disable` |

## Public Role

Public SQL uses the `public_api` PostgreSQL role. It is intentionally
passwordless at the Pgpool/PostgreSQL authentication boundary because the role
itself is constrained for public read-only use.

The role is configured with:

- Read-only default transactions.
- No superuser, createdb, createrole, or replication privileges.
- Connection limit: 20.
- Statement timeout: 5 seconds.
- Idle transaction timeout: 15 seconds.
- Idle session timeout: 60 seconds.
- Lock timeout: 500 milliseconds.
- Temporary file limit: 64 MB.
- `work_mem`: 4 MB.

The public role is meant for bounded exploratory queries and bulk reads. It is
not meant for long-running analytical jobs against the production database.

The security model is role-based rather than password-based:

- The public hostname routes only to `pgpool-public`.
- `pgpool-public` permits the `public_api` role.
- `public_api` has read-only defaults and explicit grants.
- PostgreSQL denies writes, schema changes, sequence access, and ungranted
  function execution.

Do not assume a query is safe just because it is read-only. Large joins,
unbounded sorts, and repeated exports can still compete with other public
clients. The public role limits are there to stop these queries from running too
long or consuming too much temporary space.

## Granted Data

`public_api` inherits the `api_reader` grant role. It can read the API-facing
tables and execute API/helper functions that are explicitly granted to
`api_reader`.

Current table grants include:

- `archetypes`
- `card_catalog_variants`
- `card_faces`
- `card_legalities`
- `catalog_items`
- `catalog_price_definitions`
- `catalog_price_history`
- `cards`
- `decks`
- `events`
- `formats`
- `matches`
- `oracle_cards`
- `products`
- `sets`
- `standings`

The role does not receive write privileges, sequence privileges, or blanket
function execution privileges.

Table and function grants can change as the public API model changes. Treat the
granted set as the supported public SQL surface, not as every internal object in
the database.

## When To Use SQL Instead Of HTTP

Use the HTTP API when a client needs common route shapes, cacheable public
requests, or browser-friendly JSON.

Use direct SQL when you need:

- Large local exports.
- Custom joins across event, deck, match, and card tables.
- Offline analysis.
- Replication into your own database.
- Queries that would require many paginated HTTP requests.

Keep queries bounded. Prefer date windows, format filters, `LIMIT`, and
selective joins. The public role's timeouts are designed to stop accidental
full-database scans from occupying shared capacity.

If you are building a public application, avoid opening a fresh database
connection for every user action. Use the HTTP API for interactive lookups when
possible. If you do use SQL from an application backend, keep the number of
connections low and close idle sessions promptly.

## Example Queries

List recent Modern events:

```sql
SELECT id, name, date, format, kind, players
FROM events
WHERE format = 'modern'
ORDER BY date DESC, id DESC
LIMIT 25;
```

Fetch deck counts by archetype for a date window:

```sql
SELECT a.name AS archetype, count(*) AS decks
FROM decks d
JOIN archetypes a ON a.id = d.archetype_id
JOIN events e ON e.id = d.event_id
WHERE e.format = 'modern'
  AND e.date >= current_date - interval '31 days'
GROUP BY a.name
ORDER BY decks DESC
LIMIT 25;
```

Find MTGO printings for a card name:

```sql
SELECT id, set_code, collector_number, name, printed_name, mana_cost, type_line
FROM cards
WHERE name_normalized = lower('Lightning Bolt')
   OR printed_name_normalized = lower('Lightning Bolt')
ORDER BY set_code, collector_number, id;
```

Inspect available tables:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
```

Check which functions are executable:

```sql
SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'public'
ORDER BY routine_name;
```

## Operational Notes

Public SQL access is shared infrastructure. Avoid connection pools with many
idle sessions, unbounded joins, and repeated large exports during peak API use.

If you need sustained high-volume access, create your own replica or ask for a
scheduled dump/export. That is usually safer than repeatedly running large
queries against the shared public role.
