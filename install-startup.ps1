param(
    [string]$HomeDir = $env:USERPROFILE,
    [string]$StartupDir = [Environment]::GetFolderPath('Startup')
)
# Register shortcuts only; this script never starts a service or requests elevation.
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $StartupDir | Out-Null
$shell = New-Object -ComObject WScript.Shell
$targets = @{
    'agent-hub-services' = 'run-services.ps1'
    'agent-hub-bridge' = 'run-bridge.ps1'
    'agent-hub-float' = 'start-float.ps1'
}
foreach ($entry in $targets.GetEnumerator()) {
    $file = Join-Path $StartupDir ($entry.Key + '.lnk')
    $launcher = Join-Path $PSScriptRoot $entry.Value
    if (Test-Path -LiteralPath $file) {
        $existing = $shell.CreateShortcut($file)
        if (-not $existing.Arguments.Contains($launcher)) { throw 'Shortcut belongs to another installation; review it before replacing it.' }
    }
    $link = $shell.CreateShortcut($file)
    $link.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $link.Arguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcher + '" -HomeDir "' + $HomeDir + '"'
    $link.WorkingDirectory = $PSScriptRoot
    $link.WindowStyle = 7
    $link.Description = 'Agent Hub Windows'
    $link.Save()
    Write-Output $file
}
