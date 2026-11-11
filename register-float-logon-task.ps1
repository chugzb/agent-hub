param([string]$HomeDir=$env:USERPROFILE)
# Optional only: Run this explicitly if needed. Installation does not call it.
$ErrorActionPreference='Stop'
$name='AgentHubWindowsFloat'
if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){throw 'Task exists; refusing to overwrite'}
$arguments='-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'start-float.ps1')+'" -HomeDir "'+$HomeDir+'"'
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger=New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal=New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
