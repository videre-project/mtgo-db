import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

function argumentError(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(2);
}

/**
 * Restores monthly replica CSVs into an existing mtgo-db schema. Rows are
 * copied through a temporary table and upserted, making repeated reference
 * tables and corrected historical months safe to replay.
 *
 * Usage:
 *   pnpm run replica-restore <target-url> [--profile all|events|prices|cards]
 *     [--from YYYY-MM] [--to YYYY-MM] [replica-dir]
 */

const targetUrl = process.argv[2];
if (!targetUrl || targetUrl.startsWith('--')) {
  console.error('Usage: pnpm run replica-restore <target-url> [--profile all|events|prices|cards] [--from YYYY-MM] [--to YYYY-MM] [replica-dir]');
  process.exit(1);
}

let profile = 'all';
let from: string | null = null;
let to: string | null = null;
let verbose = false;
const positional: string[] = [];
for (let i = 3; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--profile') profile = process.argv[++i] ?? profile;
  else if (arg.startsWith('--profile=')) profile = arg.slice('--profile='.length);
  else if (arg === '--from') from = process.argv[++i] ?? null;
  else if (arg.startsWith('--from=')) from = arg.slice('--from='.length);
  else if (arg === '--to') to = process.argv[++i] ?? null;
  else if (arg.startsWith('--to=')) to = arg.slice('--to='.length);
  else if (arg === '--verbose') verbose = true;
  else if (!arg.startsWith('--')) positional.push(arg);
  else argumentError(`Unknown argument: ${arg}`);
}
const replicaDir = path.resolve(process.cwd(), positional[0] ?? 'postgres/dump/replica');
const allowedProfiles = new Set(['all', 'events', 'prices', 'cards']);
if (!allowedProfiles.has(profile)) argumentError(`Unknown profile: ${profile}`);
for (const [name, value] of [['from', from], ['to', to]] as const) {
  if (value !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) argumentError(`Invalid --${name} month: ${value}`);
}
if (from && to && from > to) argumentError(`--from ${from} is after --to ${to}`);
if (positional.length > 1) argumentError(`Unexpected positional argument: ${positional[1]}`);
if (!fs.existsSync(replicaDir)) argumentError(`Replica directory not found: ${replicaDir}`);
if (spawnSync('psql', ['--version']).status !== 0) argumentError('psql is required on PATH');

const restoreOrder = [
  'formats', 'sets', 'oracle_cards', 'players', 'events', 'catalog_items',
  'products', 'cards', 'card_catalog_variants', 'card_faces',
  'card_legalities', 'catalog_price_definitions', 'catalog_price_history',
  'matches', 'decks', 'standings', 'archetypes',
];

interface TableEntry { name: string; file: string; columns: string[] }
interface Manifest { month: string; profiles: string[]; tables: TableEntry[] }

const target = postgres(targetUrl, { max: 1, connect_timeout: 30 });

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function primaryKey(table: string): Promise<string[]> {
  const rows = await target<{ column_name: string }[]>`
    SELECT a.attname AS column_name
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = ${`public.${table}`}::regclass AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)
  `;
  if (rows.length === 0) throw new Error(`No primary key found for public.${table}`);
  return rows.map((row) => row.column_name);
}

function restoreFile(file: string, table: string, columns: string[], keys: string[]): Promise<void> {
  const quotedColumns = columns.map(quoteIdent).join(', ');
  const quotedKeys = keys.map(quoteIdent).join(', ');
  const updates = columns.filter((column) => !keys.includes(column));
  const conflict = updates.length > 0
    ? `DO UPDATE SET ${updates.map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`).join(', ')}`
    : 'DO NOTHING';
  const sql = `BEGIN;
    CREATE TEMP TABLE replica_stage (LIKE public.${quoteIdent(table)} INCLUDING DEFAULTS) ON COMMIT DROP;
    COPY replica_stage (${quotedColumns}) FROM STDIN WITH (FORMAT csv);
    INSERT INTO public.${quoteIdent(table)} (${quotedColumns})
      SELECT ${quotedColumns} FROM replica_stage
      ON CONFLICT (${quotedKeys}) ${conflict};
    COMMIT;`;

  return new Promise((resolve, reject) => {
    const gzip = spawn('gzip', ['-cd', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    const psql = spawn('psql', [targetUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: ['pipe', 'ignore', 'pipe'] });
    gzip.stdout.pipe(psql.stdin);
    let stderr = '';
    gzip.stderr.on('data', (data) => (stderr += data.toString()));
    psql.stderr.on('data', (data) => (stderr += data.toString()));
    let gzipCode: number | null = null;
    let psqlCode: number | null = null;
    const finish = () => {
      if (gzipCode === null || psqlCode === null) return;
      if (gzipCode === 0 && psqlCode === 0) resolve();
      else reject(new Error(`${table} restore failed (gzip=${gzipCode}, psql=${psqlCode}): ${stderr.trim()}`));
    };
    gzip.on('error', reject);
    psql.on('error', reject);
    gzip.on('close', (code) => { gzipCode = code; finish(); });
    psql.on('close', (code) => { psqlCode = code; finish(); });
  });
}

async function main(): Promise<void> {
  const months = fs.readdirSync(replicaDir)
    .filter((month) => /^\d{4}-\d{2}$/.test(month))
    .filter((month) => (!from || month >= from) && (!to || month <= to))
    .sort();
  const keyCache = new Map<string, string[]>();
  let restored = 0;
  console.log(`Replica restore (profile=${profile}, months=${months.length})`);
  console.log(`  source: ${replicaDir}`);

  for (const month of months) {
    const manifest = JSON.parse(fs.readFileSync(path.join(replicaDir, month, 'REPLICA-MANIFEST.json'), 'utf8')) as Manifest;
    const selectedProfiles = profile === 'all' ? manifest.profiles : manifest.profiles.filter((candidate) => candidate === profile);
    if (selectedProfiles.length === 0) continue;
    const entries = new Map(manifest.tables.map((entry) => [entry.name, entry]));
    let monthRestored = 0;
    for (const table of restoreOrder) {
      const entry = entries.get(table);
      if (!entry) continue;
      const belongs = selectedProfiles.some((selected) => {
        if (selected === 'events') return ['events', 'matches', 'decks', 'standings', 'archetypes', 'players'].includes(table);
        if (selected === 'prices') return ['catalog_items', 'catalog_price_definitions', 'catalog_price_history'].includes(table);
        return ['sets', 'cards', 'products', 'card_catalog_variants', 'card_faces', 'oracle_cards', 'formats', 'card_legalities'].includes(table);
      });
      if (!belongs) continue;
      let keys = keyCache.get(table);
      if (!keys) { keys = await primaryKey(table); keyCache.set(table, keys); }
      await restoreFile(path.join(replicaDir, month, entry.file), table, entry.columns, keys);
      if (verbose) console.log(`  ${month}: ${table}`);
      restored++;
      monthRestored++;
    }
    if (!verbose && monthRestored > 0) console.log(`  ${month}: ${monthRestored} table file(s)`);
  }
  console.log(`\n✓ Restored ${restored} monthly table file(s).`);
}

main()
  .catch((error) => { console.error('\nReplica restore failed:', error); process.exitCode = 1; })
  .finally(() => target.end({ timeout: 5 }));
