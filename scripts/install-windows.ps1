param([string]$SourceDirectory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$destination = Join-Path $env:ProgramData 'DeviceHeartbeat'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
Set-Acl -LiteralPath $destination -AclObject $acl
Copy-Item -LiteralPath (Join-Path $SourceDirectory 'heartbeat.ps1') -Destination $destination -Force
Copy-Item -LiteralPath (Join-Path $SourceDirectory 'config.json') -Destination $destination -Force
$client = Join-Path $destination 'heartbeat.ps1'
# Validate service health and perform one real delivery before replacing a task.
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $client
if ($LASTEXITCODE -ne 0) { throw 'Initial heartbeat delivery failed; existing schedules were left untouched' }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $client + '"')
$schedule = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$boot = New-ScheduledTaskTrigger -AtStartup
$boot.Delay = 'PT1M'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 100) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'DeviceHeartbeat' -Action $action -Trigger @($schedule, $boot) -Principal $principal -Settings $settings -Force | Out-Null
# Preserve old task definitions as recoverable disabled tasks, never delete them.
Get-ScheduledTask | Where-Object { $_.TaskName -eq 'pc1 Heartbeat' } | Disable-ScheduledTask | Out-Null
Start-ScheduledTask -TaskName 'DeviceHeartbeat'
Write-Output 'DeviceHeartbeat installed: SYSTEM, every five minutes and at startup.'
