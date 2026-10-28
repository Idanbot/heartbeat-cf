import { execFileSync } from 'node:child_process';

export function readPiConfig() {
  const command = `bash -c 'set -a; source "$HOME/Scripts/heartbeat.env"; python3 -c "import os,json; print(json.dumps({k:os.environ.get(k) for k in [\\\"CF_WORKER_URL\\\",\\\"HEARTBEAT_TOKEN\\\"]}))"'`;
  // Keep credentials in process memory; never print them or place them in argv.
  const result = execFileSync('ssh', ['-o', 'BatchMode=yes', 'rpi4', command], { encoding: 'utf8', timeout: 45000 });
  const config = JSON.parse(result);
  if (!config.CF_WORKER_URL?.startsWith('https://') || !config.HEARTBEAT_TOKEN) throw new Error('Incomplete Pi heartbeat configuration');
  return config;
}
