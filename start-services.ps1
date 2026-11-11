param([string]$HomeDir = $env:USERPROFILE)
$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'services.mjs'
# This helper starts only the staged services; scheduled-task registration is a separate explicit step.
Start-Process -FilePath $node -WindowStyle Hidden -WorkingDirectory $PSScriptRoot -ArgumentList @('"'+$script+'"','--home','"'+$HomeDir+'"')
