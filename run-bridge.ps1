param([string]$HomeDir = $env:USERPROFILE)
$ErrorActionPreference = 'Stop'
$env:HUB_HOME = [IO.Path]::GetFullPath($HomeDir)
$node = (Get-Command node.exe -ErrorAction Stop).Source
$logDir = Join-Path $HomeDir 'agy-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
while ($true) {
    & $node (Join-Path $PSScriptRoot 'bin\hub-bridge.mjs') *>> (Join-Path $logDir 'hub-bridge.out.log')
    Start-Sleep -Seconds 5
}
