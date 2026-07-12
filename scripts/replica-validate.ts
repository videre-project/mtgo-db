import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const root = path.resolve(process.cwd(), process.argv[2] ?? 'postgres/dump/replica');
const replica = process.env.REPLICA_CONTAINER ?? 'postgres-replica-prod';
const primary = process.env.POSTGRES_CONTAINER ?? 'postgres-prod';
const user = process.env.POSTGRES_USER!;
const database = process.env.POSTGRES_DB!;
const expected: Record<string, string[]> = {
  events: ['events', 'matches', 'decks', 'standings', 'archetypes', 'players'],
  prices: ['catalog_items', 'catalog_price_definitions', 'catalog_price_history'],
  cards: ['sets', 'cards', 'products', 'card_catalog_variants', 'card_faces', 'oracle_cards', 'formats', 'card_legalities'],
};

interface TableEntry { name: string; file: string; bytes: number; columns: string[] }
interface Manifest { month: string; format: string; profiles: string[]; event_count: number; price_count: number; cards_count: number; tables: TableEntry[] }

const errors: string[] = [];
const manifests = new Map<string, Manifest>();
const latestFile = new Map<string, { file: string; columns: string[] }>();

function query(sql: string): string {
  return execFileSync('docker', ['exec', replica, 'psql', '-U', user, '-d', database, '-t', '-A', '-c', sql], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

const months = fs.readdirSync(root).filter((name) => /^\d{4}-\d{2}$/.test(name)).sort();
for (const month of months) {
  const manifestFile = path.join(root, month, 'REPLICA-MANIFEST.json');
  if (!fs.existsSync(manifestFile)) { errors.push(`${month}: missing manifest`); continue; }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Manifest;
  manifests.set(month, manifest);
  if (manifest.month !== month) errors.push(`${month}: manifest month is ${manifest.month}`);
  if (manifest.format !== 'csv') errors.push(`${month}: format is ${manifest.format}, expected csv`);
  const byName = new Map(manifest.tables.map((table) => [table.name, table]));
  for (const profile of manifest.profiles) {
    for (const tableName of expected[profile] ?? []) {
      const table = byName.get(tableName);
      if (!table) { errors.push(`${month}: ${profile} missing ${tableName}`); continue; }
      const file = path.join(root, month, table.file);
      if (!fs.existsSync(file)) { errors.push(`${month}: missing ${table.file}`); continue; }
      if (fs.statSync(file).size !== table.bytes) errors.push(`${month}/${table.file}: byte count mismatch`);
      if (!Array.isArray(table.columns) || table.columns.length === 0) errors.push(`${month}/${tableName}: missing columns`);
      const gzip = spawnSync('gzip', ['-t', file]);
      if (gzip.status !== 0) errors.push(`${month}/${table.file}: invalid gzip`);
      if (fs.statSync(file).size > 20) latestFile.set(tableName, { file, columns: table.columns });
    }
  }
  for (const [profile, table, expectedCount] of [
    ['events', 'events', manifest.event_count],
    ['prices', 'catalog_price_history', manifest.price_count],
    ['cards', 'sets', manifest.cards_count],
  ] as const) {
    if (!manifest.profiles.includes(profile)) continue;
    const entry = byName.get(table);
    if (entry) {
      const actual = lineCountForPartition(path.join(root, month, entry.file));
      if (actual !== expectedCount) errors.push(`${month}/${table}: ${actual} rows, manifest says ${expectedCount}`);
    }
  }
}

const cardMonths = [...manifests].filter(([, m]) => m.profiles.includes('cards')).map(([month]) => month);
const eventMonths = [...manifests].filter(([, m]) => m.profiles.includes('events')).map(([month]) => month);
const lastEventMonth = eventMonths.at(-1)!;
const [lastEventYear, lastEventMonthNumber] = lastEventMonth.split('-').map(Number);
const eventCutoffDate = lastEventMonthNumber === 12 ? `${lastEventYear + 1}-01-01` : `${lastEventYear}-${String(lastEventMonthNumber + 1).padStart(2, '0')}-01`;
const databaseCardMonths = query(`SELECT DISTINCT to_char(GREATEST(COALESCE(release_date, DATE '1993-08-01'), DATE '1993-08-01'), 'YYYY-MM') FROM sets ORDER BY 1;`).split('\n').filter(Boolean);
if (cardMonths.join(',') !== databaseCardMonths.join(',')) errors.push('cards profile months do not exactly match set-release months');

const monthExpr = (column: string) => `to_char(GREATEST(COALESCE(${column}, DATE '1993-08-01'), DATE '1993-08-01'), 'YYYY-MM')`;
const expectedCardCounts = new Map<string, number>();
const partitionRows = query(`
  WITH firsts AS (
    SELECT c.oracle_id, ${monthExpr('min(s.release_date)')} AS month
    FROM cards c JOIN sets s ON s.code = c.set_code GROUP BY c.oracle_id
  ), counts AS (
    SELECT 'sets' AS table_name, ${monthExpr('s.release_date')} AS month, count(*) AS n FROM sets s GROUP BY 2
    UNION ALL SELECT 'cards', ${monthExpr('s.release_date')}, count(*) FROM cards c JOIN sets s ON s.code=c.set_code GROUP BY 2
    UNION ALL SELECT 'products', ${monthExpr('s.release_date')}, count(*) FROM products p JOIN sets s ON s.code=p.set_code GROUP BY 2
    UNION ALL SELECT 'card_catalog_variants', ${monthExpr('s.release_date')}, count(*) FROM card_catalog_variants v JOIN sets s ON s.code=v.set_code GROUP BY 2
    UNION ALL SELECT 'card_faces', ${monthExpr('s.release_date')}, count(*) FROM card_faces f JOIN cards c ON c.id=f.card_id JOIN sets s ON s.code=c.set_code GROUP BY 2
    UNION ALL SELECT 'oracle_cards', f.month, count(*) FROM oracle_cards o JOIN firsts f ON f.oracle_id=o.id GROUP BY 2
    UNION ALL SELECT 'card_legalities', f.month, count(*) FROM card_legalities l JOIN firsts f ON f.oracle_id=l.oracle_id GROUP BY 2
  ) SELECT table_name || '|' || month || '|' || n FROM counts ORDER BY table_name, month;
`).split('\n').filter(Boolean);
for (const row of partitionRows) {
  const [table, month, count] = row.split('|');
  expectedCardCounts.set(`${month}/${table}`, Number(count));
}
for (const month of cardMonths) {
  const manifest = manifests.get(month)!;
  for (const table of expected.cards.filter((name) => name !== 'formats')) {
    const entry = manifest.tables.find((candidate) => candidate.name === table)!;
    const actual = lineCountForPartition(path.join(root, month, entry.file));
    const wanted = expectedCardCounts.get(`${month}/${table}`) ?? 0;
    if (actual !== wanted) errors.push(`${month}/${table}: exported ${actual}, expected ${wanted}`);
  }
}

for (const [table, sql] of [
  ['cards', 'SELECT count(*) FROM cards'],
  ['oracle_cards', 'SELECT count(*) FROM oracle_cards'],
  ['card_faces', 'SELECT count(*) FROM card_faces'],
  ['card_legalities', 'SELECT count(*) FROM card_legalities'],
  ['archetypes', `SELECT count(*) FROM archetypes a JOIN decks d ON d.id=a.deck_id JOIN events e ON e.id=d.event_id WHERE e.date < DATE '${eventCutoffDate}'`],
] as const) {
  const keyWidth = table === 'card_faces' || table === 'card_legalities' ? 2 : 1;
  const keys = new Set<string>();
  let duplicateKeys = 0;
  const exported = [...manifests].reduce((sum, [month, manifest]) => {
    const entry = manifest.tables.find((candidate) => candidate.name === table);
    if (!entry) return sum;
    const file = path.join(root, month, entry.file);
    const csv = execFileSync('gzip', ['-cd', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const lines = csv.split('\n').filter(Boolean);
    for (const line of lines) {
      // Every validated key column is first in its table and contains neither
      // commas nor CSV quoting, so key extraction does not require a CSV parser.
      const key = line.split(',', keyWidth + 1).slice(0, keyWidth).join(',');
      if (keys.has(key)) duplicateKeys++;
      keys.add(key);
    }
    return sum + lines.length;
  }, 0);
  const source = Number(query(sql));
  if (exported !== source) errors.push(`${table}: exported ${exported}, source ${source}`);
  if (duplicateKeys > 0) errors.push(`${table}: ${duplicateKeys} duplicate exported primary keys`);
  console.log(`${table}: ${exported}/${source}`);
}

// Prove that every table's declared writable-column contract can be consumed
// by PostgreSQL. One recent non-empty file per table is sufficient for shape,
// generated-column, CSV, and column-order validation.
for (const [table, sample] of latestFile) {
  const columns = sample.columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(',');
  const sql = `BEGIN; CREATE TEMP TABLE replica_restore_test (LIKE public."${table}" INCLUDING ALL); COPY replica_restore_test (${columns}) FROM STDIN WITH (FORMAT csv); ROLLBACK;`;
  const result = spawnSync('bash', ['-o', 'pipefail', '-c',
    'gzip -cd "$1" | docker exec -i "$2" psql -v ON_ERROR_STOP=1 -U "$3" -d "$4" -c "$5"',
    'bash', sample.file, primary, user, database, sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) errors.push(`${table}: restore contract failed: ${result.stderr.trim()}`);
}

if (errors.length > 0) {
  console.error(`\nReplica validation failed (${errors.length}):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`\nReplica validation passed: ${months.length} months, ${latestFile.size} table restore contracts.`);

function lineCountForPartition(file: string): number {
  const result = spawnSync('bash', ['-o', 'pipefail', '-c', 'gzip -cd "$1" | wc -l', 'bash', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return Number(result.stdout.trim());
}
