import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();

// import { spawn } from "node:child_process";
// import cf, { bin, install } from "cloudflared";
// // Run cloudflared access to connect to the PostgreSQL database
// const host = '127.0.0.1:8000'
// // await new Promise<void>((resolve) =>
//   spawn(bin, ['access', 'tcp', '--hostname', process.env.CLOUDFLARED_TUNNEL_HOSTNAME!, '--url', host], { stdio: 'inherit' });
// // );
// import { setTimeout } from 'node:timers/promises';
// await setTimeout(500);

const sql = postgres({
  // host: process.env.CLOUDFLARED_TUNNEL_HOSTNAME,
  // port: 80,
  host: '127.0.0.1',
  port: 8000, // Port where cloudflared is forwarding the connection
  // // host: process.env.CLOUDFLARED_TUNNEL_HOSTNAME,
  // // host: "db1.videreproject.com",
  // // port: 6543,//Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
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
  }
}

listTablesWithSchema();