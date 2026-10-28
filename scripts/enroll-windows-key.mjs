import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const host = process.argv[2] || 'pc1';
const publicKeyFile = process.argv[3] || join(homedir(), '.ssh', 'id_ed25519.pub');
if (host.startsWith('-') || !/^[a-zA-Z0-9@._-]+$/.test(host)) throw new Error('Invalid SSH host');
const publicKey = readFileSync(publicKeyFile, 'utf8').trim();
if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+(?: .*)?$/.test(publicKey)) throw new Error('Invalid public key');
const script = `
$ErrorActionPreference = 'Stop'
$key = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(publicKey).toString('base64')}'))
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$path = if ($admin) { Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys' } else { Join-Path $env:USERPROFILE '.ssh\\authorized_keys' }
New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
$keys = if (Test-Path $path) { @(Get-Content -LiteralPath $path) } else { @() }
if ($keys -cnotcontains $key) { [IO.File]::WriteAllLines($path, [string[]]($keys + @($key)), [Text.UTF8Encoding]::new($false)) }
$acl = New-Object Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$owner = if ($admin) { [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544') } else { $identity.User }
$acl.SetOwner($owner)
foreach ($sid in @($owner, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
}
Set-Acl -LiteralPath $path -AclObject $acl
Write-Output ('Public key installed in ' + $path)
`;
const result = spawnSync('ssh', ['-tt', '-o', 'PubkeyAuthentication=no', host,
  'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
