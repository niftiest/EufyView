# EufyView — Architecture

Deep reference for the server internals. For the high-level tour, start with [`../AGENTS.md`](../AGENTS.md).

## Process startup (`main.js`)

```
main.js
 ├─ utils.loadConfig()            # data/config.json merged over DEFAULT_CONFIG
 ├─ transcode.initTranscode()     # prepare FFmpeg state (no process yet)
 ├─ push.initPush()               # load/generate VAPID keys + subscriptions
 ├─ restServer.initRestServer()   # Express app + WS server start listening on PORT (3001)
 └─ eufy.connect(EUFY_CONFIG)     # background; tolerates missing creds (set later via UI)
```
SIGINT and `uncaughtException` handlers tear down streams and the Eufy client cleanly
(EPIPE/ECONNRESET from dropped stream clients are ignored as benign).

## Module responsibilities

### `server/rest.js` — HTTP surface
Creates the Express `app`, wires middleware in this order: `express.json()` → CORS (`*`) →
**`auth.installAuth(app)`** → routes → `express.static(public/)`. Then `app.listen(PORT)` and
hands the HTTP server to `wsApi.initWebSocketServer()` so WS shares the port.

Owns the streaming endpoints and the single-active-device state machine (`currentDevice`,
grace-period teardown timers, frame-mode watchdog).

### `server/ws-api.js` — realtime control channel
`ws` server with `noServer:true` on path `/api`; manual `upgrade` handling so it can (a) reject
unauthenticated upgrades and (b) ignore non-`/api` paths. Maintains a `messageHandlers` Map
(command → fn) and an optional binary handler. Keepalive pings every 15s (Tailscale/Cloudflare
drop idle sockets). Public API: `registerMessageHandler`, `registerBinaryHandler`, `wsBroadcast`.

### `server/eufy-client.js` — the brain
Wraps `EufySecurity`. Discovers stations/devices, controls livestreams, and **registers every WS
command handler** (see the command table below). Subscribes to Eufy events and:
- broadcasts them to all WS clients as `{ type:'event', event, ... }`, and
- forwards detection events to `push.js` (throttled).
Has auto-reconnect logic. Exports: `connect`, `isConnected`, `startStreamForDevice`,
`stopStreamForDevice`, `startFrameStreamForDevice`, `stopFrameStream`, `close`, `getHousesDebug`.

### `server/transcode.js` — FFmpeg pipelines
Two **mutually exclusive** modes, each its own FFmpeg child process:
- **fMP4 live** (default): camera H.264/H.265 → H.264 fragmented MP4. Captures the **init segment**
  (`ftyp`+`moov`) once, then emits `moof`+`mdat` fragments. New HTTP clients get the init segment
  first, then live fragments. Tuned for low latency (`TRANSCODING_PRESET=ultrafast`, short GOP option).
- **MJPEG frame mode** ("Data Saver"): decodes to discrete JPEG frames at `FRAME_FPS`. The module
  parses JPEG SOI/EOI boundaries out of the MJPEG stream, keeps `latestFrame`, and bumps `frameSeq`
  (used as an ETag). Traffic looks like ordinary image loads — far less bandwidth on metered/restricted
  WiFi. Emits a `'frame'` event used for long-polling.
Exposes getters (`getOutputStream`, `getInitSegment`, `getLatestFrame`, `frameEtag`, `isTranscoding`,
`isFrameMode`, metadata, etc.) consumed by `rest.js`.

### `server/push.js` — background notifications
Web Push via VAPID. Outbound HTTPS to FCM/Apple/Mozilla push services → works from a home PC behind
NAT, no inbound ports. Subscriptions stored as `endpoint → { subscription, prefs:{ [serial]:bool } }`.
Per-`(serial,event)` cooldown (`COOLDOWN_MS = 30000`) prevents a busy camera flooding the OS.

### `server/utils.js` — shared plumbing
`loadConfig`/`saveConfig` (`data/config.json` over `DEFAULT_CONFIG`), severity logging (`LOGGINGLEVEL`),
the active-stream-client `Set`, and snapshot / picture-hash persistence (MD5 change-detection).
`DATA_DIR` defaults to `<app>/data` (override `DATA_DIR`).

## HTTP endpoints (`rest.js`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/:serialNumber.mp4` | fMP4 live stream (one active device at a time) |
| GET | `/frame/:serialNumber.jpg` | Data Saver — single JPEG; supports `If-None-Match` long-poll (≤5s) → 304 |
| GET | `/frame/stop` | Stop the active frame stream immediately |
| GET | `/push/key` | VAPID public key |
| POST | `/push/subscribe` | `{ subscription, prefs }` |
| POST | `/push/prefs` | `{ endpoint, prefs }` — per-camera notification prefs |
| POST | `/push/unsubscribe` | `{ endpoint }` |
| GET | `/config` | Current config |
| POST | `/config` | Update **whitelisted** keys; hot-restarts transcoder/Eufy as needed |
| GET | `/health` | Status JSON (auth-exempt) |
| GET | `/debug/houses` | Diagnostic dump of Eufy houses/devices |
| GET | `/quit` | Graceful shutdown |
| GET | `/*` | Static PWA from `public/` |

Auth-exempt paths: `/health`, `/auth/login`, `/auth/google/callback`, `/auth/logout`. Everything else
requires a valid session (see [`AUTH.md`](AUTH.md)).

## WebSocket protocol (`/api`)

**Client → server:** JSON `{ command, ...args }`. Binary frames are **talkback audio** (mic → camera).
**Server → client:** a `{ type:'version', serverVersion, clientVersion }` greeting on connect, then
`{ type:'result', ... }` replies and `{ type:'event', event, ... }` broadcasts. Errors come back as
`{ type:'error'|'result', error, message }`.

### Registered commands (`eufy-client.js`)
| Command | Action |
|---|---|
| `start_listening` | Snapshot of current stations/devices/state to the client |
| `station.get_properties` / `device.get_properties` | Read properties |
| `device.get_commands` | List supported commands for a device |
| `station.download_image` | Pull a stored image off the station |
| `station.database_query_latest_info` | Latest DB info |
| `device.preset_position` / `device.pan_and_tilt` | PTZ control |
| `device.set_auto_nightvision` / `device.set_nightvision` | Night vision |
| `device.switch_light` | Toggle camera light |
| `device.trigger_alarm` | Trigger station/camera alarm |
| `device.start_talkback` / `device.stop_talkback` | Two-way audio session (then send binary mic frames) |
| `snapshot_all` | Snapshot every camera (progress via `snapshot_all_*` events) |

### Broadcast events (consumed in `public/js/app.js`)
Connection: `eufy connected` / `eufy reconnecting` / `eufy reconnected` / `eufy reconnect failed`.
Detection: `motion/person/pet/vehicle/dog/stranger detected`, `crying/sound detected`, `ring`.
Snapshots: `snapshot_all_start` / `snapshot_all_progress` / `snapshot_all_done`. Plus `property changed`.

## Configuration (`data/config.json`)

Merged over `DEFAULT_CONFIG` (`utils.js`). Key groups:
- `EUFY_CONFIG`: `username`, `password`, `country` (`US`), `language` (`en`), `persistentDir`,
  `enableEmbeddedPKCS1Support: true` (**required on Node 22+**).
- Transcoding: `TRANSCODING_PRESET` (`ultrafast`), `TRANSCODING_CRF` (`23`), `VIDEO_SCALE` (`1280:-2`),
  `FFMPEG_THREADS` (`4`), `FFMPEG_SHORT_KEYFRAMES`.
- Data Saver: `FRAME_FPS` (`2`), `FRAME_SCALE` (`640:-2`), `FRAME_QUALITY` (`7`; 2=best … 31=worst).

`POST /config` only honors these keys and persists via `utils.saveConfig`. Most env vars can override
defaults at boot (`PORT`, `FFMPEG_PATH`, `DATA_DIR`, `LOGGINGLEVEL`, `FFMPEG_MINLOGLEVEL`, etc.).

## Front-end (`public/`)

`index.html` + `js/app.js` (UI, WS client, fMP4/`<video>` + frame polling, talkback capture, push
subscription UI) + `css/styles.css`. `sw.js` is the service worker: caches the app shell but **never**
caches `/api`, WS upgrades, video streams, frame polls, or push endpoints. `manifest` makes it an
installable PWA with relative `start_url` — so an installed home-screen app uses whatever origin it
was added from and works on/off Tailscale unchanged.
