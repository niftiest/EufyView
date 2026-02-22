# EufyView

A mobile-first PWA for viewing Eufy Security cameras via P2P livestreaming. Runs as a native Windows tray app with Tailscale or Cloudflare Tunnel for secure HTTPS remote access.

## Architecture

```
Phone browser
  -> https://<machine>.tailnet.ts.net    (Tailscale Serve - auto HTTPS)
  -> https://<hostname>.yourdomain.com   (Cloudflare Tunnel - auto HTTPS)
    -> localhost:<port>                  (EufyView server, default 3001)
        +-- /api          -> WebSocket API (device discovery, events, commands)
        +-- /<serial>.mp4 -> fMP4 live stream
```

With Tailscale or Cloudflare Tunnel, no ports are exposed to the public internet. Direct mode opens the configured port on the local network only.

## Features

- **Live video** - fMP4 streaming via MSE with adaptive buffer management
- **Camera grid** - Auto-discovered cameras grouped by house/location
- **Camera health** - Battery, WiFi signal, and online status dashboard
- **Event timeline** - Motion, person, pet, vehicle, and sound detection events
- **Night vision toggle** - Control night vision from the live view
- **Spotlight toggle** - Turn camera spotlights on/off
- **Siren control** - Trigger alarm sounds remotely
- **Push-to-talk** - Two-way audio via WebSocket + microphone
- **PTZ controls** - Swipe gestures for pan/tilt cameras, preset position pills
- **Pinch-to-zoom** - Zoom and pan on live video with double-tap reset
- **Picture-in-Picture** - Continue watching while using other apps
- **Fullscreen mode** - Immersive live viewing
- **Screen wake lock** - Prevents screen dimming during live view
- **Browser notifications** - Per-camera notification toggles for detection events
- **Settings overlay** - Video quality (scale, CRF) configuration
- **Captcha support** - Handles Eufy login captcha challenges
- **PWA install** - Add to home screen on Android/iOS (requires HTTPS)
- **System tray** - Runs as a Windows tray app with start/stop/restart controls

## Installation

Download and run the installer from the [latest release](https://github.com/niftiest/EufyView/releases). The installer:

1. Bundles Node.js v22 and FFmpeg (no separate installs needed)
2. Asks for Eufy account credentials (stored locally in `data/config.json`)
3. Asks for a server port (default 3001)
4. Installs dependencies
5. Opens Windows Firewall on the configured port
6. Optionally installs Tailscale or Cloudflare Tunnel for secure remote access
7. Optionally sets EufyView to launch on Windows startup (registry Run key)
8. Starts the server and verifies it's healthy

### Access from phone

**With Tailscale:**
1. Install Tailscale on your phone and sign in with the same account
2. Navigate to `https://<your-machine>.<tailnet>.ts.net`
3. Tap "Add to Home Screen" to install the PWA

**With Cloudflare Tunnel:**
1. Navigate to `https://<your-configured-hostname>` from any device
2. Authenticate via Cloudflare Access (if configured)
3. Tap "Add to Home Screen" to install the PWA

### Manual setup (without installer)

1. Install Node.js 22+ and FFmpeg
2. Clone this repo and run `npm install`
3. Create `data/config.json` with your Eufy credentials (see below)
4. Run `node main.js` (or use `start.cmd`)

```json
{
  "EUFY_CONFIG": {
    "username": "your-email@example.com",
    "password": "your-password",
    "country": "US",
    "language": "en",
    "persistentDir": "data/",
    "enableEmbeddedPKCS1Support": true
  }
}
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js v22 (bundled) on Windows |
| Backend | Express, ws |
| Camera | `eufy-security-client` (P2P livestreaming) |
| Transcoding | FFmpeg (H.264/H.265 -> fMP4) |
| Frontend | Vanilla JS, MSE for video playback |
| Networking | Tailscale Serve, Cloudflare Tunnel, or direct LAN access |
| Style | Custom dark theme, mobile-first CSS |

## File Structure

```
EufyView/
+-- main.js                  # Entry point — starts server, connects Eufy
+-- package.json
+-- server/
|   +-- rest.js              # Express HTTP server + fMP4 streaming endpoint
|   +-- eufy-client.js       # eufy-security-client wrapper (P2P connection)
|   +-- transcode.js         # FFmpeg transcoding (raw H.264/265 -> fMP4)
|   +-- ws-api.js            # WebSocket API (device commands, events)
|   +-- utils.js             # Config management, logging, stream tracking
+-- public/
|   +-- index.html           # App shell
|   +-- manifest.json        # PWA manifest
|   +-- sw.js                # Service worker
|   +-- css/styles.css       # Mobile-first dark theme
|   +-- js/app.js            # Client — WS, camera grid, live view, gestures
+-- installer/
    +-- build-installer.ps1  # Downloads deps, compiles tray app + installer
    +-- EufyView-Setup.iss   # Inno Setup script
    +-- EufyViewTray.cs      # C# system tray app
    +-- post-install.ps1     # npm install, config, networking, health check
    +-- generate-icon.ps1    # Generates tray icon
```

## Tray App

EufyView runs as a Windows system tray application. Right-click the tray icon for:
- **Open in Browser** (opens configured port)
- **Restart Server**
- **Exit** (stops the server and closes the tray app)

Optionally starts with Windows via a registry Run key (configurable during installation).

## Troubleshooting

### Blank page / no cameras
- Check the server: visit `http://localhost:<port>/health` (default port 3001)
- Verify `eufyConnected: true` in the health response
- If `eufyConnected: false`, check your credentials in `data/config.json`
- Make sure EufyViewTray.exe is running (check system tray)

### Stream won't play
- Check that FFmpeg is available: the health endpoint shows video/audio metadata when streaming
- Only one camera can stream at a time — switching cameras stops the previous stream

### Server logs
Check `error.log` and `install.log` in the install directory (`%LOCALAPPDATA%\EufyView\`).
