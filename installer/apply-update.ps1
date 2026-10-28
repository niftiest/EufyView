# EufyView in-app update applier
#
# Runs OUTSIDE the server process (spawned detached by server/updates.js) so it
# can replace the app's files while the server is stopped, then bring it back.
# This is the "app-files ZIP" update path: it swaps only app code into an
# existing install under %LOCALAPPDATA% (user-writable -> no UAC, no installer),
# and only re-runs `npm install` when dependencies actually changed.
#
# A copy of this script ships inside eufyview-app.zip, so the version being
# installed always applies itself (the updater can update the updater).
#
# Steps: stop the tray (it owns node.exe) -> wait for file locks to release ->
# copy the new files over the install -> npm install if package-lock changed ->
# relaunch the tray. Everything is logged to data\logs\update.log.
#
# Usage (normally invoked by the server, not by hand):
#   powershell -NoProfile -ExecutionPolicy Bypass -File apply-update.ps1 `
#       -InstallDir "<app root>" -SourceDir "<extracted zip>" [-DryRun]

param(
    [Parameter(Mandatory=$true)][string]$InstallDir,
    [Parameter(Mandatory=$true)][string]$SourceDir,
    [string]$NodeExe = "",
    [string]$TrayExe = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
if (-not $NodeExe) { $NodeExe = Join-Path $InstallDir "node\node.exe" }
if (-not $TrayExe) { $TrayExe = Join-Path $InstallDir "EufyViewTray.exe" }

$LogDir = Join-Path $InstallDir "data\logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force $LogDir | Out-Null }
$LogFile = Join-Path $LogDir "update.log"
function Log($msg) {
    $line = "{0} {1}" -f (Get-Date).ToString("o"), $msg
    Add-Content -Path $LogFile -Value $line -Encoding utf8
    Write-Host $line
}

Log "=== apply-update start (DryRun=$DryRun) ==="
Log "InstallDir=$InstallDir"
Log "SourceDir=$SourceDir"

# Sanity: the source must look like an EufyView app tree.
if (-not (Test-Path (Join-Path $SourceDir "package.json"))) { Log "ABORT: no package.json in SourceDir"; exit 2 }
if (-not (Test-Path (Join-Path $InstallDir "main.js")))     { Log "ABORT: InstallDir doesn't look like an install"; exit 2 }

# Decide whether dependencies changed (avoid a multi-minute npm install when the
# update is pure app code, which is the common case).
function HashOf($p) { if (Test-Path $p) { (Get-FileHash $p -Algorithm SHA256).Hash } else { "" } }
$oldLock = HashOf (Join-Path $InstallDir "package-lock.json")
$newLock = HashOf (Join-Path $SourceDir  "package-lock.json")
$depsChanged = ($newLock -ne "") -and ($oldLock -ne $newLock)
Log "depsChanged=$depsChanged (old=$oldLock new=$newLock)"

if ($DryRun) {
    Log "DRY RUN: would stop tray, copy $SourceDir -> $InstallDir, $(if($depsChanged){'run'}else{'skip'}) npm install, relaunch tray"
    # Prove the copy set is valid without touching the install.
    $items = Get-ChildItem -Path $SourceDir -Recurse -File | Measure-Object
    Log "DRY RUN: $($items.Count) files staged"
    Log "=== apply-update end (dry run) ==="
    exit 0
}

# 1. Stop the tray (and its node.exe child) so files aren't locked.
Log "Stopping EufyViewTray.exe tree..."
& taskkill.exe /f /t /im EufyViewTray.exe 2>&1 | Out-Null
# Belt-and-suspenders: also stop any node.exe running main.js from THIS install
# (not other apps' node). Match on the command line's working path.
try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$($InstallDir.Replace('\','\\'))*" } |
        ForEach-Object { Log "Stopping node.exe pid=$($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch { Log "node sweep skipped: $($_.Exception.Message)" }

# 2. Wait for handles to release.
Start-Sleep -Seconds 2

# 3. Copy new files over the install. robocopy is resilient to locked files and
#    returns 0-7 on success (8+ is a real error). We copy only the app dirs/files
#    the ZIP carries; data\ is never touched.
function Copy-Tree($name) {
    $src = Join-Path $SourceDir $name
    if (-not (Test-Path $src)) { return }
    $dst = Join-Path $InstallDir $name
    Log "robocopy $name ..."
    & robocopy $src $dst /E /NFL /NDL /NJH /NJS /R:3 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { Log "robocopy $name FAILED (exit $LASTEXITCODE)"; throw "robocopy failed for $name" }
}
Copy-Tree "server"
Copy-Tree "public"
Copy-Tree "patches"
foreach ($f in @("main.js","package.json","package-lock.json")) {
    $src = Join-Path $SourceDir $f
    if (Test-Path $src) { Log "copy $f"; Copy-Item $src (Join-Path $InstallDir $f) -Force }
}

# 4. npm install only when deps changed (also runs postinstall -> patch-package).
if ($depsChanged) {
    Log "Dependencies changed -> npm install --omit=dev"
    # npm ships inside the bundled node dir (next to node.exe), not the app root.
    $npmCli = Join-Path (Split-Path $NodeExe -Parent) "node_modules\npm\bin\npm-cli.js"
    if (Test-Path $npmCli) {
        Push-Location $InstallDir
        & $NodeExe $npmCli install --omit=dev 2>&1 | ForEach-Object { Log "npm: $_" }
        Pop-Location
    } else {
        Log "WARNING: npm-cli.js not found; skipping install"
    }
} else {
    Log "Dependencies unchanged -> skipping npm install"
}

# 5. Relaunch the tray, which brings the server back up.
Log "Relaunching tray..."
Start-Process -FilePath $TrayExe -WorkingDirectory $InstallDir
Log "=== apply-update done ==="
exit 0
