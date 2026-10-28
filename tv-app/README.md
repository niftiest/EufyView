# EufyView TV - detection alert app (Fire TV / Android TV)

A small native Android app that shows an on-screen banner when a camera detects
something, so you get alerts on the TV the same way the phone PWA does - with the
same per-camera and per-event-type filtering.

It does **not** use cloud push. It holds one authenticated WebSocket to your
EufyView server's `/api` feed (the server already broadcasts every detection to
connected clients), so a TV - always on, always on the network - gets alerts
reliably with no Firebase/ADM involved.

## First-run onboarding

On launch (and any time it isn't paired yet) the app shows a setup gate that
**auto-scans the local network** for the server - it probes
`http://<host>:3001/health` across its own /24 and recognises EufyView by the
health JSON. It auto-fills the detected IP; if nothing's found you can type the
IP or scan again. You enter a **6-digit pairing code** (from **Settings → Pair a
TV** in the web app); the app redeems it with the server for a long-lived device
token, and only lets you past the gate once that succeeds. No cloud/Cloudflare
involved - this is all LAN-local.

## How it works

- A foreground `AlertService` keeps the WebSocket open (auto-reconnect with
  backoff) and listens for `type:"event"` broadcasts.
- Each event is mapped to a category (person / ring / pet / vehicle / package /
  sound / motion) and checked against the configured camera + type filters.
- A wanted event raises a banner over whatever's on screen (a system overlay;
  falls back to a full-screen activity if the overlay permission isn't granted),
  showing the camera name, what was detected, and the event snapshot once the
  server has it (`GET /history/snap/<id>.jpg`).

Tapping an alert opens **full-screen live view** - ExoPlayer plays the camera's
fMP4 feed (`GET /<serial>.mp4`). The app also has a browsable **camera dashboard**
home, so it's a full viewer, not just alerts.

## Auth: pairing code → device token

Appliances can't hold a browser session cookie, so the server issues a long-lived
**device token** (`server/auth.js` → `makeDeviceToken`). The WebSocket and the
media/snapshot fetches send it as `Authorization: Bearer <token>` (the WS can also
take `?token=`). A token inherits the camera scope of the account that minted it.

Normal pairing: generate a **6-digit code** in **Settings → Pair a TV** (web app)
and enter it during the TV app's onboarding - it redeems the code via
`POST /auth/pair-code/redeem` for its token. For headless/manual setups you can
instead open **`<server>/auth/device-token`** in a signed-in browser to get a raw
`{ "token": "...", "email": "...", "baseUrl": "..." }`.

## Build

Needs JDK 17+ and the Android SDK (platform 34, build-tools). No Android Studio
or system Gradle required - use the committed wrapper.

```
cd tv-app
# create local.properties pointing at your SDK, e.g.:
#   sdk.dir=C:/Android/Sdk      (Windows)   or   sdk.dir=/home/you/Android/Sdk
./gradlew assembleDebug            # gradlew.bat on Windows
```

Output: `app/build/outputs/apk/debug/app-debug.apk`.

### Release build (signed)

Create a keystore once, then a `tv-app/keystore.properties` (both gitignored):

```
keytool -genkeypair -v -keystore eufyview-tv.jks -alias eufyview \
  -keyalg RSA -keysize 2048 -validity 10000
```

`tv-app/keystore.properties`:
```
storeFile=eufyview-tv.jks
storePassword=...
keyAlias=eufyview
keyPassword=...
```

Then `./gradlew assembleRelease` → `app/build/outputs/apk/release/app-release.apk`
(signed when keystore.properties exists; otherwise unsigned).

## Install & pair (Fire TV first)

1. On the Fire TV: **Settings → My Fire TV → Developer options → ADB debugging = ON**
   (and note the IP under **About → Network**).
2. From the PC:
   ```
   adb connect <firestick-ip>:5555
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```
3. Open the app and enter the **6-digit pairing code** from **Settings → Pair a
   TV** in the web app. On the LAN it auto-finds the server; otherwise type the IP.
4. Grant the overlay permission so banners appear over other apps:
   ```
   adb shell appops set com.eufyview.tv SYSTEM_ALERT_WINDOW allow
   ```
   (or use the app's "Grant overlay permission" button). Without it, alerts open
   full-screen instead of as a banner.

The app auto-starts on boot once configured.

## Notes / TODO

- **targetSdk 30** on purpose (Fire TV / Google TV run ~API 28-30) to keep the
  overlay + foreground-service rules at the milder Android-11 level.
- Camera filter choices populate as the app sees detections (it learns each
  camera's serial + name from the event feed); reopen Settings after a few events
  to pick specific cameras.
- Planned: press-to-play the recorded event **clip** from an alert (full-screen
  live view already works).
