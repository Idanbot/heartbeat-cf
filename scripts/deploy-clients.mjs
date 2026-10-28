import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const settings = JSON.parse(readFileSync('.env.deploy.json', 'utf8'));
const target = process.argv[2];
const targets = {
  pi4: { host: 'rpi4', id: 'pi4', name: 'Raspberry Pi 4', mode: 'services', services: 'cloudflared' },
  micro: { host: settings.SSH_TARGETS?.micro, id: 'oci-micro', name: 'OCI VPN', mode: 'tailscale', services: 'tailscaled wg-quick@wg0' },
  pc1: { host: 'pc1', id: 'pc1', name: 'Desktop i7-4770', mode: 'services', services: 'cloudflared' },
};
if (!targets[target]) throw new Error('Usage: node scripts/deploy-clients.mjs pi4|micro|pc1');
const device = targets[target];
if (!device.host || !/^[a-zA-Z0-9@._-]+$/.test(device.host) || device.host.startsWith('-')) {
  throw new Error('Set SSH_TARGETS.micro to your SSH host/alias in private .env.deploy.json');
}
const config = {
  CF_WORKER_URL: settings.CF_WORKER_URL,
  HEARTBEAT_TOKEN: settings.HEARTBEAT_TOKEN,
  HEARTBEAT_DEVICE_ID: device.id,
  HEARTBEAT_DEVICE_NAME: device.name,
  HEALTHCHECK_MODE: device.mode,
  HEARTBEAT_SERVICES: device.services,
};
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
if (target === 'micro') sshOptions.push('-i', join(process.env.HOME, '.ssh/id_ed25519'));
function remote(command) { return execFileSync('ssh', [...sshOptions, device.host, command], { encoding: 'utf8', timeout: 300000 }); }
function powershell(script) {
  return remote('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';\n" + script, 'utf16le').toString('base64'));
}
function copy(local, destination) { execFileSync('scp', [...sshOptions, local, `${device.host}:${destination}`], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }); }
const directory = mkdtempSync(join(tmpdir(), 'heartbeat-deploy-'));
let remoteDirectory;
try {
  if (target === 'pc1') {
    remoteDirectory = powershell(`
      $ErrorActionPreference='Stop'
      $path=Join-Path $env:TEMP ('heartbeat-deploy-' + [Guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $path | Out-Null
      $acl=New-Object Security.AccessControl.DirectorySecurity
      $acl.SetAccessRuleProtection($true,$false)
      foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
      }
      Set-Acl -LiteralPath $path -AclObject $acl
      Write-Output $path.Replace('\\','/')
    `).trim();
    if (!/^[A-Za-z]:\/[\w./ -]+\/heartbeat-deploy-[a-f0-9]+$/.test(remoteDirectory)) throw new Error('Unexpected Windows staging path');
    const configPath = join(directory, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    for (const file of ['src/heartbeat.ps1', 'scripts/install-windows.ps1', configPath]) copy(file, `${remoteDirectory}/`);
    process.stdout.write(powershell(`& '${remoteDirectory}/install-windows.ps1' -SourceDirectory '${remoteDirectory}'`));
  } else {
    remoteDirectory = remote('umask 077; mktemp -d /tmp/heartbeat-deploy.XXXXXXXX').trim();
    if (!/^\/tmp\/heartbeat-deploy\.[A-Za-z0-9]+$/.test(remoteDirectory)) throw new Error('Unexpected Linux staging path');
    const envPath = join(directory, 'heartbeat.env');
    for (const value of Object.values(config)) if (/[\r\n\0]/.test(value)) throw new Error('Control character in configuration');
    writeFileSync(envPath, Object.entries(config).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
    for (const file of ['src/heartbeat.sh', 'scripts/install-linux.sh', 'systemd/device-heartbeat.service', 'systemd/device-heartbeat.timer', envPath]) copy(file, `${remoteDirectory}/`);
    process.stdout.write(remote(`if ! command -v curl >/dev/null || ! command -v jq >/dev/null; then sudo -n apt-get -o Acquire::Retries=5 -o DPkg::Lock::Timeout=300 install -y curl jq >/dev/null || exit; fi; sudo -n bash '${remoteDirectory}/install-linux.sh' '${remoteDirectory}'`));
    if (target === 'pi4') {
      // Back up and remove only the exact legacy active heartbeat cron entry.
      process.stdout.write(remote(`python3 -c 'import pathlib,subprocess,datetime; home=pathlib.Path.home(); p=home/"Scripts"/("heartbeat.crontab.before-"+datetime.datetime.now().strftime("%Y%m%d%H%M%S")); r=subprocess.run(["crontab","-l"],text=True,capture_output=True); p.write_text(r.stdout); p.chmod(0o600); legacy=str(home/"Scripts"/"heartbeat.sh"); lines=[line for line in r.stdout.splitlines() if line.lstrip().startswith("#") or legacy not in line]; subprocess.run(["crontab","-"],input="\\n".join(lines)+"\\n",text=True,check=True); print("Legacy heartbeat cron backed up and disabled")'`));
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
  if (remoteDirectory) {
    if (target === 'pc1' && /^[A-Za-z]:\/[\w./ -]+\/heartbeat-deploy-[a-f0-9]+$/.test(remoteDirectory)) powershell(`Remove-Item -LiteralPath '${remoteDirectory}' -Recurse -Force`);
    else if (/^\/tmp\/heartbeat-deploy\.[A-Za-z0-9]+$/.test(remoteDirectory)) remote(`rm -rf '${remoteDirectory}'`);
  }
}
