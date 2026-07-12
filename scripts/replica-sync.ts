import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

function argumentError(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(2);
}

/**
 * Incremental sync for an external user's replica of mtgo-db.
 *
 * This is the "keep current" counterpart to the monthly replica baseline. It
 * reads through public_api and writes only to the target URL supplied by the
 * user.
 *
 * It deliberately reuses the pull-based pattern from sync-upstream.ts: it never
 * writes to mtgo-db, never needs replication privileges, and respects the
 * public_api 5s statement timeout by paging event IDs rather than scanning
 * whole tables.
 *
 * Usage:
 *   pnpm run replica-sync <target-url> --profile events|cards
 *   pnpm run replica-sync <target-url> --profile prices --since <timestamp>
 *
 * The user's connection string points at THEIR database (the replica target).
 * The source is always public_api via the tunnel/bridge (see PUBLIC-API.md).
 *
 * Events advance by monotonic event ID. Prices require an explicit timestamp
 * and replay its UTC date to catch same-day corrections. Cards are mutable and
 * therefore use a complete paged upsert.
 */

const PROFILES = {
  events: ['events', 'matches', 'decks', 'standings', 'archetypes', 'players'],
  cards: ['cards', 'card_faces', 'card_catalog_variants', 'card_legalities', 'oracle_cards', 'sets', 'products', 'formats'],
  prices: ['catalog_items', 'catalog_price_definitions', 'catalog_price_history'],
} as const;
type Profile = keyof typeof PROFILES | 'all';

const targetConnectionString = process.argv[2];
if (!targetConnectionString) {
  console.error('Usage: pnpm run replica-sync <your-connection-string> [--profile events] [--since <ts>]');
  process.exit(1);
}

let profile: Profile = 'events';
let since: string | null = null;
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === '--profile') profile = (process.argv[++i] ?? profile) as Profile;
  else if (process.argv[i].startsWith('--profile=')) profile = process.argv[i].slice('--profile='.length) as Profile;
  else if (process.argv[i] === '--since') since = process.argv[++i] ?? null;
  else if (process.argv[i].startsWith('--since=')) since = process.argv[i].slice('--since='.length);
  else argumentError(`Unknown argument: ${process.argv[i]}`);
}
if (profile !== 'all' && !(profile in PROFILES)) argumentError(`Unknown profile: ${profile}`);
if ((profile === 'prices' || profile === 'all') && !since) argumentError('--since is required for prices sync');
if (since && Number.isNaN(Date.parse(since))) argumentError(`Invalid --since timestamp: ${since}`);
const tables = profile === 'all' ? [...new Set(Object.values(PROFILES).flat())] : [...PROFILES[profile]];

// Source: the public read-only role. Defaults match PUBLIC-API.md (local
// cloudflared bridge). Override with API_DB_* / PG* env vars.
const source = postgres({
  host: process.env.API_DB_HOST ?? process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.API_DB_PORT ?? process.env.PGPORT ?? 6434),
  database: process.env.API_DB_DATABASE ?? process.env.PGDATABASE ?? 'mtgo',
  username: process.env.API_DB_USER ?? process.env.PGUSER ?? 'public_api',
  password: process.env.API_DB_PASSWORD ?? process.env.PGPASSWORD,
  ssl: (process.env.API_DB_SSL ?? process.env.PGSSL ?? 'false') === 'true' ? 'require' : false,
  max: 3,
  idle_timeout: 20,
  connect_timeout: 30,
});

// Target: the user's own replica.
const target = postgres(targetConnectionString, { max: 5, idle_timeout: 20, connect_timeout: 30 });

const PAGE = 500;

async function getMaxLocalEventId(): Promise<number> {
  const [row] = await target<{ max_id: number | null }[]>`SELECT max(id) AS max_id FROM events;`;
  return row.max_id ?? -1;
}

async function getNewEvents(maxLocalId: number): Promise<{ id: number; name: string; date: Date; format: string; kind: string; rounds: number | null; players: number | null }[]> {
  if (maxLocalId < 0) throw new Error('Events target is empty; restore the monthly events baseline before syncing');
  // Forward sync: events with a higher ID than anything already in the user's
  // replica. IDs are monotonic, so this catches new events and same-day-late
  // additions without scanning the whole table (stays under the 5s timeout).
  return await source<{ id: number; name: string; date: Date; format: string; kind: string; rounds: number | null; players: number | null }[]>`
    SELECT id, name, date, format, kind, rounds, players
    FROM events
    WHERE id > ${maxLocalId}
    ORDER BY id ASC;
  `;
}

async function syncTable(table: string, eventIds: number[]): Promise<number> {
  if (eventIds.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < eventIds.length; i += PAGE) {
    const page = eventIds.slice(i, i + PAGE);
    const where = table === 'archetypes'
      ? `deck_id IN (SELECT id FROM decks WHERE event_id IN (${page.map((_, idx) => `$${idx + 1}`).join(',')}))`
      : `event_id IN (${page.map((_, idx) => `$${idx + 1}`).join(',')})`;
    const rows = await source.unsafe(`SELECT * FROM ${table} WHERE ${where}`, page);
    if (rows.length === 0) continue;
    const columns = Object.keys(rows[0]);
    await target`
      INSERT INTO ${target(table)} ${target(rows, ...(columns as string[]))}
      ON CONFLICT DO NOTHING
    `;
    total += rows.length;
  }
  return total;
}

async function syncEvents(): Promise<void> {
  const maxLocalId = await getMaxLocalEventId();
  console.log(`Local maximum event ID: ${maxLocalId}`);
  const newEvents = await getNewEvents(maxLocalId);
  console.log(`New events to pull: ${newEvents.length}`);

  if (newEvents.length > 0) {
    await target`
      INSERT INTO events ${target(newEvents, 'id', 'name', 'date', 'format', 'kind', 'rounds', 'players')}
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, date = EXCLUDED.date, format = EXCLUDED.format,
        kind = EXCLUDED.kind, rounds = EXCLUDED.rounds, players = EXCLUDED.players;
    `;
  }

  if (newEvents.length === 0) return;

  const eventIds = newEvents.map((event) => event.id);
  // Players must exist before dependent event tables are inserted.
  const referenced = await source<{ player: string }[]>`
    SELECT DISTINCT player FROM standings WHERE event_id IN ${source(eventIds)}
    UNION SELECT DISTINCT player FROM matches WHERE event_id IN ${source(eventIds)}
    UNION SELECT DISTINCT player FROM decks WHERE event_id IN ${source(eventIds)}
  `;
  if (referenced.length > 0) {
    const names = referenced.map((r) => r.player);
    const upstreamPlayers = await source<{ id: number | null; name: string }[]>`
      SELECT id, name FROM players WHERE name IN ${source(names)}
    `;
    const localPlayers = await target<{ name: string }[]>`SELECT name FROM players WHERE name IN ${target(names)}`;
    const have = new Set(localPlayers.map((p) => p.name));
    const toInsert = upstreamPlayers.filter((p) => !have.has(p.name));
    if (toInsert.length > 0) {
      await target`INSERT INTO players ${target(toInsert, 'id', 'name')} ON CONFLICT (name) DO NOTHING;`;
      console.log(`  synced ${toInsert.length} new players`);
    }
  }
  for (const table of ['matches', 'decks', 'standings', 'archetypes']) {
    const n = await syncTable(table, eventIds);
    console.log(`  synced ${n} rows into ${table}`);
  }
}

async function syncPrices(): Promise<void> {
  // Reference tables are small and mutable, so refresh every writable column.
  for (const [ref, keys] of [['catalog_items', ['catalog_id']], ['catalog_price_definitions', ['source', 'catalog_id']]] as const) {
    const rows = await source<Record<string, unknown>[]>`SELECT * FROM ${source(ref)}`;
    if (rows.length > 0) {
      const cols = Object.keys(rows[0]);
      const updates = cols.filter((column) => !keys.some((key) => key === column));
      await target`
        INSERT INTO ${target(ref)} ${target(rows, ...cols)}
        ON CONFLICT ${target.unsafe(`(${keys.map((key) => `"${key}"`).join(', ')}) DO UPDATE SET ${updates.map((column) => `"${column}" = EXCLUDED."${column}"`).join(', ')}`)}
      `;
      console.log(`  synced ${rows.length} rows into ${ref}`);
    }
  }
  const sinceDate = since!.slice(0, 10);
  const pageSize = 2000;
  let cursor: [string, string, number] | null = null;
  let total = 0;
  for (;;) {
    const rows = cursor === null
      ? await source<Record<string, unknown>[]>`
          SELECT * FROM catalog_price_history WHERE price_date >= DATE ${sinceDate}
          ORDER BY price_date, source, catalog_id LIMIT ${pageSize}`
      : await source<Record<string, unknown>[]>`
          SELECT * FROM catalog_price_history
          WHERE price_date >= DATE ${sinceDate}
            AND (price_date, source, catalog_id) > (${cursor[0]}::date, ${cursor[1]}, ${cursor[2]})
          ORDER BY price_date, source, catalog_id LIMIT ${pageSize}`;
    if (rows.length === 0) break;
    const columns = Object.keys(rows[0]);
    await target`
      INSERT INTO catalog_price_history ${target(rows, ...columns)}
      ON CONFLICT (source, price_date, catalog_id) DO UPDATE SET
        sell_price = EXCLUDED.sell_price,
        first_seen_at = EXCLUDED.first_seen_at,
        last_seen_at = EXCLUDED.last_seen_at
    `;
    const last = rows.at(-1)!;
    const lastDate = last.price_date instanceof Date ? last.price_date.toISOString().slice(0, 10) : String(last.price_date).slice(0, 10);
    cursor = [lastDate, String(last.source), Number(last.catalog_id)];
    total += rows.length;
    if (rows.length < pageSize) break;
  }
  console.log(`  synced ${total} price rows on or after ${sinceDate}`);
}

async function syncCards(): Promise<void> {
  // Card data is mutable (erratas/migrations can change past rows), so we do a
  // full upsert of every card table. ON CONFLICT DO UPDATE keeps the local
  // replica current with corrections; the PKs make it idempotent. We page by
  // the source's primary key to stay under the public_api 5s statement timeout.
  const PAGE = 1000;
  const writableColumns = async (table: string): Promise<string[]> => {
    const rows = await source<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND is_generated = 'NEVER'
      ORDER BY ordinal_position`;
    return rows.map((row) => row.column_name);
  };
  const upsert = async (table: string, keys: string[]): Promise<number> => {
    let pulled = 0;
    let cursor: unknown[] | null = null;
    const columns = await writableColumns(table);
    const quotedColumns = columns.map((column) => `"${column}"`).join(', ');
    const order = keys.map((key) => `"${key}"`).join(', ');
    for (;;) {
      const where = cursor === null ? '' : `WHERE (${order}) > (${keys.map((_, i) => `$${i + 1}`).join(', ')})`;
      const rows = await source.unsafe<Record<string, unknown>[]>(
        `SELECT ${quotedColumns} FROM "${table}" ${where} ORDER BY ${order} LIMIT ${PAGE}`,
        cursor ?? [],
      );
      if (rows.length === 0) break;
      const updates = columns.filter((column) => !keys.includes(column));
      const action = updates.length > 0
        ? `DO UPDATE SET ${updates.map((column) => `"${column}" = EXCLUDED."${column}"`).join(', ')}`
        : 'DO NOTHING';
      await target`
        INSERT INTO ${target(table)} ${target(rows, ...columns)}
        ON CONFLICT ${target.unsafe(`(${order}) ${action}`)}
      `;
      pulled += rows.length;
      cursor = keys.map((key) => rows[rows.length - 1][key]);
      if (rows.length < PAGE) break;
    }
    return pulled;
  };

  // Reference tables first (no FK deps), then the rest.
  const order: [string, string[]][] = [
    ['formats', ['code']],
    ['sets', ['code']],
    ['oracle_cards', ['id']],
    ['products', ['id']],
    ['cards', ['id']],
    ['card_catalog_variants', ['catalog_id']],
    ['card_faces', ['card_id', 'face_index']],
    ['card_legalities', ['oracle_id', 'format_code']],
  ];
  for (const [table, keys] of order) {
    const n = await upsert(table, keys);
    console.log(`  synced ${n} rows into ${table}`);
  }
}

async function main(): Promise<void> {
  console.log(`Replica incremental sync (profile=${profile}, tables=${tables.join(', ')})`);
  console.log(`  source: public_api @ ${source.options.host}:${source.options.port}`);
  console.log(`  target: ${target.options.host}:${target.options.port}/${target.options.database}`);
  console.log(`  since : ${since ?? '(full forward sync from min id)'}\n`);

  if (profile === 'events' || profile === 'all') {
    await syncEvents();
  }
  if (profile === 'prices' || profile === 'all') {
    await syncPrices();
  }
  if (profile === 'cards' || profile === 'all') {
    await syncCards();
  }

  console.log('\n✓ Replica sync complete.');
}

main()
  .catch((err) => {
    console.error('Replica sync failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await source.end({ timeout: 5 });
    await target.end({ timeout: 5 });
  });
