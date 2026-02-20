param(
  [string]$Service = 'bridge',
  [int]$Tail = 200,
  [int]$WaitSeconds = 1
)

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "[GranuPose] OSC monitor service: $Service"
Write-Host '[GranuPose] Waiting for the container to start...'

while ($true) {
  $containerId = docker compose ps -q $Service 2>$null
  if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($containerId)) {
    break
  }
  Start-Sleep -Seconds $WaitSeconds
}

Write-Host '[GranuPose] Streaming OSC bridge logs (Ctrl+C to stop this monitor window).'
docker compose logs -f --tail=$Tail $Service
