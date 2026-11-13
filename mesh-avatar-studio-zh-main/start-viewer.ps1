$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$port = 8787
$url = "http://127.0.0.1:$port/viewer.html"

function Test-Port {
  param([int]$Port)
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect('127.0.0.1', $Port)
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

if (Test-Port $port) {
  if ($env:VIEWER_NO_BROWSER -ne '1') { Start-Process $url }
  Write-Host "Preview already running: $url"
  Start-Sleep -Seconds 3
  exit 0
}

$job = Start-Job -ScriptBlock {
  param($dir, $p)
  Set-Location $dir
  python -m http.server $p --bind 127.0.0.1
} -ArgumentList $root, $port

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  if (Test-Port $port) { $ready = $true; break }
}

if (-not $ready) {
  Write-Host "Failed to start the local server. Is Python installed and on PATH?"
  Receive-Job $job
  Remove-Job $job -Force
  exit 1
}

if ($env:VIEWER_NO_BROWSER -ne '1') { Start-Process $url }
Write-Host ""
Write-Host "Leitingmiao preview: $url"
Write-Host "Close this window to stop the local server."
Wait-Job $job | Out-Null
