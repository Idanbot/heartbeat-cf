param(
    [string]$ConfigPath = "$env:ProgramData\DeviceHeartbeat\config.json",
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if (-not $config.CF_WORKER_URL -or -not $config.HEARTBEAT_TOKEN) { throw 'Missing Worker URL or heartbeat token' }
if (([Uri]$config.CF_WORKER_URL).Scheme -ne 'https') { throw 'Worker URL must use HTTPS' }
$mode = if ($config.HEALTHCHECK_MODE) { [string]$config.HEALTHCHECK_MODE } else { 'tunnel' }
if ($mode -notin @('tunnel', 'services', 'tailscale')) { throw 'Invalid HEALTHCHECK_MODE' }
if ($mode -eq 'tunnel' -and ((-not $config.HEALTHCHECK_URL) -or ([Uri]$config.HEALTHCHECK_URL).Scheme -ne 'https')) { throw 'Tunnel mode requires an HTTPS health URL' }
$services = if ($config.HEARTBEAT_SERVICES) { ([string]$config.HEARTBEAT_SERVICES) -split '\s+' } elseif ($mode -eq 'tailscale') { @('Tailscale') } else { @('cloudflared') }
$healthy = 1
foreach ($name in $services) {
    $service = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $service -or $service.Status -ne 'Running') { $healthy = 0 }
}
if ($healthy -eq 1 -and $mode -eq 'tailscale') {
    try {
        $status = (& tailscale.exe status --json | ConvertFrom-Json)
        if ($LASTEXITCODE -ne 0 -or $status.BackendState -ne 'Running') { $healthy = 0 }
    } catch { $healthy = 0 }
}
if ($healthy -eq 1 -and $mode -eq 'tunnel') {
    try {
        # Follow a bounded chain manually so an HTTPS probe never downgrades.
        $uri = [Uri]$config.HEALTHCHECK_URL
        $ok = $false
        for ($redirect = 0; $redirect -le 3; $redirect++) {
            if ($uri.Scheme -ne 'https') { throw 'Insecure health redirect' }
            $request = [Net.HttpWebRequest]::Create($uri)
            $request.AllowAutoRedirect = $false
            $request.Timeout = 10000
            $request.ReadWriteTimeout = 10000
            $response = $request.GetResponse()
            try {
                $code = [int]$response.StatusCode
                if ($code -ge 200 -and $code -lt 300) { $ok = $true; break }
                if ($code -ge 300 -and $code -lt 400 -and $response.Headers['Location']) {
                    $uri = [Uri]::new($uri, $response.Headers['Location'])
                } else { break }
            } finally { $response.Close() }
        }
        if (-not $ok) { $healthy = 0 }
    } catch { $healthy = 0 }
}
$id = if ($config.HEARTBEAT_DEVICE_ID) { $config.HEARTBEAT_DEVICE_ID } else { $env:COMPUTERNAME }
$name = if ($config.HEARTBEAT_DEVICE_NAME) { $config.HEARTBEAT_DEVICE_NAME } else { $id }
$payload = @{ id = $id; name = $name; heartbeat = $healthy } | ConvertTo-Json -Compress
if ($ValidateOnly) { Write-Output $payload; exit 0 }
$url = ([string]$config.CF_WORKER_URL).TrimEnd('/') + '/heartbeat'
for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
        $response = Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Headers @{ 'x-heartbeat-token' = $config.HEARTBEAT_TOKEN } -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 15 -MaximumRedirection 0
        if ($response.ok -ne $true -or $response.persisted -isnot [bool]) { throw 'Unexpected Worker response' }
        Write-Output ("Heartbeat delivered: id=$id heartbeat=$healthy")
        exit 0
    } catch {
        if ($attempt -eq 3) { throw "Heartbeat delivery failed: id=$id" }
        Start-Sleep -Seconds 2
    }
}
