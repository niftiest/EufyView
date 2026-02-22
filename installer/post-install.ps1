# EufyView Post-Install Script
# Called by Inno Setup after file extraction

param(
    [Parameter(Mandatory=$true)] [string]$InstallDir,
    [Parameter(Mandatory=$true)] [string]$NetworkMode,
    [int]$Port = 3001,
    [string]$CloudflareToken = "",
    [Parameter(Mandatory=$true)] [string]$EufyUsername,
    [Parameter(Mandatory=$true)] [string]$EufyPassword,
    [string]$EufyCountry = "US",
    [string]$EufyLanguage = "en"
)

$ErrorActionPreference = "Continue"
$LogFile = Join-Path $InstallDir "install.log"
$ResultsFile = Join-Path $InstallDir "install-results.txt"

# Track what we did for the summary
$summary = @()
$warnings = @()

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

# --- Get local IP address ---
function Get-LocalIP {
    try {
        $ip = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Ethernet*","Wi-Fi*" -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notmatch "^(127\.|169\.254\.)" } |
            Select-Object -First 1).IPAddress
        if (-not $ip) {
            $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                Where-Object { $_.IPAddress -notmatch "^(127\.|169\.254\.)" } |
                Select-Object -First 1).IPAddress
        }
        return $ip
    } catch {
        return $null
    }
}

# --- Setup PATH to use bundled Node.js ---
$NodeDir = Join-Path $InstallDir "node"
$FfmpegDir = Join-Path $InstallDir "ffmpeg"
$env:PATH = "$NodeDir;$FfmpegDir;$env:PATH"

Log "=== EufyView Post-Install ==="
Log "InstallDir:        $InstallDir"
Log "NetworkMode:       $NetworkMode"
Log "Port:              $Port"
Log "EufyUsername:      $EufyUsername"
Log "EufyCountry:       $EufyCountry"
Log "NodeDir:           $NodeDir"
Log "Node version:      $(& "$NodeDir\node.exe" --version 2>&1)"

# --- 1. npm install ---
Log "Running npm install..."
Push-Location $InstallDir
try {
    $npmOutput = & "$NodeDir\npm.cmd" install --omit=dev 2>&1 | Out-String
    Log "npm install output (last 500 chars): $($npmOutput.Substring([Math]::Max(0, $npmOutput.Length - 500)))"
    if ($LASTEXITCODE -ne 0) {
        Log "WARNING: npm install exited with code $LASTEXITCODE"
        $warnings += "npm install may have had issues. Check install.log for details."
    } else {
        Log "npm install completed successfully"
    }
} finally {
    Pop-Location
}
$summary += "Server installed with bundled Node.js v22"

# --- 2. Create data directory ---
$DataDir = Join-Path $InstallDir "data"
if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir | Out-Null
    Log "Created data directory: $DataDir"
}

# --- 3. Write data/config.json with Eufy credentials ---
Log "Writing data/config.json with Eufy credentials..."
$dataConfig = @{
    EUFY_CONFIG = @{
        username = $EufyUsername
        password = $EufyPassword
        country = $EufyCountry
        language = $EufyLanguage
        persistentDir = "data/"
        enableEmbeddedPKCS1Support = $true
    }
    TRANSCODING_PRESET = "ultrafast"
    TRANSCODING_CRF = "23"
    VIDEO_SCALE = "1280:-2"
    FFMPEG_THREADS = "4"
    FFMPEG_SHORT_KEYFRAMES = $false
} | ConvertTo-Json -Depth 3

$dataConfigPath = Join-Path $DataDir "config.json"
[System.IO.File]::WriteAllText($dataConfigPath, $dataConfig)
Log "data/config.json written"
$summary += "Eufy credentials configured"

# --- 4. Write root config.json (for tray app) ---
Log "Writing config.json..."
$rootConfig = @{
    port = $Port
    networkMode = $NetworkMode
    version = "0.1.0"
    installedAt = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss")
} | ConvertTo-Json -Depth 2

$rootConfigPath = Join-Path $InstallDir "config.json"
[System.IO.File]::WriteAllText($rootConfigPath, $rootConfig)
Log "config.json written"

# --- 5. Create firewall rule (skip for Cloudflare — outbound only) ---
if ($NetworkMode -ne "cloudflare") {
    Log "Creating firewall rule for port $Port..."
    try {
        & netsh advfirewall firewall delete rule name="EufyView" 2>&1 | Out-Null
        & netsh advfirewall firewall add rule name="EufyView" dir=in action=allow protocol=TCP localport=$Port | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Log "Firewall rule created"
            $summary += "Firewall rule created (port $Port)"
        } else {
            Log "WARNING: Failed to create firewall rule (exit code $LASTEXITCODE)"
            $warnings += "Firewall rule may not have been created. You may need to allow port $Port manually."
        }
    } catch {
        Log "WARNING: Firewall rule creation failed: $_"
        $warnings += "Firewall rule creation failed."
    }
} else {
    Log "Cloudflare mode - skipping firewall rule (outbound connections only)"
}

# --- 6. Tailscale / Cloudflare setup ---
if ($NetworkMode -eq "tailscale") {
    $tailscaleExe = "C:\Program Files\Tailscale\tailscale.exe"
    $tailscaleAlreadyInstalled = Test-Path $tailscaleExe

    if ($tailscaleAlreadyInstalled) {
        Log "Tailscale already installed - skipping MSI installation"
        $summary += "Tailscale (already installed - skipped MSI)"
        $tailscaleMsi = Join-Path $InstallDir "tailscale-setup.msi"
        Remove-Item $tailscaleMsi -Force -ErrorAction SilentlyContinue
    } else {
        $tailscaleMsi = Join-Path $InstallDir "tailscale-setup.msi"
        if (Test-Path $tailscaleMsi) {
            Log "Installing Tailscale..."
            $msiArgs = "/i `"$tailscaleMsi`" /qn /norestart"
            $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList $msiArgs -Wait -PassThru
            if ($proc.ExitCode -eq 0) {
                Log "Tailscale MSI installed successfully"
                $summary += "Tailscale installed"
            } else {
                Log "WARNING: Tailscale MSI exit code: $($proc.ExitCode)"
                $warnings += "Tailscale installation may have failed."
            }
            Remove-Item $tailscaleMsi -Force -ErrorAction SilentlyContinue
        } else {
            Log "WARNING: Tailscale MSI not found at $tailscaleMsi"
            $warnings += "Tailscale MSI was not found."
        }
    }

    # Wait for Tailscale service
    Log "Waiting for Tailscale service..."
    $maxWait = 30
    $waited = 0
    while ($waited -lt $maxWait) {
        $svc = Get-Service -Name "Tailscale" -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq "Running") {
            Log "Tailscale service is running"
            break
        }
        Start-Sleep -Seconds 2
        $waited += 2
    }
    if ($waited -ge $maxWait) {
        Log "WARNING: Tailscale service did not start within ${maxWait}s"
    }

    # Configure tailscale serve
    if (Test-Path $tailscaleExe) {
        Log "Configuring tailscale serve --bg $Port..."
        $serveOutput = & $tailscaleExe serve --bg $Port 2>&1 | Out-String
        Log "tailscale serve output: $serveOutput"
        if ($serveOutput -match "not logged in" -or $serveOutput -match "NeedsLogin") {
            Log "NOTE: Tailscale requires login."
        }
    } else {
        Log "WARNING: tailscale.exe not found at expected path"
    }
} elseif ($NetworkMode -eq "cloudflare") {
    Log "Network mode is 'cloudflare' - checking cloudflared service..."
    # The cloudflared tunnel is shared infrastructure — ClaudeRelay may already have it installed.
    # Only install if the service doesn't already exist.
    $existingSvc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    if ($existingSvc) {
        Log "cloudflared service already exists (likely installed by another app) - skipping install"
        Log "Service status: $($existingSvc.Status)"
        $summary += "Cloudflare Tunnel (already running)"
        $warnings += "A cloudflared tunnel service is already installed on this system. " +
                     "EufyView did not modify it. Make sure your tunnel config includes a hostname pointing to localhost:$Port."
    } else {
        $cloudflaredExe = Join-Path $InstallDir "cloudflared.exe"
        if (Test-Path $cloudflaredExe) {
            Log "Installing cloudflared as Windows service..."
            $output = & $cloudflaredExe service install $CloudflareToken 2>&1 | Out-String
            Log "cloudflared service install output: $output"
            $summary += "Cloudflare Tunnel service installed"
        } else {
            Log "WARNING: cloudflared.exe not found at $cloudflaredExe"
            $warnings += "cloudflared.exe was not found. Cloudflare Tunnel service could not be installed."
        }
    }
} else {
    Log "Network mode is 'direct' - skipping Tailscale/Cloudflare installation"
}

# --- 7. Start server and verify health ---
Log "Starting EufyView..."
$trayExe = Join-Path $InstallDir "EufyViewTray.exe"
Start-Process -FilePath $trayExe
Start-Sleep -Seconds 8

$serverOk = $false
try {
    $health = Invoke-WebRequest -Uri "http://localhost:${Port}/health" -UseBasicParsing -TimeoutSec 10
    Log "Health check passed: $($health.Content)"
    $serverOk = $true
} catch {
    Log "WARNING: Health check failed. Server may still be starting."
    $warnings += "Server health check failed. It may still be starting up."
}

# --- 8. Write install-results.txt for the finish page ---
$localIP = Get-LocalIP
$hostname = $env:COMPUTERNAME

$results = @()
$results += "Installation complete!"
$results += ""
$results += "What was installed:"
foreach ($item in $summary) {
    $results += "  [x] $item"
}
$results += ""

if ($serverOk) {
    $results += "Server status: Running"
} else {
    $results += "Server status: Starting (may take a moment)"
}
$results += ""

# --- Access instructions ---
$results += "=== How to access EufyView ==="
$results += ""
$results += "From this computer:"
$results += "  http://localhost:${Port}"
$results += ""

if ($NetworkMode -eq "tailscale") {
    $results += "From other devices (via Tailscale):"
    $results += "  https://$($hostname.ToLower()).<your-tailnet>.ts.net"
    $results += ""
    $results += "Next steps for Tailscale:"
    $results += "  1. Look for the Tailscale icon in your system tray (bottom-right)"
    $results += "  2. Click it and sign in with your Tailscale account"
    $results += "     (create a free account at https://tailscale.com if you don't have one)"
    $results += "  3. Enable HTTPS certificates in the Tailscale admin console:"
    $results += "     https://login.tailscale.com/admin/dns"
    $results += "     Scroll down to 'HTTPS Certificates' and click Enable"
    $results += "  4. Find your exact URL: open a terminal and run 'tailscale status'"
    $results += "     Your URL will be https://<machine-name>.<tailnet-name>.ts.net"
    $results += "  5. Install Tailscale on your phone/tablet too and sign in"
    $results += "     with the same account"
    $results += "  6. On your phone/tablet, visit that HTTPS URL in a browser"
    $results += "  7. You'll be prompted to install EufyView as a PWA (Add to Home Screen)"
    $results += ""
    $results += "  Note: All devices must be on the same Tailscale network."
    $results += "  HTTPS is required for PWA install on mobile - step 3 is essential."
} elseif ($NetworkMode -eq "cloudflare") {
    $results += "From anywhere (via Cloudflare Tunnel):"
    $results += "  https://<your-configured-hostname>"
    $results += "  (The hostname you configured in the Cloudflare dashboard)"
    $results += ""
    $results += "Recommended: Set up Cloudflare Access"
    $results += "  1. Go to https://one.dash.cloudflare.com"
    $results += "  2. Navigate to Access > Applications > Add an application"
    $results += "  3. Select 'Self-hosted', enter your hostname"
    $results += "  4. Add a policy (e.g., allow your email address)"
    $results += "  This adds authentication so only you can access EufyView."
} else {
    if ($localIP) {
        $results += "From other devices on your local network:"
        $results += "  http://${localIP}:${Port}"
    } else {
        $results += "From other devices on your local network:"
        $results += "  http://<this-pc-ip>:${Port}"
        $results += "  (Run 'ipconfig' to find your local IP address)"
    }
    $results += ""
    $results += "For access outside your local network:"
    $results += "  You will need to set up port forwarding on your router"
    $results += "  Forward external port ${Port} (or your choice) to ${localIP}:${Port}"
    $results += ""
    $results += "Note: Without HTTPS, you cannot install EufyView as a PWA on"
    $results += "Android or iOS. Consider using Tailscale for secure remote access"
    $results += "with automatic HTTPS. You can re-run the installer to switch."
}

if ($warnings.Count -gt 0) {
    $results += ""
    $results += "=== Warnings ==="
    foreach ($w in $warnings) {
        $results += "  ! $w"
    }
}

$results += ""
$results += "Install directory: $InstallDir"
$results += "Log file: $(Join-Path $InstallDir 'install.log')"

$resultsText = $results -join "`r`n"
Set-Content -Path $ResultsFile -Value $resultsText -Encoding UTF8
Log "Install results written to $ResultsFile"
Log "=== Post-install complete ==="
