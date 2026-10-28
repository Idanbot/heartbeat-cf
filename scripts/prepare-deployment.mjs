import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readPiConfig } from './read-pi-config.mjs';

const path = '.env.deploy.json';
const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const config = { ...previous, ...readPiConfig(), STATUS_TOKEN: previous.STATUS_TOKEN || randomBytes(32).toString('hex') };
writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
chmodSync(path, 0o600);
// Reapply the same token on retries: a failed upload must not become a skipped upload.
{
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', 'STATUS_TOKEN'], { input: config.STATUS_TOKEN + '\n', encoding: 'utf8', timeout: 120000 });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('Deployment configuration saved privately; no credentials printed.');
