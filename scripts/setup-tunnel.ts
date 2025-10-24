import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import type { Connection } from "cloudflared";
import cf, { bin, install } from "cloudflared";


function ask(query: string): Promise<string> {
  const rl: readline.Interface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<string>((resolve) =>
    rl.question(query, (ans: string) => {
      rl.close();
      resolve(ans.trim());
    }),
  );
}

function setEnvVar(lines: string[], key: string, value: string): void {
  const idx = lines.findIndex(line => line.match(new RegExp(`^${key}\\s*=`)));
  if (idx !== -1) {
    lines[idx] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }
}

function parseEnvFile(lines: string[]): Record<string, string> {
  const envObj: Record<string, string> = {};
  for (const line of lines) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      envObj[match[1]] = match[2];
    }
  }
  return envObj;
}

async function main() {
  console.log('== Cloudflared Tunnel Setup ==');

  // Install cloudflared binary
  if (!fs.existsSync(bin)) {
    await install(bin);
    // spawn(bin, ["--version"], { stdio: "inherit" });
  }

  // Prompt for login via cli
  const doLogin = await ask('Do you want to run "cloudflared tunnel login"? (Y/n): ');
  if (doLogin.toLowerCase() !== 'n') {
    console.log('\nRunning cloudflared tunnel login...');
    try {
      const loginProcess = spawn(bin, ['tunnel', 'login'], { stdio: 'inherit' });
      await new Promise<void>((resolve, reject) => {
        loginProcess.on('close', (code) => {
          if (code === 0) {
            console.log('Login complete.\n');
            resolve();
          } else {
            reject(new Error(`cloudflared tunnel login failed with code ${code}`));
          }
        });
      });
    } catch (error) {
      console.error('Failed to run cloudflared tunnel login:', error);
      process.exit(1);
    }
  }

  // Prompt for tunnel name
  let tunnelName = await ask('Enter a tunnel name: ');
  if (!tunnelName) {
    console.error('Tunnel name is required.');
    process.exit(1);
  }

  // Override any previous tunnels with the same name
  await new Promise<void>((resolve) => {
    spawn(bin, ['tunnel', 'delete', tunnelName]).on('close', () => resolve());
  });
  await new Promise<void>((resolve) => {
    spawn(bin, ["tunnel", "create", tunnelName]).on('close', () => resolve());
  });

  // Run the tunnel and wait for connection before disconnecting
  const tunnel = new cf.Tunnel(["tunnel", "run", tunnelName]);
  const connection = await new Promise<Connection>((resolve, reject) => {
    tunnel.once('connected', (t) => { tunnel.stop(); resolve(t); });
    tunnel.once('error', reject);
  });

  const configDir = path.resolve(process.cwd(), 'cloudflared');
  const credentialsFile = path.resolve(configDir, `.${connection.id}.json`);
  spawn(bin, ["tunnel", "token", "--cred-file", credentialsFile, tunnelName], { stdio: "inherit" });

  // Wait for the file to be written
  while (!fs.existsSync(credentialsFile)) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Read the tunnel id from the credentials JSON file
  const tunnelId = JSON.parse(fs.readFileSync(credentialsFile, 'utf-8')).TunnelID;
  fs.renameSync(credentialsFile, path.join(configDir, `${tunnelId}.json`));

  // Prompt for the hostname
  const hostname = await ask('Enter the custom DNS hostname for your tunnel (e.g., pgbouncer.example.com): ');
  if (!hostname) {
    console.error('Hostname is required.');
    process.exit(1);
  }

  // Route the tunnel to the DNS hostname
  console.log(`\nRouting tunnel "${tunnelName}" to DNS hostname "${hostname}"...`);
  try {
    spawn(bin, ['tunnel', 'route', 'dns', tunnelName, hostname], { stdio: 'inherit' });
    console.log(`DNS route created for ${hostname}`);
  } catch (e) {
    console.error('Failed to create DNS route:', e);
    process.exit(1);
  }

  // Prepare .env update
  const envPath = path.resolve(process.cwd(), '.env');
  let envLines: string[] = [];
  if (fs.existsSync(envPath)) {
    envLines = fs.readFileSync(envPath, 'utf-8').split('\n');
  }
  let envVars = parseEnvFile(envLines);

  setEnvVar(envLines, 'CLOUDFLARED_TUNNEL_HOSTNAME', hostname);
  envVars.CLOUDFLARED_TUNNEL_HOSTNAME = hostname;
  setEnvVar(envLines, 'CLOUDFLARED_TUNNEL_NAME', tunnelName);
  envVars.CLOUDFLARED_TUNNEL_NAME = tunnelName;
  setEnvVar(envLines, 'CLOUDFLARED_TUNNEL_ID', tunnelId);
  envVars.CLOUDFLARED_TUNNEL_ID = tunnelId;
  fs.writeFileSync(envPath, envLines.filter(l => l.trim() !== '').join('\n'));

  console.log('Updated .env with tunnel information.\n');
  envVars = parseEnvFile(envLines);

  // Read from ./cloudflared/config.template.yml
  const templatePath = path.resolve(configDir, 'config.template.yml');
  const template = fs.readFileSync(templatePath, 'utf-8');

  // Replace all env variables in the template with their values
  const configYml = template.replace(/\$\{([A-Z_]+)\}/g, (_, key) => {
    const value = process.env[key] ?? envVars[key];
    if (value === undefined) {
      console.warn(`Warning: Environment variable ${key} is not set.`);
      return '';
    }
    return value;
  });

  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'config.yml'), configYml);
  console.log('Wrote cloudflared/config.yml with tunnel configuration.');
}


main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
