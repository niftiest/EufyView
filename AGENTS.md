# EufyView — Agent Onboarding

> Read this first. It's the fast path to being productive in this repo.
> Deeper detail lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/AUTH.md`](docs/AUTH.md).

## What this is

EufyView (`eufy-view` v0.2.0) is a **mobile-first web viewer for Eufy Security cameras**.
It connects to the Eufy cloud/P2P network using [`eufy-security-client`](https://github.com/bropat/eufy-security-client),
pulls a live H.264/H.265 stream straight off the camera, transcodes it with **FFmpeg**, and
serves it to a browser PWA as either a low-latency **fMP4 stream** or, for metered connections,
a bandwidth-sipping **MJPEG "frame" stream**. It also does PTZ control, snapshots, two-way
talkback audio, and background push notifications for detection events.

- **Runtime:** Node.js (`>=20`; production runs bundled Node 22). Plain CommonJS JS — **no build step**.
- **Stack:** Express (HTTP) + `ws` (WebSocket) + FFmpeg (child process) + `web-push`.
- **Entry point:** [`main.js`](main.js) → starts transcoder, push, REST/WS server, then connects to Eufy.
- **Default port:** `3001` (override with `PORT`).
- **License:** MIT.

## Quickstart

```bash
npm install
# FFmpeg must be on PATH, or set FFMPEG_PATH to a binary.
node main.js                       # serves http://localhost:3001
```

First run has no Eufy credentials — open the UI and enter them (Settings), or seed
`data/config.json`. Credentials and all runtime state live under `data/` (gitignored).

> **Production note:** the installed build runs from `%LOCALAPPDATA%\EufyView` and is
> launched/kept alive by `EufyViewTray.exe` (a system-tray app). To apply code changes
> there, edit the install copy and **restart the tray app**. This repo is the dev source.

## Repo map

```
main.js                 Process entry: boots services, connects Eufy, signal/exception handling
server/
  rest.js               Express app: HTTP routes, static files, mounts auth gate + WS server
  ws-api.js             WebSocket server on /api: JSON command dispatch + binary (talkback) + broadcast
  eufy-client.js        Eufy connection, device/station discovery, stream control, event→WS/push,
                        and ALL WebSocket command handlers (PTZ, nightvision, talkback, snapshot_all…)
  transcode.js          FFmpeg pipelines: fMP4 live stream AND MJPEG frame mode (mutually exclusive)
  push.js               Web Push (VAPID) — background detection alerts to subscribed PWAs
  utils.js              Config load/save, logging, active-stream-client set, snapshot/hash persistence
  auth.js               Google OAuth gate (allowlist) for HTTP routes + WS upgrades — see docs/AUTH.md
public/                 PWA front-end: index.html, js/app.js, css/, sw.js (service worker), manifest, icons
data/                   Runtime state (gitignored): config.json, snapshots/, vapid.json, subscriptions, eufy persistent
```

## Mental model (request → pixels)

1. Browser loads the PWA from `public/` and opens a WebSocket to `/api`.
2. UI sends JSON commands over WS (e.g. `device.pan_and_tilt`); `ws-api.js` dispatches to
   handlers registered by `eufy-client.js`.
3. To watch a camera, the browser hits **`GET /:serialNumber.mp4`** (fMP4) or polls
   **`GET /frame/:serialNumber.jpg`** (Data Saver). `rest.js` asks `eufy-client.js` to start the
   P2P livestream and `transcode.js` to spin up FFmpeg; transcoded output is streamed back.
4. Camera/detection events flow Eufy → `eufy-client.js` → broadcast over WS (`type:'event'`)
   **and** → `push.js` (background notification if the app is closed).

Only **one camera streams at a time** (P2P/transcode resource limit); switching tears down the
previous stream first. fMP4 and frame mode are **mutually exclusive**.

## Conventions & gotchas

- **All client URLs are origin-relative** (WS is `location.origin` → `ws(s)` + `/api`; fetches are
  `/...`). Never hardcode a host/IP — it must work behind Tailscale, Cloudflare, or localhost unchanged.
- **Auth gate ordering matters.** In `rest.js`, `auth.installAuth(app)` runs right after the CORS
  middleware and **before** any content route. In `ws-api.js`, the upgrade handler rejects
  unauthenticated sockets before `handleUpgrade`. If you refactor route setup, preserve this. (This
  wiring has been silently reverted by an editor before — double-check it survives your edits.)
- **`auth.json` holds secrets** (Google client secret + session secret). It is **gitignored** — never
  commit it. See [`docs/AUTH.md`](docs/AUTH.md).
- **Node 22:** `EUFY_CONFIG.enableEmbeddedPKCS1Support: true` is required (pure-JS RSA fallback).
- **FFmpeg is mandatory.** Production bundles it under `ffmpeg/`; otherwise set `FFMPEG_PATH`.
- Config changes via `POST /config` only accept a **whitelist** of keys and hot-restart the affected
  subsystem (transcoder or Eufy client) — see `rest.js`.
- Logging is severity-gated by `LOGGINGLEVEL` (0=error … 3=debug) via `utils.log`.

## Where to go next

- HTTP endpoints, the full WebSocket command set, and the streaming pipeline internals →
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Auth, the `auth.json` schema, the OAuth flow, and remote access (Tailscale Funnel / Cloudflare) →
  [`docs/AUTH.md`](docs/AUTH.md)
