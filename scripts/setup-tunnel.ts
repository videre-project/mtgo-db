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

function runCloudflared(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit' });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`cloudflared ${args.join(' ')} failed with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

async function cloudflareRequest<T>(
  token: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const body = await response.json() as {
    success: boolean;
    result: T;
    errors?: { code?: number; message: string }[];
  };

  if (!response.ok || !body.success) {
    const errors =
      body.errors?.map((error) => `${error.code ?? ''} ${error.message}`.trim()).join('; ')
      || response.statusText;
    throw new Error(`${options.method ?? 'GET'} ${path} failed: ${errors}`);
  }

  return body.result;
}

function inferZoneName(hostname: string): string {
  const labels = hostname.split('.').filter(Boolean);
  return labels.slice(-2).join('.');
}

async function routeTunnelDns(
  tunnelId: string,
  tunnelName: string,
  hostname: string,
  envVars: Record<string, string>,
): Promise<void> {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? envVars.CLOUDFLARE_API_TOKEN;
  if (!apiToken) {
    await runCloudflared(['tunnel', 'route', 'dns', tunnelName, hostname]);
    return;
  }

  const zoneName = process.env.CLOUDFLARE_ZONE_NAME
    ?? envVars.CLOUDFLARE_ZONE_NAME
    ?? inferZoneName(hostname);
  const zones = await cloudflareRequest<{ id: string }[]>(
    apiToken,
    `/zones?name=${encodeURIComponent(zoneName)}`,
  );
  const zone = zones[0];
  if (!zone) {
    throw new Error(`Cloudflare zone not found: ${zoneName}`);
  }

  const records = await cloudflareRequest<{ id: string }[]>(
    apiToken,
    `/zones/${zone.id}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
  );
  const payload = {
    type: 'CNAME',
    name: hostname,
    content: `${tunnelId}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
    comment: 'Managed by mtgo-db Cloudflare Tunnel split.',
  };

  if (records.length > 0) {
    await cloudflareRequest(
      apiToken,
      `/zones/${zone.id}/dns_records/${records[0].id}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    );
    return;
  }

  await cloudflareRequest(
    apiToken,
    `/zones/${zone.id}/dns_records`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
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

  // Prompt for the hostnames.
  const publicHostname =
    await ask('Enter the public DB hostname [public-db.videreproject.com]: ')
    || 'public-db.videreproject.com';
  const workerHostname =
    await ask('Enter the Worker DB hostname [worker-db.videreproject.com]: ')
    || 'worker-db.videreproject.com';

  // Prepare .env update
  const envPath = path.resolve(process.cwd(), '.env');
  let envLines: string[] = [];
  if (fs.existsSync(envPath)) {
    envLines = fs.readFileSync(envPath, 'utf-8').split('\n');
  }
  let envVars = parseEnvFile(envLines);

  // Route the tunnel to both DNS hostnames.
  for (const hostname of [publicHostname, workerHostname]) {
    console.log(`\nRouting tunnel "${tunnelName}" to DNS hostname "${hostname}"...`);
    try {
      await routeTunnelDns(tunnelId, tunnelName, hostname, envVars);
      console.log(`DNS route created for ${hostname}`);
    } catch (e) {
      console.error('Failed to create DNS route:', e);
      process.exit(1);
    }
  }

  setEnvVar(envLines, 'CLOUDFLARED_PUBLIC_HOSTNAME', publicHostname);
  envVars.CLOUDFLARED_PUBLIC_HOSTNAME = publicHostname;
  setEnvVar(envLines, 'CLOUDFLARED_WORKER_HOSTNAME', workerHostname);
  envVars.CLOUDFLARED_WORKER_HOSTNAME = workerHostname;
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
