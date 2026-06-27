import dotenv from 'dotenv';
import postgres from 'postgres';

dotenv.config();

const sql = postgres({
  host: process.env.API_DB_HOST ?? process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.API_DB_PORT ?? process.env.PGPORT ?? 6432),
  database: process.env.API_DB_DATABASE ?? process.env.PGDATABASE ?? 'mtgo',
  username: process.env.API_DB_USER ?? process.env.PGUSER ?? 'public_api',
  password: process.env.API_DB_PASSWORD ?? process.env.PGPASSWORD,
  ssl: (process.env.API_DB_SSL ?? process.env.PGSSL ?? 'false') === 'true'
    ? 'require'
    : false,
});

async function main(): Promise<void> {
  const [settings] = await sql`
    SELECT
      current_user,
      current_database(),
      current_setting('default_transaction_read_only') AS default_transaction_read_only,
      current_setting('statement_timeout') AS statement_timeout,
      current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout,
      current_setting('idle_session_timeout') AS idle_session_timeout,
      current_setting('lock_timeout') AS lock_timeout,
      current_setting('temp_file_limit') AS temp_file_limit,
      current_setting('work_mem') AS work_mem;
  `;

  console.log('Connected as:');
  console.table([settings]);

  if (settings.current_user !== 'public_api') {
    throw new Error(`Expected current_user to be public_api, got ${settings.current_user}.`);
  }

  if (settings.default_transaction_read_only !== 'on') {
    throw new Error('Expected default_transaction_read_only to be on.');
  }

  await assertSucceeds('read public event data', async () => {
    const [row] = await sql`SELECT count(*)::int AS event_count FROM events;`;
    console.log(`Read check returned ${row.event_count} events.`);
  });

  await assertFails('reject UPDATE against public tables', async () => {
    await sql`UPDATE events SET id = id WHERE false;`;
  });

  await assertFails('reject schema creation', async () => {
    await sql`CREATE TABLE public.api_write_probe(id int);`;
  });

  await assertFails('cancel slow query by statement_timeout', async () => {
    await sql`SELECT pg_sleep(6);`;
  });
}

async function assertSucceeds(label: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  console.log(`[ok] ${label}`);
}

async function assertFails(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.log(`[ok] ${label}: ${String((error as Error).message).split('\n')[0]}`);
    return;
  }

  throw new Error(`Expected failure: ${label}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });
