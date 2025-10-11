import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

const dumpFile = process.argv[2];

if (!dumpFile) {
  console.error('Usage: pnpm run import-dump <dump-file>');
  console.error('Example: pnpm run import-dump postgres/dump/mtgo_dump.sql');
  process.exit(1);
}

const dumpPath = path.resolve(process.cwd(), dumpFile);

if (!fs.existsSync(dumpPath)) {
  console.error(`Error: Dump file not found at ${dumpPath}`);
  process.exit(1);
}

console.log(`Reading dump file: ${dumpPath}`);
console.log('Importing database dump via Docker exec...');
console.log('This may take a few minutes depending on the size of the dump.\n');

async function importDump(): Promise<void> {
  try {
    // Use Docker exec with psql to import the dump
    const psqlArgs = [
      'exec',
      '-i',
      'postgres-prod',
      'psql',
      '-U',
      process.env.POSTGRES_USER!,
      '-d',
      process.env.POSTGRES_DB!,
    ];

    const docker = spawn('docker', psqlArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Stream the dump file to psql
    const dumpStream = fs.createReadStream(dumpPath);
    dumpStream.pipe(docker.stdin);

    let stdout = '';
    let stderr = '';

    docker.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    docker.stderr.on('data', (data) => {
      const errorText = data.toString();
      // Filter out ownership errors
      if (!errorText.includes('role') && !errorText.includes('does not exist')) {
        stderr += errorText;
      }
    });

    await new Promise<void>((resolve, reject) => {
      docker.on('close', (code) => {
        if (code === 0) {
          console.log('✓ Database dump imported successfully!\n');
          resolve();
        } else {
          if (stderr) {
            console.error('Import errors:', stderr);
          }
          reject(new Error(`psql exited with code ${code}`));
        }
      });

      docker.on('error', (err) => {
        reject(new Error(`Failed to spawn docker: ${err.message}`));
      });
    });

    // Verify import by counting tables
    console.log('Verifying import...');
    const verifyArgs = [
      'exec',
      'postgres-prod',
      'psql',
      '-U',
      process.env.POSTGRES_USER!,
      '-d',
      process.env.POSTGRES_DB!,
      '-c',
      `SELECT table_name, 
              (SELECT COUNT(*) FROM information_schema.columns 
               WHERE table_schema = 'public' AND table_name = t.table_name) as columns
       FROM information_schema.tables t
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name;`,
    ];

    const verify = spawn('docker', verifyArgs, { stdio: 'inherit' });

    await new Promise<void>((resolve, reject) => {
      verify.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Verification failed with code ${code}`));
        }
      });
    });

  } catch (err) {
    console.error('Error importing dump:', err);
    process.exit(1);
  }
}

importDump();
