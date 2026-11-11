param([string]$HomeDir = $env:USERPROFILE)
$ErrorActionPreference = 'Stop'
$stateFile = Join-Path $HomeDir 'agy-logs\services.json'
if (-not (Test-Path -LiteralPath $stateFile)) { Write-Output '没有本目录常驻记录'; exit 0 }
$state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\','/')
if ([IO.Path]::GetFullPath($state.root).TrimEnd('\','/') -ne $expectedRoot) { throw '记录来自另一套程序，未停止' }
if ([IO.Path]::GetFullPath($state.home) -ne [IO.Path]::GetFullPath($HomeDir)) { throw '记录来自另一个 home，未停止' }
$service = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)"
if (-not $service) { Write-Output '记录的进程已经退出，请核对后重启'; exit 0 }
$script = Join-Path $expectedRoot 'services.mjs'
if (-not $service.CommandLine.Contains($script)) { throw 'PID 已被其他程序使用，未停止' }
# Kill only this verified supervisor and its own children. Never kill by image name.
& taskkill.exe /PID $state.pid /T /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw '未能停止常驻进程树' }
foreach ($file in @($stateFile, (Join-Path $HomeDir 'agy-logs\.services.lock'))) {
  if (Test-Path -LiteralPath $file) {
    $record = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($record.pid -eq $state.pid) { Remove-Item -LiteralPath $file }
  }
}
Write-Output '已停止核对过的看板常驻及子进程'
