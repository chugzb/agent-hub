param([string]$DesktopDir=[Environment]::GetFolderPath('Desktop'),[string]$HomeDir=$env:USERPROFILE)
$ErrorActionPreference='Stop'
$file=Join-Path $DesktopDir '员工悬浮窗.lnk'
$shell=New-Object -ComObject WScript.Shell
if(Test-Path -LiteralPath $file){$existing=$shell.CreateShortcut($file);if($existing.Arguments -notlike '*start-float.ps1*'){throw 'Existing shortcut belongs to another application'}}
$link=$shell.CreateShortcut($file);$link.TargetPath=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$link.Arguments='-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'start-float.ps1')+'" -HomeDir "'+$HomeDir+'"'
$link.WorkingDirectory=$PSScriptRoot;$link.Description='本机员工状态悬浮窗';$link.WindowStyle=7;$link.Save()
Write-Output $file
