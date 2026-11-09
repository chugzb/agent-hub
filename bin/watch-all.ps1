param([string[]]$Roles = @(), [string]$HomeDir = $env:USERPROFILE)
# Optional Windows Terminal viewers; enabled roles come from the role registry.
$ErrorActionPreference = 'Stop'
if (-not $Roles.Count) {
    $rolesFile = $env:HUB_ROLES
    if (-not $rolesFile) { $rolesFile = Join-Path $HomeDir '.config\agy-team\roles.json' }
    $registered = Get-Content -LiteralPath $rolesFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $Roles = @($registered.PSObject.Properties | Where-Object { -not $_.Value.disabled } | ForEach-Object { $_.Name })
}
if (-not $Roles.Count) { throw 'No enabled roles in the registry' }
$env:HUB_HOME = $HomeDir
$viewer = Join-Path $PSScriptRoot 'watch-worker.mjs'
$tabs = foreach ($role in $Roles) {
    if ($role -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Terminal viewer requires simple role identifiers' }
    'new-tab --title "' + $role + '" cmd /k node "' + $viewer + '" ' + $role
}
Start-Process wt.exe -WindowStyle Hidden -ArgumentList ('-w new ' + ($tabs -join ' ; '))
