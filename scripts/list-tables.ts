import postgres from 'postgres';
import dotenv from 'dotenv';
import { spawn } from "node:child_process";
import { setTimeout } from 'node:timers/promises';
import cf, { bin, install } from "cloudflared";

dotenv.config();

// Install cloudflared if not present
if (!await import('node:fs').then(fs => fs.promises.access(bin).then(() => true).catch(() => false))) {
  console.log('Installing cloudflared...');
  await install(bin);
}

// Local forwarding port for cloudflared access
const localPort = 8000;
const localHost = '127.0.0.1';
const tunnelHostname = process.env.CLOUDFLARED_PUBLIC_HOSTNAME;

if (!tunnelHostname) {
  throw new Error('CLOUDFLARED_PUBLIC_HOSTNAME is required.');
}

console.log(`Starting cloudflared access tunnel to ${tunnelHostname}...`);
console.log(`Forwarding ${localHost}:${localPort} -> ${tunnelHostname}:5432\n`);

// Run cloudflared access to forward the connection
const accessProcess = spawn(
  bin, 
  [
    'access', 
    'tcp', 
    '--hostname', tunnelHostname,
    '--url', `${localHost}:${localPort}`
  ], 
  { stdio: 'pipe' }
);

// Wait for cloudflared to establish connection
await setTimeout(2000);

const sql = postgres({
  host: localHost,
  port: localPort,
  user: 'public_api',
  database: process.env.POSTGRES_DB,
});

async function listTablesWithSchema(): Promise<void> {
  try {
    const tables = await sql`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name;
    `;

    for (const { table_schema, table_name } of tables) {
      console.log(`${table_schema}.${table_name}:`);

      const columns = await sql`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = ${table_schema} AND table_name = ${table_name}
        ORDER BY ordinal_position;
      `;

      columns.forEach(col => {
        console.log(
          `  - ${col.column_name}: ${col.data_type}${col.is_nullable === 'NO' ? ' (NOT NULL)' : ''}`
        );
      });
      console.log('');
    }
  } catch (err) {
    console.error('Error querying tables:', err);
  } finally {
    await sql.end();
    // Kill the cloudflared access process
    accessProcess.kill();
  }
}

listTablesWithSchema();
