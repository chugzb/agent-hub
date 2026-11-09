param([string]$HomeDir = $env:USERPROFILE)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'services.mjs'
$logDir = Join-Path $HomeDir 'agy-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
# 有 ARCHIVE_PAUSED 文件就暂停自动归档（旧 MCP 客户端没重连前不能归档）；删掉文件即恢复
& $node $script --home $HomeDir *>> (Join-Path $logDir 'services.log')
exit $LASTEXITCODE
