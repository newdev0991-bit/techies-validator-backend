param(
  [string]$TaskName = 'Techies COT pipeline',
  [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
$pipelineDir = [IO.Path]::GetFullPath($PSScriptRoot)
$backendDir = Split-Path -Parent $pipelineDir
$cliPath = Join-Path $pipelineDir 'cli.mjs'
$configPath = Join-Path $pipelineDir 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Prepare pipeline/config.json first.' }
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'Task already exists; inspect it before changing it.' }
$action = New-ScheduledTaskAction -Execute $NodePath -Argument ('"' + $cliPath + '" tick') -WorkingDirectory $backendDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -Disable
# Register DISABLED atomically; installation cannot race the first paid tick.
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Description 'Durable Apify search -> COT/contact validation -> enriched CSV; enabled separately after bounded approval.'
Register-ScheduledTask -TaskName $TaskName -InputObject $task | Select-Object TaskName, State
