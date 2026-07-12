import { execFileSync, spawn } from 'node:child_process';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

/**
 * Generates monthly windowed backfill dumps for the public replica, so external
 * users can restore only the months they care about instead of one giant
 * baseline. Each month becomes a directory of per-table compressed dumps.
 * Three profiles are emitted per month where data exists:
 *   - events : events, matches, decks, standings, archetypes, players
 *   - prices : catalog_items, catalog_price_definitions, catalog_price_history
 *   - cards  : sets, cards, products, variants, faces, oracles, legalities
 * Months with no data for the selected profile are skipped.
 *
 * Tables are exported as headerless gzip-compressed CSV with explicit writable
 * columns. `players` has no date column, so each month includes the players
 * referenced by that month's events.
 *
 * The default output dir is postgres/dump/replica, which is the path the main
 * repo mounts as a submodule to the orphan `replica-data` branch (where months
 * live at the branch root, e.g. 2026-01/).
 *
 * Usage:
 *   pnpm run replica-backfill [--profile all|events|prices|cards]
 *     [--from YYYY-MM] [--to YYYY-MM] [output-dir]
 *
 * The default range spans the selected profile and excludes the in-progress
 * calendar month.
 *
 * Output layout (each month dir is self-contained):
 *   2008-09/{events,matches,decks,standings,archetypes,players}.dump.gz
 *   2023-01/{...events...,catalog_items,catalog_price_definitions,catalog_price_history}.dump.gz
 *   ... one directory per non-empty month ...
 */

const REPLICA_CONTAINER = process.env.REPLICA_CONTAINER ?? 'postgres-replica-prod';
const PRIMARY_CONTAINER = process.env.POSTGRES_CONTAINER ?? 'postgres-prod';

// Tables that carry an event-derived date window (via events.date).
const DATED_TABLES = ['events', 'matches', 'decks', 'standings', 'archetypes'] as const;

// Prices profile: reference tables (full, idempotent on PK) + windowed history.
const PRICE_REF_TABLES = ['catalog_items', 'catalog_price_definitions'] as const;
const PRICE_HISTORY_TABLE = 'catalog_price_history' as const;

// Cards profile: organized by set release date. `sets` is the spine (each set
// is bucketed into the month of its release_date); every other card table is
// pulled in via the set it belongs to. `oracle_cards` is additionally emitted
// into the month of each oracle identity's FIRST appearance (the earliest set
// that prints it), so a consumer who restores months in order accumulates the
// correct oracle row exactly once at the point it first shows up. Reference
// `formats` is repeated reference data. `card_legalities` follows the oracle
// first-appearance partition so chronological restores preserve FK closure.
//
// MTGO uses a sentinel release_date (1900-01-01) for synthetic sets such as the
// token set (TOK), and some rows may have NULL. The game's first real release
// is Limited Edition (Alpha), 1993-08. We floor any pre-game / NULL
// release_date to SET_FLOOR so those rows bucket with the first real set
// instead of creating a bogus 1900-01 month.
const SET_FLOOR = '1993-08-01';
const setRelease = (col: string) =>
  `GREATEST(COALESCE(${col}, DATE '${SET_FLOOR}'), DATE '${SET_FLOOR}')`;
const CARDS_SET_TABLE = 'sets' as const;
const CARDS_REF_TABLES = ['formats'] as const;
const CARDS_JOIN_TABLES = [
  'cards',
  'products',
  'card_catalog_variants',
  'card_faces',
] as const;
const PROFILE_TABLES: Record<'events' | 'prices' | 'cards', readonly string[]> = {
  events: [...DATED_TABLES, 'players'],
  prices: [...PRICE_REF_TABLES, PRICE_HISTORY_TABLE],
  cards: [CARDS_SET_TABLE, ...CARDS_JOIN_TABLES, 'oracle_cards', ...CARDS_REF_TABLES, 'card_legalities'],
};

type Profile = 'events' | 'prices' | 'cards' | 'all';

function minMonth(a: string, b: string): string {
  return a < b ? a : b;
}
function maxMonth(a: string, b: string): string {
  return a > b ? a : b;
}

interface MonthManifest {
  month: string; // YYYY-MM
  generated_at: string;
  source: string;
  format: 'csv';
  compression: 9;
  profiles: string[];
  event_count: number;
  price_count: number;
  cards_count: number;
  tables: { name: string; file: string; bytes: number; columns: string[] }[];
}

function parseArgs(argv: string[]): { from: string | null; to: string | null; profile: Profile; outputDir: string } {
  let from: string | null = null;
  let to: string | null = null;
  let profile: Profile = 'all';
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from') from = argv[++i] ?? null;
    else if (arg.startsWith('--from=')) from = arg.slice('--from='.length);
    else if (arg === '--to') to = argv[++i] ?? null;
    else if (arg.startsWith('--to=')) to = arg.slice('--to='.length);
    else if (arg === '--profile') profile = (argv[++i] ?? 'all') as Profile;
    else if (arg.startsWith('--profile=')) profile = arg.slice('--profile='.length) as Profile;
    else if (!arg.startsWith('--')) positional.push(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['all', 'events', 'prices', 'cards'].includes(profile)) throw new Error(`Unknown profile: ${profile}`);
  for (const [name, value] of [['from', from], ['to', to]] as const) {
    if (value !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error(`Invalid --${name} month: ${value}`);
  }
  if (from && to && from > to) throw new Error(`--from ${from} is after --to ${to}`);
  if (positional.length > 1) throw new Error(`Unexpected positional argument: ${positional[1]}`);
  return { from, to, profile, outputDir: positional[0] ?? 'postgres/dump/replica' };
}

function psqlQuery(container: string, query: string): string {
  const out = execFileSync(
    'docker', ['exec', container, 'psql', '-U', process.env.POSTGRES_USER!, '-d', process.env.POSTGRES_DB!, '-t', '-A', '-F', '|', '-c', query],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.trim();
}

const _writableColumns = new Map<string, string[]>();
function getWritableColumns(container: string, table: string): string[] {
  const cached = _writableColumns.get(table);
  if (cached) return cached;
  const rows = psqlQuery(
    container,
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' AND is_generated = 'NEVER' ORDER BY ordinal_position;`,
  );
  const columns = rows.split('\n').filter(Boolean);
  if (columns.length === 0) throw new Error(`No writable columns found for ${table}`);
  _writableColumns.set(table, columns);
  return columns;
}

function selectColumns(container: string, table: string, alias?: string): string {
  const prefix = alias ? `${alias}.` : '';
  return getWritableColumns(container, table)
    .map((column) => `${prefix}"${column.replaceAll('"', '""')}"`)
    .join(', ');
}

let _oracleFirstCounts: Map<string, number> | null = null;
function getOracleFirstCounts(container: string): Map<string, number> {
  if (_oracleFirstCounts) return _oracleFirstCounts;
  const rows = psqlQuery(
    container,
    `SELECT ym, count(*) FROM (SELECT c.oracle_id, to_char(min(${setRelease('s.release_date')}), 'YYYY-MM') AS ym FROM cards c JOIN sets s ON s.code = c.set_code GROUP BY c.oracle_id) first_printings GROUP BY ym ORDER BY ym;`,
  );
  const map = new Map<string, number>();
  for (const line of rows.split('\n')) {
    const [ym, count] = line.split('|');
    if (ym && count) map.set(ym, Number(count));
  }
  _oracleFirstCounts = map;
  return map;
}

function oracleFirstAppearanceWhere(column: string, start: string, next: string): string {
  return `${column} IN (SELECT c.oracle_id FROM cards c JOIN sets s ON s.code = c.set_code GROUP BY c.oracle_id HAVING min(${setRelease('s.release_date')}) >= DATE '${start}' AND min(${setRelease('s.release_date')}) < DATE '${next}')`;
}

function monthRange(from: string, to: string): string[] {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const months: string[] = [];
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return months;
}

// Dump a COPY (SELECT ...) result as a gzip-compressed CSV stream.
// pg_dump can't filter rows, so we pipe psql COPY ... TO STDOUT through gzip.
function dumpCopy(container: string, copyQuery: string, outFile: string): Promise<number> {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const psql = spawn('docker', [
    'exec', '-i', container,
    'psql', '-U', process.env.POSTGRES_USER!, '-d', process.env.POSTGRES_DB!,
    '-c', `COPY (${copyQuery}) TO STDOUT WITH (FORMAT csv, HEADER false)`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const gzip = spawn('gzip', ['-9', '-c'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const writeStream = fs.createWriteStream(outFile);
  psql.stdout.pipe(gzip.stdin);
  gzip.stdout.pipe(writeStream);

  let stderr = '';
  psql.stderr.on('data', (d) => (stderr += d.toString()));
  gzip.stderr.on('data', (d) => (stderr += d.toString()));

  const processExit = (name: string, child: typeof psql) =>
    new Promise<void>((resolve, reject) => {
      child.on('error', (e) => reject(new Error(`${name}: ${e.message}`)));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${name} exited ${code}`));
      });
    });
  const fileClosed = new Promise<void>((resolve, reject) => {
    writeStream.on('error', (e) => reject(new Error(`write: ${e.message}`)));
    writeStream.on('close', resolve);
  });

  return Promise.all([processExit('psql', psql), processExit('gzip', gzip), fileClosed])
    .then(() => fs.statSync(outFile).size)
    .catch((error) => {
      if (stderr) console.error(stderr);
      throw error;
    });
}

async function backfill(): Promise<void> {
  const replicaUp = await isRunning(REPLICA_CONTAINER);
  const primaryUp = await isRunning(PRIMARY_CONTAINER);
  if (!replicaUp && !primaryUp) {
    throw new Error(`Neither ${REPLICA_CONTAINER} nor ${PRIMARY_CONTAINER} is running`);
  }
  const sourceContainer = replicaUp ? REPLICA_CONTAINER : PRIMARY_CONTAINER;
  if (!replicaUp) console.warn(`Warning: ${REPLICA_CONTAINER} down; using ${PRIMARY_CONTAINER}.\n`);

  const { from, to, profile, outputDir } = parseArgs(process.argv.slice(2));
  const eventsFrom = psqlQuery(sourceContainer, "SELECT to_char(min(date), 'YYYY-MM') FROM events;");
  const eventsTo = psqlQuery(sourceContainer, "SELECT to_char(max(date), 'YYYY-MM') FROM events;");
  const pricesFrom = psqlQuery(sourceContainer, "SELECT to_char(min(price_date), 'YYYY-MM') FROM catalog_price_history;");
  const pricesTo = psqlQuery(sourceContainer, "SELECT to_char(max(price_date), 'YYYY-MM') FROM catalog_price_history;");
  const cardsFrom = psqlQuery(sourceContainer, `SELECT to_char(min(${setRelease('release_date')}), 'YYYY-MM') FROM sets;`);
  const cardsTo = psqlQuery(sourceContainer, "SELECT to_char(max(release_date), 'YYYY-MM') FROM sets;");
  const profileFrom = profile === 'events' ? eventsFrom : profile === 'prices' ? pricesFrom : profile === 'cards' ? cardsFrom : minMonth(minMonth(eventsFrom, pricesFrom), cardsFrom);
  const profileTo = profile === 'events' ? eventsTo : profile === 'prices' ? pricesTo : profile === 'cards' ? cardsTo : maxMonth(maxMonth(eventsTo, pricesTo), cardsTo);
  const fromMonth = from ?? profileFrom;
  const latestDataMonth = profileTo;
  const now = new Date();
  const previousMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const previousMonth = `${previousMonthDate.getUTCFullYear()}-${String(previousMonthDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const toMonth = to ?? minMonth(latestDataMonth, previousMonth);
  const outputPath = path.resolve(process.cwd(), outputDir);

  console.log(`Replica backfill (profile=${profile})`);
  console.log(`  range : ${fromMonth} .. ${toMonth}`);
  console.log(`  source: ${sourceContainer}`);
  console.log(`  output: ${outputPath}\n`);

  const months = monthRange(fromMonth, toMonth);
  let skipped = 0;
  let emitted = 0;

  for (const month of months) {
    const [y, m] = month.split('-').map(Number);
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

    const eventCount = Number(
      psqlQuery(sourceContainer, `SELECT count(*) FROM events WHERE date >= DATE '${start}' AND date < DATE '${next}';`) || '0',
    );
    const priceCount = Number(
      psqlQuery(sourceContainer, `SELECT count(*) FROM catalog_price_history WHERE price_date >= DATE '${start}' AND price_date < DATE '${next}';`) || '0',
    );
    // Cards: sets whose (floored) release_date falls in this month (the bucket spine).
    const cardCount = Number(
      psqlQuery(sourceContainer, `SELECT count(*) FROM sets WHERE ${setRelease('release_date')} >= DATE '${start}' AND ${setRelease('release_date')} < DATE '${next}';`) || '0',
    );

    const wantEvents = profile === 'all' || profile === 'events';
    const wantPrices = profile === 'all' || profile === 'prices';
    const wantCards = profile === 'all' || profile === 'cards';
    const hasEvents = eventCount > 0;
    const hasPrices = priceCount > 0;
    const hasCards = cardCount > 0;

    if (!((wantEvents && hasEvents) || (wantPrices && hasPrices) || (wantCards && hasCards))) {
      skipped++;
      continue;
    }

    const monthDir = path.join(outputPath, month);
    const existingManifestPath = path.join(monthDir, 'REPLICA-MANIFEST.json');
    let existing: MonthManifest | null = null;
    if (fs.existsSync(existingManifestPath)) {
      existing = JSON.parse(fs.readFileSync(existingManifestPath, 'utf8')) as MonthManifest;
    }
    const replacedTables = new Set<string>();
    if (wantEvents) for (const table of PROFILE_TABLES.events) replacedTables.add(table);
    if (wantPrices) for (const table of PROFILE_TABLES.prices) replacedTables.add(table);
    if (wantCards) for (const table of PROFILE_TABLES.cards) replacedTables.add(table);
    const manifest: MonthManifest = {
      month,
      generated_at: new Date().toISOString(),
      source: sourceContainer,
      format: 'csv',
      compression: 9,
      profiles: (existing?.profiles ?? []).filter((p) =>
        !((p === 'events' && wantEvents) || (p === 'prices' && wantPrices) || (p === 'cards' && wantCards))),
      event_count: eventCount,
      price_count: priceCount,
      cards_count: cardCount,
      tables: (existing?.tables ?? []).filter((table) => !replacedTables.has(table.name)),
    };

    console.log(`${month}: ${eventCount} events, ${priceCount} price rows, ${cardCount} sets`);

    // ---- Events profile ----
    if (wantEvents && hasEvents) {
      manifest.profiles.push('events');
      for (const table of DATED_TABLES) {
        const where =
          table === 'events'
            ? `date >= DATE '${start}' AND date < DATE '${next}'`
            : table === 'archetypes'
              ? `deck_id IN (SELECT id FROM decks WHERE event_id IN (SELECT id FROM events WHERE date >= DATE '${start}' AND date < DATE '${next}'))`
            : `event_id IN (SELECT id FROM events WHERE date >= DATE '${start}' AND date < DATE '${next}')`;
        const copyQuery = `SELECT ${selectColumns(sourceContainer, table)} FROM ${table} WHERE ${where}`;
        const file = path.join(monthDir, `${table}.dump.gz`);
        const bytes = await dumpCopy(sourceContainer, copyQuery, file);
        console.log(`  ✓ ${table}: ${(bytes / 1048576).toFixed(2)} MB`);
        manifest.tables.push({ name: table, file: `${table}.dump.gz`, bytes, columns: getWritableColumns(sourceContainer, table) });
      }
      // players: those referenced by this month's events.
      const playerCopy = `
        SELECT ${selectColumns(sourceContainer, 'players', 'p')} FROM players p
        WHERE p.name IN (
          SELECT player FROM standings WHERE event_id IN (SELECT id FROM events WHERE date >= DATE '${start}' AND date < DATE '${next}')
          UNION SELECT player FROM matches WHERE event_id IN (SELECT id FROM events WHERE date >= DATE '${start}' AND date < DATE '${next}')
          UNION SELECT player FROM decks WHERE event_id IN (SELECT id FROM events WHERE date >= DATE '${start}' AND date < DATE '${next}')
        )
      `;
      const playerFile = path.join(monthDir, 'players.dump.gz');
      const pbytes = await dumpCopy(sourceContainer, playerCopy, playerFile);
      console.log(`  ✓ players: ${(pbytes / 1048576).toFixed(2)} MB`);
      manifest.tables.push({ name: 'players', file: 'players.dump.gz', bytes: pbytes, columns: getWritableColumns(sourceContainer, 'players') });
    }

    // ---- Prices profile ----
    if (wantPrices && hasPrices) {
      manifest.profiles.push('prices');
      // Reference tables: full dump, idempotent on PK (deduplicated across months).
      for (const table of PRICE_REF_TABLES) {
        const file = path.join(monthDir, `${table}.dump.gz`);
        const bytes = await dumpCopy(sourceContainer, `SELECT ${selectColumns(sourceContainer, table)} FROM ${table}`, file);
        console.log(`  ✓ ${table}: ${(bytes / 1048576).toFixed(2)} MB`);
        manifest.tables.push({ name: table, file: `${table}.dump.gz`, bytes, columns: getWritableColumns(sourceContainer, table) });
      }
      // History: windowed by price_date.
      const priceFile = path.join(monthDir, `${PRICE_HISTORY_TABLE}.dump.gz`);
      const pbytes = await dumpCopy(
        sourceContainer,
        `SELECT ${selectColumns(sourceContainer, PRICE_HISTORY_TABLE)} FROM ${PRICE_HISTORY_TABLE} WHERE price_date >= DATE '${start}' AND price_date < DATE '${next}'`,
        priceFile,
      );
      console.log(`  ✓ ${PRICE_HISTORY_TABLE}: ${(pbytes / 1048576).toFixed(2)} MB`);
      manifest.tables.push({ name: PRICE_HISTORY_TABLE, file: `${PRICE_HISTORY_TABLE}.dump.gz`, bytes: pbytes, columns: getWritableColumns(sourceContainer, PRICE_HISTORY_TABLE) });
    }

    // ---- Cards profile (bucketed by set release_date) ----
    if (wantCards && hasCards) {
      manifest.profiles.push('cards');
      // Spine: sets released this month (floored release_date).
      const setFile = path.join(monthDir, `${CARDS_SET_TABLE}.dump.gz`);
      const sbytes = await dumpCopy(
        sourceContainer,
        `SELECT ${selectColumns(sourceContainer, CARDS_SET_TABLE)} FROM ${CARDS_SET_TABLE} WHERE ${setRelease('release_date')} >= DATE '${start}' AND ${setRelease('release_date')} < DATE '${next}'`,
        setFile,
      );
      console.log(`  ✓ ${CARDS_SET_TABLE}: ${(sbytes / 1048576).toFixed(2)} MB`);
      manifest.tables.push({ name: CARDS_SET_TABLE, file: `${CARDS_SET_TABLE}.dump.gz`, bytes: sbytes, columns: getWritableColumns(sourceContainer, CARDS_SET_TABLE) });

      // Join tables: rows whose set_code is a set released this month (floored).
      for (const table of CARDS_JOIN_TABLES) {
        const file = path.join(monthDir, `${table}.dump.gz`);
        const where = table === 'card_faces'
          ? `card_id IN (SELECT id FROM cards WHERE set_code IN (SELECT code FROM sets WHERE ${setRelease('release_date')} >= DATE '${start}' AND ${setRelease('release_date')} < DATE '${next}'))`
          : `set_code IN (SELECT code FROM sets WHERE ${setRelease('release_date')} >= DATE '${start}' AND ${setRelease('release_date')} < DATE '${next}')`;
        const bytes = await dumpCopy(
          sourceContainer,
          `SELECT ${selectColumns(sourceContainer, table)} FROM ${table} WHERE ${where}`,
          file,
        );
        console.log(`  ✓ ${table}: ${(bytes / 1048576).toFixed(2)} MB`);
        manifest.tables.push({ name: table, file: `${table}.dump.gz`, bytes, columns: getWritableColumns(sourceContainer, table) });
      }

      // oracle_cards: each identity emitted into the month of its FIRST
      // appearance (earliest set that prints it, floored). The count map is
      // computed once for progress reporting; PostgreSQL selects the rows.
      const oracleCount = getOracleFirstCounts(sourceContainer).get(month) ?? 0;
      const oracleWhere = oracleFirstAppearanceWhere('id', start, next);
      const oracleFile = path.join(monthDir, 'oracle_cards.dump.gz');
      const obytes = await dumpCopy(
        sourceContainer,
        `SELECT ${selectColumns(sourceContainer, 'oracle_cards')} FROM oracle_cards WHERE ${oracleWhere}`,
        oracleFile,
      );
      console.log(`  ✓ oracle_cards: ${(obytes / 1048576).toFixed(2)} MB (${oracleCount} rows)`);
      manifest.tables.push({ name: 'oracle_cards', file: 'oracle_cards.dump.gz', bytes: obytes, columns: getWritableColumns(sourceContainer, 'oracle_cards') });

      // Reference tables: full dump, idempotent on PK (deduplicated across months).
      for (const table of CARDS_REF_TABLES) {
        const file = path.join(monthDir, `${table}.dump.gz`);
        const bytes = await dumpCopy(sourceContainer, `SELECT ${selectColumns(sourceContainer, table)} FROM ${table}`, file);
        console.log(`  ✓ ${table}: ${(bytes / 1048576).toFixed(2)} MB`);
        manifest.tables.push({ name: table, file: `${table}.dump.gz`, bytes, columns: getWritableColumns(sourceContainer, table) });
      }

      // Legalities follow their oracle identity's first-appearance month, so
      // chronological restores never reference an oracle that has not yet
      // been loaded.
      const legalityFile = path.join(monthDir, 'card_legalities.dump.gz');
      const legalityWhere = oracleCount > 0
        ? oracleFirstAppearanceWhere('oracle_id', start, next)
        : 'false';
      const lbytes = await dumpCopy(
        sourceContainer,
        `SELECT ${selectColumns(sourceContainer, 'card_legalities')} FROM card_legalities WHERE ${legalityWhere}`,
        legalityFile,
      );
      console.log(`  ✓ card_legalities: ${(lbytes / 1048576).toFixed(2)} MB`);
      manifest.tables.push({ name: 'card_legalities', file: 'card_legalities.dump.gz', bytes: lbytes, columns: getWritableColumns(sourceContainer, 'card_legalities') });
    }

    fs.writeFileSync(path.join(monthDir, 'REPLICA-MANIFEST.json'), JSON.stringify(manifest, null, 2));
    emitted++;
  }

  // A full cards rebuild is authoritative for card-month membership. If a set
  // release date moved, remove the obsolete cards profile/files from its old
  // month instead of leaving an unreachable stale bucket behind.
  if (profile === 'cards' && from === null && to === null) {
    const validCardMonths = new Set(
      psqlQuery(sourceContainer, `SELECT DISTINCT to_char(${setRelease('release_date')}, 'YYYY-MM') FROM sets WHERE ${setRelease('release_date')} < DATE '${toMonth}-01' + INTERVAL '1 month' ORDER BY 1;`)
        .split('\n').filter(Boolean),
    );
    const cardTables = new Set<string>([CARDS_SET_TABLE, ...CARDS_JOIN_TABLES, 'oracle_cards', ...CARDS_REF_TABLES, 'card_legalities']);
    for (const entry of fs.readdirSync(outputPath)) {
      if (!/^\d{4}-\d{2}$/.test(entry) || validCardMonths.has(entry)) continue;
      const monthDir = path.join(outputPath, entry);
      const manifestPath = path.join(monthDir, 'REPLICA-MANIFEST.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as MonthManifest;
      if (!manifest.profiles.includes('cards')) continue;
      manifest.profiles = manifest.profiles.filter((candidate) => candidate !== 'cards');
      manifest.tables = manifest.tables.filter((table) => !cardTables.has(table.name));
      for (const table of cardTables) fs.rmSync(path.join(monthDir, `${table}.dump.gz`), { force: true });
      if (manifest.profiles.length === 0) fs.rmSync(monthDir, { recursive: true, force: true });
      else fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
  }

  console.log(`\n✓ Backfill complete: ${emitted} month(s) emitted, ${skipped} empty month(s) skipped.`);
}

function isRunning(container: string): Promise<boolean> {
  return new Promise((resolve) => {
    const check = spawn('docker', ['ps', '--filter', `name=${container}`, '--format', '{{.Names}}'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    check.stdout.on('data', (d) => (out += d.toString()));
    check.on('close', () => resolve(out.split('\n').some((l) => l.trim() === container)));
  });
}

backfill().catch((err) => {
  console.error('\nBackfill failed:', err);
  process.exitCode = 1;
});
