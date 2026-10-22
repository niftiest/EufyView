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

### `server/rtsp-stream.js` — RTSP fast path
Some cameras (eufyCam 2C, indoor cams) serve a local RTSP stream straight off the HomeBase on the LAN — already
H.264 + AAC, so FFmpeg can repackage it to fragmented MP4 in copy mode (no transcode). This is faster to start than
P2P (~1.6s vs 4–7s, no ThroughTek setup) and doesn't use the station's single video slot. `startRtspStream` feeds
`GET /rtsp/:sn.mp4` (live view, independent of the P2P pipeline); `rtspSnapshot` grabs thumbnails.

RTSP is **auto-managed** (`acquireRtspSession`/`releaseRtspSession`/`markRtspMiss` in `eufy-client.js`): the route
enables RTSP on the camera when a viewer connects and turns it back off ~30s after the last one leaves
(reference-counted; only disables what it enabled), so the device setting is scoped to actual viewing. The client's
HD-Stream uses `/rtsp/:sn.mp4` per a per-camera preference (default on for capable cams) and **falls back to P2P**
when RTSP yields nothing — a battery camera's RTSP stream only exists while it is awake (404 when asleep), so an
empty stream marks a short cooldown that routes the next watch straight to P2P.

### `server/push.js` — background notifications
Web Push via VAPID. Outbound HTTPS to FCM/Apple/Mozilla push services → works from a home PC behind
NAT, no inbound ports. Subscriptions stored as `endpoint → { subscription, prefs, mutes, types, style, email }` — all **per person**
(never the Eufy device's own notification switches, which would affect every family member):
`prefs[serial]` on/off, `mutes[serial]` expiry, `types[serial][category]` (ring/person/pet/vehicle/package/sound/motion),
`style` = `text` | `full` (text now, then silent update with thumbnail) | `thumb` (wait ≤15s for thumbnail).
Per-`(serial,event)` cooldown (`COOLDOWN_MS = 30000`) prevents a busy camera flooding the OS.

**Detection sources** (all funnel through `notifyDetection()` in `eufy-client.js`, deduped per camera+type):
HomeBase P2P `cmd 2037` payloads (`event_type` 3101–3112 → `EVENT_TYPES`), library device events, and the
cloud-poll `hidden-pictureUrl` fallback ("Activity detected"). **Thumbnails:** after a P2P detection the server asks the
station for its latest event (`databaseQueryLatestInfo`, at 3s and 10s); the library downloads the picture and the
`picture` property change calls `push.attachThumbnail()`.

### `server/snapshot-grabber.js` — thumbnail refresh decoder
Used by `snapshot_all`. While a camera is being refreshed, the `station livestream start` handler routes its raw
H.264/H.265 to a grabber instead of `transcode.js`: a small FFmpeg that decodes up to the first keyframe, writes one
JPEG (capped at 1280 px wide) to a temp file and exits. Only a non-empty file replaces `data/snapshots/<sn>.jpg`
(FFmpeg exits 0 even when it decoded nothing). Independent of the live-view pipeline, so stations run in parallel.
The live-view path still saves its own snapshot when a stream ends; it picks keyframe fragments by their `trun`
sample flags (`fragmentHasKeyframe`).

### `server/history.js` — recordings
Lists recorded events from the Eufy cloud index (`api.getVideoEvents`), caching records server-side so
clients only ever pass a clip id (`<deviceSN>_<startTime>`), never a storage path. Playing a clip calls
`startStationDownload` (P2P; refused while live view runs on the same station, one download at a time),
writes the raw video/audio to `data/clips/*.part.*`, then FFmpeg muxes to MP4 (H.264 copied, H.265
transcoded, `+faststart`). Keeps the newest 40 clips. Thumbnails come through `api.getImage` (decrypts).

### `server/events.js` — EufyView's own event log
Every detection that reaches `notifyDetection()` is appended to `data/events.json` (newest first, 90-day /
5000-event retention) and the camera's next new `picture` within 120 s is saved as
`data/event-snaps/<id>.jpg`. `history.listEvents` merges these with any station/cloud recordings (a detection
within 90 s of a recording on the same camera becomes one entry).

**Why it exists:** the HomeBase S380 (HomeBase 3, `DeviceType.HB3`) doesn't expose its recordings to
eufy-security-client 3.7.2 — station DB queries return a stray record or time out, the cloud event index
returns `code 0` with zero records for every variant tried, and HB3 clip download is unimplemented (its fix
was reverted in 3.7.2; still absent in 4.2.0). So for S380 cameras the Recordings screen shows detections +
snapshots only. Hubs that time out are skipped for 10 minutes (`silentUntil`).

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
| GET | `/history/clip/:id.mp4` | Recorded clip (cached MP4, Range/seek supported; camera-scoped) |
| GET | `/history/thumb/:id.jpg` | Recorded-event thumbnail (camera-scoped) |
| GET | `/history/snap/:id.jpg` | Snapshot saved by EufyView's event log (camera-scoped) |
| GET | `/push/key` | VAPID public key |
| POST | `/push/subscribe` | `{ subscription, prefs, mutes, types, style, oldEndpoint }` (`oldEndpoint`: SW rotation carries settings over) |
| POST | `/push/prefs` | `{ endpoint, prefs, mutes, types, style }` — this person's notification settings |
| GET | `/push/thumb/:token.jpg` | Event thumbnail for a notification (auth-exempt; 128-bit token, 30 min expiry) |
| POST | `/push/unsubscribe` | `{ endpoint }` |
| GET | `/config` | Current config |
| POST | `/config` | Update **whitelisted** keys; hot-restarts transcoder/Eufy as needed |
| GET | `/health` | Status JSON (auth-exempt) |
| GET | `/debug/houses` | Diagnostic dump of Eufy houses/devices |
| GET | `/quit` | Graceful shutdown |
| GET | `/*` | Static PWA from `public/` |

Auth-exempt paths: `/health`, `/auth/login`, `/auth/google/callback`, `/auth/logout`, and `GET /push/thumb/<32-hex>.jpg`. Everything else
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
| `snapshot_all` | Refresh every camera's thumbnail (progress via `snapshot_all_*` events). One lane per station run in parallel — a station streams one camera at a time — so the sweep takes as long as the busiest station. Skips a camera whose station won't connect within 5s, or whose stream the library drops for lack of video; 12s picture cap otherwise. Stops any live view first. One sweep at a time server-wide |
| `device.save_preset` / `device.delete_preset` | PTZ preset slot 0-3: save current view / clear |
| `device.calibrate` | Re-home a pan & tilt camera |
| `device.set_motion_tracking` | Auto-tracking on/off (`motionTracking` property) |
| `device.get_voices` / `device.quick_response` | Doorbell quick replies: list saved voice messages / play one |
| `history.list` | Recorded events (cloud index), one week per page, filtered to the viewer's cameras |
| `device.history_play` | Download a clip; `history_progress` / `history_ready` / `history_error` events go to the requester only |

### Broadcast events (consumed in `public/js/app.js`)
Connection: `eufy connected` / `eufy reconnecting` / `eufy reconnected` / `eufy reconnect failed`.
Detection: `motion/person/pet/vehicle/dog/stranger detected`, `crying/sound detected`, `ring`.
Snapshots: `snapshot_all_start` / `snapshot_all_progress` (`ok`, `reason`, `ms`, `pictureMs` per camera) / `snapshot_all_done` (`failed: [{serialNumber, name, reason}]`). Plus `property changed`.

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
