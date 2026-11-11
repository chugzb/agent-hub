param([string]$Dir, [string]$Log, [string]$Agent = "default", [string]$HomeDir = "")
# agent-hub 派给 Kiro 的一单（单人、长上下文）：
# 每个员工固定一个家目录，第一次新开会话，之后都用 --resume 接着同一个对话，不每单新开。
# 读用户环境里的 KIRO_API_KEY（不打印），被限流等 90 秒重试，最多 6 次
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$k = $env:HUB_KIRO_EXE
if (-not $k) { $k = Join-Path $env:LOCALAPPDATA 'Kiro-Cli\kiro-cli.exe' }
if (-not (Test-Path -LiteralPath $k)) {
  $found = Get-Command kiro-cli.exe -ErrorAction SilentlyContinue
  if ($found) { $k = $found.Source }
  else { throw 'Kiro CLI not found; set HUB_KIRO_EXE or add it to PATH' }
}
if (-not $HomeDir) { $HomeDir = $Dir }
New-Item -ItemType Directory -Force $HomeDir | Out-Null
$marker = Join-Path $HomeDir '.kiro-session-started'
$prompt = Join-Path $Dir 'PROMPT.md'
$report = Join-Path $Dir 'REPORT.md'
$msg = "【主控派来新的一单】任务目录 $Dir 。先完整读 $prompt ，按里面的全部要求执行；这一单的进度和结论写在 $report （已有内容就是上一轮进度，做完的不重做）。前面对话里做过的事你都记得，可以直接用上。不要派子代理，自己做完：方案 → 实现 → 严格自查。全部做完后最后一行打印 KIRO_JOB_DONE。"
Set-Location $HomeDir
for ($i = 1; $i -le 6; $i++) {
  $args2 = @('chat', '--agent', $Agent, '--no-interactive', '--trust-all-tools')
  if ((Test-Path $marker) -or $i -gt 1) { $args2 += '--resume' }
  & $k @args2 $msg *>> $Log
  $tail = Get-Content $Log -Tail 15 -Encoding Unicode -ErrorAction SilentlyContinue | Out-String
  if ($LASTEXITCODE -eq 0 -or $tail -match 'KIRO_JOB_DONE') { Set-Content $marker (Get-Date -Format s) }
  if ($tail -match 'KIRO_JOB_DONE') { break }
  if ($tail -match 'ClientThrottleError|rate limit|THROTTLING') { Add-Content $Log "`n[hub] 被限流，等 90 秒后接着做（第 $i 次）" -Encoding Unicode; Start-Sleep -Seconds 90; $msg = "接着做刚才那一单（任务目录 $Dir），从断的地方继续，做完最后一行打印 KIRO_JOB_DONE。"; continue }
  break
}
