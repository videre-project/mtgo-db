import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

const outputFile = process.argv[2] || 'postgres/dump/mtgo_dump.sql';
const outputPath = path.resolve(process.cwd(), outputFile);
const outputDir = path.dirname(outputPath);

// Ensure the output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

console.log(`Exporting database to: ${outputPath}`);
console.log('This may take a few minutes depending on the size of your database.\n');

async function exportDump(): Promise<void> {
  try {
    // Check if Docker container is running
    const checkArgs = ['ps', '--filter', 'name=postgres-prod', '--format', '{{.Names}}'];
    const check = spawn('docker', checkArgs, { stdio: 'pipe' });

    let containerRunning = false;
    check.stdout.on('data', (data) => {
      if (data.toString().trim() === 'postgres-prod') {
        containerRunning = true;
      }
    });

    await new Promise<void>((resolve) => {
      check.on('close', () => resolve());
    });

    if (!containerRunning) {
      console.error('Error: postgres-prod container is not running.');
      console.error('Start it with: pnpm start');
      process.exit(1);
    }

    // Use Docker exec with pg_dump to export the database
    const pgDumpArgs = [
      'exec',
      'postgres-prod',
      'pg_dump',
      '-U',
      process.env.POSTGRES_USER!,
      '-d',
      process.env.POSTGRES_DB!,
      '--clean',
      '--if-exists',
      '--format=plain',
      '--no-owner',
      '--no-privileges',
    ];

    console.log('Running pg_dump...');
    const docker = spawn('docker', pgDumpArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Create write stream for the output file
    const writeStream = fs.createWriteStream(outputPath);
    docker.stdout.pipe(writeStream);

    let stderr = '';
    docker.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    await new Promise<void>((resolve, reject) => {
      docker.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          if (stderr) {
            console.error('Export errors:', stderr);
          }
          reject(new Error(`pg_dump exited with code ${code}`));
        }
      });

      docker.on('error', (err) => {
        reject(new Error(`Failed to spawn docker: ${err.message}`));
      });

      writeStream.on('error', (err) => {
        reject(new Error(`Failed to write to file: ${err.message}`));
      });
    });

    // Wait for write stream to finish
    await new Promise<void>((resolve) => {
      writeStream.end(() => resolve());
    });

    console.log('✓ Database exported successfully!\n');

    // Get file size
    const stats = fs.statSync(outputPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`File: ${outputPath}`);
    console.log(`Size: ${fileSizeMB} MB`);

    // Show table counts
    console.log('\nVerifying export with table counts...');
    const verifyArgs = [
      'exec',
      'postgres-prod',
      'psql',
      '-U',
      process.env.POSTGRES_USER!,
      '-d',
      process.env.POSTGRES_DB!,
      '-t',
      '-c',
      `SELECT 
        table_name, 
        (xpath('/row/count/text()', xml_count))[1]::text::int as row_count
       FROM (
         SELECT 
           table_name, 
           table_schema,
           query_to_xml(format('SELECT COUNT(*) AS count FROM %I.%I', table_schema, table_name), false, true, '') as xml_count
         FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ) t
       ORDER BY table_name;`,
    ];

    const verify = spawn('docker', verifyArgs, { stdio: 'inherit' });

    await new Promise<void>((resolve) => {
      verify.on('close', () => {
        resolve();
      });
    });

    console.log('\n' + '='.repeat(60));
    console.log('Export complete!');
    console.log('='.repeat(60));
    console.log('\nTo migrate to another machine:');
    console.log('1. Copy this repository (including postgres/dump/)');
    console.log('2. Run: pnpm install && pnpm setup-tunnel && pnpm start');
    console.log('\nThe dump will be automatically imported on first startup.');
    console.log('\nNote that credentials for the Cloudflare Tunnel');
    console.log('(located in ' + path.resolve(process.cwd(), 'cloudflared') + '/)');
    console.log('will need to be copied or recreated with pnpm setup-tunnel.');

  } catch (err) {
    console.error('\nError exporting dump:', err);
    process.exit(1);
  }
}

exportDump();
