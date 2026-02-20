param(
  [ValidateSet('prod', 'dev')]
  [string]$Profile = 'prod',

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ComposeArgs
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$monitorScript = Join-Path $PSScriptRoot 'osc-monitor.ps1'
$monitorService = if ($Profile -eq 'dev') { 'bridge-dev' } else { 'bridge' }

Start-Process -FilePath 'powershell' -WorkingDirectory $projectRoot -ArgumentList @(
  '-NoExit',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  $monitorScript,
  '-Service',
  $monitorService
) | Out-Null

Set-Location $projectRoot

$upArgs = @('compose', '--profile', $Profile, 'up', '--build')
if ($ComposeArgs -and $ComposeArgs.Count -gt 0) {
  $upArgs += $ComposeArgs
}

& docker @upArgs
exit $LASTEXITCODE
