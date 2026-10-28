# EufyView - Authentication & Remote Access

How the app is exposed to the internet and gated so only people you've given an account can reach it.
See also [`../AGENTS.md`](../AGENTS.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Why this exists

EufyView is reachable from outside the home network (see **Remote access** below). That public
ingress adds **no authentication of its own** - anyone with the URL could otherwise watch the cameras.
`server/auth.js` is a built-in, dependency-free gate that requires a password sign-in. Because it lives
*inside the app*, it protects **every** ingress path (Tailscale, Cloudflare, localhost) at once. There is
no external identity provider - no Google/OAuth, no `passport`, no `express-session`.

## How it works (`server/auth.js`)

One **administrator** account plus any number of **scoped users**. The admin manages everyone and sets
each user's camera access; users never change their own scope.

1. Any request without a valid session → the gate middleware redirects browser navigations to
   `/auth/login`, or returns `401 {"error":"unauthorized"}` for non-HTML (API/fetch) requests.
2. `/auth/login` serves the **sign-in page** - or, until an administrator exists, the **Initial Setup**
   page (it switches automatically the moment the admin is created).
3. `POST /auth/login` checks `email` + `password` against the stored salted-scrypt hash. On success it
   sets an **HMAC-signed session cookie** (`ev_session`, `HttpOnly; Secure; SameSite=Lax`, 30-day expiry).
4. New users set their first password by redeeming a one-time **claim code** the admin generates
   (`POST /auth/claim`); the code itself is stored only as a scrypt hash with an expiry.
5. **WebSocket upgrades** (`/api`) are gated too: `ws-api.js` verifies the session cookie (or a bearer
   device token) on upgrade and destroys unauthenticated sockets.
6. **Headless appliances** (the TV app) can't hold a cookie, so they authenticate with a long-lived
   **bearer device token** sent as `Authorization: Bearer <token>` (or `?token=` on the WS). A token
   inherits the camera scope of the account that minted it. See **Device tokens** below.

**Brute-force protection:** per-account (5) and per-IP (20) failed attempts trigger an in-memory lockout
with exponential backoff (1 min, doubling); failed sign-ins also incur a fixed delay.

**Fail-closed:** if `auth.json` exists but is corrupt/unreadable, the gate refuses **every** request
(`503`) rather than booting open. If `auth.json` is absent or `enabled:false`, the gate is **DISABLED**
and the app serves without authentication (intended for local dev only).

### Wiring (must be preserved on refactors)
- `rest.js`: `auth.installAuth(app)` is called **after `express.json()` + CORS, before any content route**.
- `ws-api.js`: the auth check is the **first thing** in the `upgrade` handler.

## `auth.json` (gitignored - never commit)

Lives in **`data/`** with the rest of the persistent state, so it survives reinstalls/upgrades and moves
with the app as one unit. (Older installs kept it at the app root; `auth.js` migrates it into `data/` once.)
Override the path with `AUTH_CONFIG_PATH`. Schema:

```jsonc
{
  "enabled": true,
  "sessionSecret": "<random hex>",              // HMAC key for session cookies + device tokens
  "baseUrl": "https://…",                        // remote URL, for display only (optional)
  "admin": {
    "email": "you@example.com",
    "passwordHash": "<salt:hash>",               // salted scrypt - never plaintext
    "lastLogin": 0, "lastIp": ""
  },
  "users": [
    {
      "email": "guest@example.com",
      "cameras": "all",                          // "all" or ["<serial1>","<serial2>"]
      "passwordHash": "<salt:hash>" | null,       // null until the user claims their account
      "claim": { "hash": "<salt:hash>", "expires": 0 } | null,
      "lastLogin": 0, "lastIp": ""
    }
  ]
}
```

- `enabled:false` (or a missing file) disables the gate entirely (dev mode).
- Passwords **and** claim codes are stored only as salted scrypt hashes.

### Setting up the administrator

The admin is created without ever putting a password in the installer:

- **First run:** with no admin configured, `/auth/login` serves the **Initial Setup** page.
  `POST /setup/set-password` (loopback- or admin-only) creates the admin.
- **From the server machine / tray / installer:** `node main.js --set-admin <email> <password>`
  (or `EUFYVIEW_ADMIN_PASSWORD=… node main.js --set-admin <email>`) seeds or resets the admin. Use this
  to recover if you're locked out.

### Multi-user camera scoping

- **Admin:** sees and controls **every** camera and can manage users.
- **Scoped user:** sees and controls **only** the cameras in their `cameras` list (serials, or `"all"`).

Scoping is **enforced server-side**, not just in the UI:
- `ws-api.js` resolves a per-connection scope on WebSocket upgrade. `start_listening` returns only the
  user's devices/stations/houses; `device.*` commands and device-specific broadcasts (snapshots,
  detection events) are filtered by scope.
- `rest.js` blocks out-of-scope cameras (`403`) on `GET /:sn.mp4`, `/frame/:sn.jpg`, `/snapshot/:sn.jpg`,
  and the `/history/*` clip/thumb/snap routes.

**Managing users:** an admin uses **Settings → Manage Users** in the app (backed by `GET /auth/me`,
`GET /admin/cameras`, `GET/POST/PUT/DELETE /admin/users`, `POST /admin/account`). Adding a user issues a
one-time **claim code**; the user redeems it to set their password. Changes take effect immediately -
`auth.json` is re-read per request, **no restart needed**. Everything under `/admin/*` requires an admin
session.

### Device tokens (TV / appliances)

- `GET /auth/device-token` - returns `{ token, email, baseUrl }`; requires a **browser session** (a device
  token can't mint more tokens).
- **Pairing codes** are the friendlier path: **Settings → Pair a TV** (or the tray on the server machine)
  issues a short code via `POST /auth/pair-code/new` / `GET /auth/pair-code/local`; the TV redeems it with
  `POST /auth/pair-code/redeem` to receive its device token. Device tokens are long-lived (10 years).

### Exempt paths (no auth)

`/auth/login`, `/auth/claim`, `/auth/logout`, `/health`, `/status`, `/auth/pair-code/redeem`,
`/auth/pair-code/local`, `/setup/set-password`, the `/devices/*` LAN-install endpoints, and
`GET /push/thumb/<32-hex>.jpg` (a 128-bit single-use token, 30-min expiry). Everything else requires a
valid session cookie or bearer device token.

## Remote access (how the public URL exists)

The server publishes `127.0.0.1:3001` to the internet via **Tailscale** (Serve/Funnel) or a **Cloudflare
Tunnel** - chosen at install time (`config.json: networkMode`; the installer can set either up). The in-app
auth gate covers whichever path is used, and client URLs are origin-relative so an installed PWA works on
and off the tailnet unchanged. No inbound ports are opened to the public internet in either mode. You can
also skip remote access entirely and use it on your LAN only.

## Quick verification

```
# Unauthenticated browser navigation redirects to sign-in:
GET  /                → 302  /auth/login
GET  /config          → 401  {"error":"unauthorized"}   (no session, non-HTML)
GET  /health          → 200  (exempt)
```
