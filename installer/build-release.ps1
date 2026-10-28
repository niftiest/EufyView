# EufyView Release Build + Publish
#
# Cuts a GitHub release from the current source: builds the Windows installer,
# packages an app-files-only update ZIP (the artifact the in-app updater pulls),
# bundles the TV APK if present, and publishes it all under a vX.Y.Z tag.
#
# The update ZIP deliberately contains ONLY replaceable app code (server/,
# public/, main.js, package.json, package-lock.json, patches/). It does NOT
# carry the bundled Node/FFmpeg or node_modules - so the in-app updater can
# extract it straight into %LOCALAPPDATA%\EufyView (user-writable, no UAC) and
# just run `npm install` if package-lock changed. The full installer stays for
# first installs and the rare Node/FFmpeg bump.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File build-release.ps1                 # build + publish v<package.json version>
#   powershell ... -File build-release.ps1 -DryRun                             # build assets only, do NOT publish
#   powershell ... -File build-release.ps1 -SkipInstaller                      # reuse dist\EufyView-Setup.exe, don't rebuild it
#   powershell ... -File build-release.ps1 -Tag v0.4.0 -NotesFile notes.md     # explicit tag + notes
#   powershell ... -File build-release.ps1 -Draft                              # publish as a draft release
#
# Prereqs: gh CLI authenticated (`gh auth status`), plus build-installer.ps1's
# prereqs (Inno Setup 6) unless -SkipInstaller / -DryRun skips the installer.

param(
    [string]$Tag = "",
    [string]$Notes = "",
    [string]$NotesFile = "",
    [switch]$SkipInstaller,
    [switch]$DryRun,
    [switch]$Draft
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$DistDir   = Join-Path $ScriptDir "dist"
$BuildCache = Join-Path $ScriptDir "build-cache"

Write-Host "=== EufyView Release Build ===" -ForegroundColor Cyan

# --- Version / tag ---
$pkg = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
$Version = $pkg.version
if (-not $Version) { throw "Could not read version from package.json" }
if (-not $Tag) { $Tag = "v$Version" }
Write-Host "Version: $Version   Tag: $Tag" -ForegroundColor Green

# Guard: the installer script's MyAppVersion should match package.json so the
# published installer reports the right version to the update checker.
$iss = Get-Content (Join-Path $ScriptDir "EufyView-Setup.iss") -Raw
$issVer = ([regex]::Match($iss, '#define\s+MyAppVersion\s+"([^"]+)"')).Groups[1].Value
if ($issVer -ne $Version) {
    Write-Host "WARNING: EufyView-Setup.iss MyAppVersion ($issVer) != package.json ($Version)." -ForegroundColor Yellow
    Write-Host "         Bump both before releasing so versions stay in sync." -ForegroundColor Yellow
}

if (-not (Test-Path $DistDir)) { New-Item -ItemType Directory -Path $DistDir | Out-Null }

# --- 1. Windows installer ---
$InstallerExe = Join-Path $DistDir "EufyView-Setup.exe"
if ($SkipInstaller -or $DryRun) {
    if (Test-Path $InstallerExe) { Write-Host "[1/3] Reusing existing installer: $InstallerExe" -ForegroundColor Green }
    else { Write-Host "[1/3] No installer present (skipped) - it won't be attached" -ForegroundColor Yellow }
} else {
    Write-Host "[1/3] Building Windows installer..." -ForegroundColor Yellow
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "build-installer.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Installer build failed" }
}

# --- 2. App-files update ZIP ---
Write-Host "[2/3] Packaging app update ZIP..." -ForegroundColor Yellow
$ZipPath = Join-Path $DistDir "eufyview-app.zip"
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }

$staging = Join-Path $BuildCache "_app_zip"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

# Replaceable app code only - mirrors the [Files] app sources in the .iss.
Copy-Item (Join-Path $RepoRoot "server")  (Join-Path $staging "server")  -Recurse
Copy-Item (Join-Path $RepoRoot "public")  (Join-Path $staging "public")  -Recurse
Copy-Item (Join-Path $RepoRoot "main.js") (Join-Path $staging "main.js")
Copy-Item (Join-Path $RepoRoot "package.json") (Join-Path $staging "package.json")
if (Test-Path (Join-Path $RepoRoot "package-lock.json")) {
    Copy-Item (Join-Path $RepoRoot "package-lock.json") (Join-Path $staging "package-lock.json")
}
if (Test-Path (Join-Path $RepoRoot "patches")) {
    Copy-Item (Join-Path $RepoRoot "patches") (Join-Path $staging "patches") -Recurse
}
# The update applier ships inside the ZIP so the version being installed always
# applies itself (server/updates.js runs it from the extracted temp dir).
Copy-Item (Join-Path $ScriptDir "apply-update.ps1") (Join-Path $staging "apply-update.ps1")

# A manifest the updater reads to sanity-check what it fetched.
$manifest = [ordered]@{
    version   = $Version
    tag       = $Tag
    builtAt   = (Get-Date).ToUniversalTime().ToString("o")
    contents  = @("server", "public", "main.js", "package.json", "package-lock.json", "patches", "apply-update.ps1")
}
[System.IO.File]::WriteAllText(
    (Join-Path $staging "update-manifest.json"),
    ($manifest | ConvertTo-Json)
)

Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $ZipPath -Force
Remove-Item $staging -Recurse -Force
$zipMB = [math]::Round((Get-Item $ZipPath).Length / 1MB, 2)
# Record a SHA-256 so the updater (and the release notes) can verify the download.
$zipHash = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLower()
Write-Host "      eufyview-app.zip: $zipMB MB  sha256=$zipHash" -ForegroundColor Green

# --- 3. Collect assets + publish ---
$assets = @()
if (Test-Path $InstallerExe) { $assets += $InstallerExe }
$assets += $ZipPath
$tvApk = Join-Path $BuildCache "EufyView-TV.apk"
$tvVer = Join-Path $BuildCache "EufyView-TV.apk.version"
if (Test-Path $tvApk) { $assets += $tvApk }
if (Test-Path $tvVer) { $assets += $tvVer }

Write-Host "[3/3] Assets:" -ForegroundColor Yellow
$assets | ForEach-Object { Write-Host "      $_" }

# Resolve release notes.
if ($NotesFile -and (Test-Path $NotesFile)) { $Notes = Get-Content $NotesFile -Raw }
if (-not $Notes) {
    $Notes = "EufyView $Tag`n`nApp update ZIP sha256: $zipHash"
} else {
    $Notes = "$Notes`n`nApp update ZIP sha256: $zipHash"
}

if ($DryRun) {
    Write-Host ""
    Write-Host "DRY RUN - assets built, nothing published." -ForegroundColor Cyan
    Write-Host "To publish: re-run without -DryRun (creates/updates release $Tag)." -ForegroundColor Cyan
    return
}

# Publish. If the tag already has a release, upload/replace assets on it;
# otherwise create it.
$notesTmp = Join-Path $env:TEMP "eufyview-release-notes.md"
[System.IO.File]::WriteAllText($notesTmp, $Notes)

# Does a release for this tag already exist? gh writes "release not found" to
# stderr when it doesn't, which under ErrorActionPreference=Stop would abort the
# script - so suppress all streams and judge purely by the exit code.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
& gh release view $Tag --repo niftiest/EufyView *> $null
$releaseExists = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prevEAP

if ($releaseExists) {
    Write-Host "Release $Tag exists - uploading/replacing assets..." -ForegroundColor Yellow
    & gh release upload $Tag @assets --repo niftiest/EufyView --clobber
} else {
    Write-Host "Creating release $Tag..." -ForegroundColor Yellow
    $ghArgs = @("release", "create", $Tag) + $assets + @(
        "--repo", "niftiest/EufyView",
        "--title", "EufyView $Tag",
        "--notes-file", $notesTmp
    )
    if ($Draft) { $ghArgs += "--draft" }
    & gh @ghArgs
}
if ($LASTEXITCODE -ne 0) { throw "gh release publish failed" }

Write-Host ""
Write-Host "=== Release $Tag published ===" -ForegroundColor Green
