param([string]$HomeDir=$env:USERPROFILE,[ValidateRange(1,65535)][int]$Port=4646)
$ErrorActionPreference='Stop'
$script=Join-Path $PSScriptRoot 'float.ps1'
Start-Process powershell.exe -WindowStyle Hidden -WorkingDirectory $PSScriptRoot -ArgumentList @('-NoProfile','-STA','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',('"'+$script+'"'),'-HomeDir',('"'+$HomeDir+'"'),'-Port',$Port)
