# EufyView

**Watch your Eufy cameras and get detection alerts - on your phone, your browser, and your TV - from a server you run yourself.** No Eufy app required for viewing, and no cloud subscription in the path.

EufyView is a small server that talks to your HomeBases over Eufy's own P2P protocol and turns them into a clean, fast web app. Install it on a Windows box or a Linux/NAS host, open it on your phone, and you've got live view, recordings, and real-time notifications - reachable from anywhere over Tailscale or Cloudflare Tunnel, or locked to your LAN if you prefer.

<!-- A screenshot or short GIF here goes a long way before a release. -->

## What you get

- 📺 **Live view** - fast fMP4 streaming with fullscreen, pinch-zoom, picture-in-picture, and a wake-lock so the screen stays on. Night vision, spotlight, siren, two-way talk, and PTZ (with presets) where the camera supports them.
- 🖼️ **A camera grid** grouped by house, with cached thumbnails that load instantly and refresh after each view - shared across everyone in the household.
- ⏯️ **Recordings** browsed by day, including playback of HomeBase-local clips that the Eufy app normally keeps encrypted (HomeBase 2 and Chime-paired doorbells - see [Credits](#credits--references)).
- 🔔 **Detection alerts** - a live timeline (person / pet / vehicle / package / sound / ring / motion) plus background **Web Push** notifications with thumbnails; tap one to jump straight to that clip.
- 🛜 **A Fire TV / Android TV app** that pops an on-screen alert when a camera sees something and lets you open the feed full-screen or as a picture-in-picture peek over whatever you're watching.
- 🔒 **Your own login** - one admin plus per-user accounts you scope to specific cameras or houses. Nothing is exposed to the public internet unless you choose to.
- 🔄 **In-app updates** - the installed PWA updates itself on each release, and the Windows server can update in place from **Settings → About & Updates**.

There's also a **Data Saver** mode that serves discrete still frames instead of a video stream, so it keeps working on heavily throttled or restricted WiFi - e.g. **cruise-ship internet without the streaming package**, or hotel/airline WiFi - where normal video streaming is blocked or unaffordable. Plus an optional local RTSP fast-path for cameras that support it.

## How it works

```
Phone PWA · browser · TV app
            │   (HTTPS via Tailscale or Cloudflare Tunnel, or plain LAN)
            ▼
     EufyView server  ──►  eufy-security-client (P2P)  ──►  your HomeBases
            │
          FFmpeg  ──►  live stream + snapshots + recordings
```

The server hosts the web app (an installable PWA), speaks a WebSocket API to each client, and pulls video straight from your HomeBases over P2P - FFmpeg handles the transcoding. The phone "app" is just that PWA wrapped for a home-screen icon; the TV app is a native Kotlin app with its own background alert service.

## Get started

### Windows (installer)

Grab the installer from the [latest release](https://github.com/niftiest/EufyView/releases). It bundles Node + FFmpeg, can set up Tailscale or Cloudflare Tunnel, opens the firewall, optionally launches at startup, and creates your admin login. You sign in to Eufy **inside the app** afterward - its first-run wizard handles captcha and 2-step verification, so the installer never touches your Eufy credentials.

### Linux / NAS (Docker)

The image bundles Node 20 + FFmpeg, so there's nothing else to install:

```bash
git clone https://github.com/niftiest/EufyView.git
cd EufyView
docker compose up -d
```

Open `http://<host>:3001` and finish the first-run wizard (admin login, then Eufy sign-in). Everything under `./data` persists across upgrades - back up that one folder. Upgrade with `docker compose pull && docker compose up -d`.

A few knobs: edit `docker-compose.yml` to change the port or set your `TZ`. The container runs as uid **1000** - if a bind-mounted `./data` is owned by someone else, `chown -R 1000:1000 data`. If cameras won't connect, Eufy's P2P sometimes needs host networking - flip the service to `network_mode: host` (noted in the compose file). There's no tray on Linux; `docker compose restart` and the `/health` endpoint cover it.

### Manual (any OS)

Install **Node.js 20+** and **FFmpeg**, then:

```bash
git clone https://github.com/niftiest/EufyView.git
cd EufyView
npm install        # applies the eufy-security-client patches via patch-package
node main.js       # then sign in through the app's setup wizard
```

Run it under a service manager (`systemd`, pm2, …) so it restarts on boot and crashes. For headless setups you can pre-seed `data/config.json` instead of using the wizard:

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

> **⚠️ Which Eufy account should the server use?** Eufy allows roughly **one active session per account**. If you're **replacing** the Eufy app, use your main account - the server becomes the only session and everything works. If you want to **keep using the Eufy app too**, create a **separate Eufy account**, add it to your home as a **member**, and give the server *that* login. Sharing one account between the app and the server makes them fight, and background notifications get unreliable (live view still works either way).

## Accounts & remote access

EufyView has its own login: one **admin** (created at setup) plus **users** you add under **Settings → Manage Users**, each scoped to the cameras or houses they should see. New users get a one-time claim code to set their password; passwords are stored only as salted scrypt hashes. Locked out? Run `node main.js --set-admin <email> <password>` on the server.

To reach it from your phone, install **Tailscale** or set up a **Cloudflare Tunnel** and open the resulting HTTPS address, then Add to Home Screen. Either way no ports are opened to the public internet. For the **TV app**, open **Settings → Pair a TV** for a 6-digit code and enter it on the TV - on the LAN it finds the server automatically. (TV app build/sideload details are in [`tv-app/README.md`](tv-app/README.md).)

## Tech stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 20+, Express, `ws` |
| Cameras | `eufy-security-client` (P2P) + local patches for recording decryption |
| Transcoding | FFmpeg (H.264 / H.265 → fMP4 / MJPEG) |
| Web app | Vanilla JS PWA - Media Source Extensions, service worker, Web Push |
| TV app | Kotlin, OkHttp, media3 (ExoPlayer) |
| Remote access | Tailscale Serve, Cloudflare Tunnel, or direct LAN |
| Packaging | Windows installer (Inno Setup + tray) · Docker image · manual |

> Working on the code? [`AGENTS.md`](AGENTS.md) is the developer map - repo layout, the WebSocket command set, the streaming pipeline, and the gotchas.

## Troubleshooting

- **No cameras / blank page** - open `/health`; if `eufyConnected:false`, finish Eufy sign-in in the setup wizard (or check `data/config.json`).
- **Stream won't play** - only one camera streams per HomeBase at a time; `/health` shows the active FFmpeg metadata while a stream is live.
- **Logs** - on Windows, `%LOCALAPPDATA%\EufyView\data\logs\eufyview.log` (rotating), also surfaced in the tray's **Status** window; in Docker, `docker compose logs -f`.

## Credits & References

EufyView builds on [`eufy-security-client`](https://github.com/bropat/eufy-security-client) by bropat for P2P livestreaming and device control. That package is **unofficial** (not by Eufy/Anker) and now deprecated; active development has moved to [mega-yfue/eufy-sdk](https://github.com/mega-yfue/eufy-sdk).

Playback of HomeBase-local recordings draws on published reverse-engineering work:

- **HomeBase 2 clips** - the per-keyframe ECIES → AES-256-GCM scheme, from mega-yfue/eufy-sdk [PR #260](https://github.com/mega-yfue/eufy-sdk/pull/260).
- **Chime-paired doorbell clips** - the device-derived media-key scheme (`getImageKey` / `create_pic_code_v1`), documented in the USENIX WOOT '24 paper ["Reverse Engineering the Eufy Ecosystem"](https://www.usenix.org/conference/woot24/presentation/goeman) by Goeman, Lapon & Naessens (DistriNet-KU Leuven) and implemented in `eufy-security-client`.

These reflect documented weaknesses in Eufy's media encryption; EufyView only ever decrypts the signed-in account's own recordings.
