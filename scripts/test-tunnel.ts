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

const tunnelLocalPort = 18_000;
const localHost = '127.0.0.1';
const tunnelHostname = process.env.CLOUDFLARED_PUBLIC_HOSTNAME;

if (!tunnelHostname) {
  throw new Error('CLOUDFLARED_PUBLIC_HOSTNAME is required.');
}

console.log(`Testing tunnel connection to ${tunnelHostname}...`);
console.log(`Database: ${process.env.POSTGRES_DB}\n`);

console.log('Test 1: Direct local connection');
console.log(`Connecting to ${localHost}:6434`);

const sqlDirect = postgres({
  host: localHost,
  port: 6434,
  user: 'public_api',
  database: process.env.POSTGRES_DB,
  connect_timeout: 10,
});

try {
  const start1 = Date.now();
  const result1 = await sqlDirect`SELECT inet_server_addr() as server_ip, inet_server_port() as server_port, current_user`;
  const elapsed1 = Date.now() - start1;
  
  console.log(`Direct connection successful (${elapsed1}ms)`);
  console.log(`Server: ${result1[0].server_ip}:${result1[0].server_port}`);
  console.log(`User: ${result1[0].current_user}\n`);
} catch (err: any) {
  console.log(`Direct connection failed: ${err.message}\n`);
}

await sqlDirect.end();

console.log('Test 2: Cloudflare tunnel connection');
console.log(`Forwarding ${localHost}:${tunnelLocalPort} -> ${tunnelHostname}:5432`);

const accessProcess = spawn(
  bin, 
  [
    'access', 
    'tcp', 
    '--hostname', tunnelHostname,
    '--url', `${localHost}:${tunnelLocalPort}`
  ], 
  { stdio: 'inherit' }
);

// Wait for cloudflared to establish connection
await setTimeout(3_000);

const sqlTunnel = postgres({
  host: localHost,
  port: tunnelLocalPort,
  user: 'public_api',
  database: process.env.POSTGRES_DB,
  connect_timeout: 10,
});

async function testTunnelConnection(): Promise<void> {
  try {
    const start2 = Date.now();
    const result2 = await sqlTunnel`SELECT inet_server_addr() as server_ip, inet_server_port() as server_port, current_user, version()`;
    const elapsed2 = Date.now() - start2;
    
    console.log(`Tunnel connection successful (${elapsed2}ms)`);
    console.log(`Server: ${result2[0].server_ip}:${result2[0].server_port}`);
    console.log(`User: ${result2[0].current_user}`);
    
    const tables = await sqlTunnel`
      SELECT COUNT(*) as count
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
    `;
    console.log(`Tables: ${tables[0].count}\n`);
    
    console.log('Both connection methods verified successfully.');
  } catch (err: any) {
    console.error(`Tunnel connection failed: ${err.message}`);
    if (err.code) {
      console.error(`Error code: ${err.code}`);
    }
  } finally {
    await sqlTunnel.end();
    accessProcess.kill();
  }
}

testTunnelConnection();
