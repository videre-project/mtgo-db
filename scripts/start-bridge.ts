import dotenv from 'dotenv';
import { spawn } from "node:child_process";
import { bin, install } from "cloudflared";
import fs from 'node:fs';

dotenv.config();

const main = async () => {
  // Install cloudflared if not present
  const hasCloudflared = await fs.promises.access(bin).then(() => true).catch(() => false);
  if (!hasCloudflared) {
    console.log('Installing cloudflared...');
    await install(bin);
  }

  const tunnelHostname = process.env.CLOUDFLARED_TUNNEL_HOSTNAME || 'db1.videreproject.com';
  // Use standard Postgres port 5432 so that when we spoof DNS, it looks like a real server.
  // Make sure to stop any local postgres service running on 5432 before running this!
  const localPort = 5432;
  const localHost = '127.0.0.1';

  console.log(`\nStarting Cloudflare Tunnel Bridge...`);
  console.log(`Remote: ${tunnelHostname}`);
  console.log(`Local:  ${localHost}:${localPort}`);
  console.log(`\nRun the following to connect:`);
  console.log(`psql -h ${localHost} -p ${localPort} -U videre1 -d mtgo`);
  console.log(`\n(Press Ctrl+C to stop)\n`);

  const accessProcess = spawn(
    bin,
    [
      'access',
      'tcp',
      '--hostname', tunnelHostname,
      '--url', `${localHost}:${localPort}`
    ],
    { stdio: 'inherit' }
  );

  const cleanup = () => {
    console.log('\nStopping bridge...');
    accessProcess.kill();
    process.exit();
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  accessProcess.on('close', (code) => {
    console.log(`Bridge process exited with code ${code}`);
    process.exit(code ?? 0);
  });
};

main().catch(console.error);
