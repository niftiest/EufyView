# EufyView — Authentication & Remote Access

How the app is exposed to the internet and gated so only allow-listed Google accounts can reach it.
See also [`../AGENTS.md`](../AGENTS.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Why this exists

EufyView is reachable from outside the home network (see **Remote access** below). That public
ingress adds **no authentication of its own** — anyone with the URL could otherwise watch the cameras.
`server/auth.js` is an in-app gate that requires Google sign-in and restricts access to a fixed
allowlist. Because it lives *inside the app*, it protects **every** ingress path (Tailscale, Cloudflare,
localhost) at once.

## How it works (`server/auth.js`)

Dependency-free Google OAuth (no `passport`/`express-session`):

1. Any request without a valid session cookie → middleware redirects browser navigations to
   `/auth/login`, or returns `401` for non-HTML (API/fetch) requests.
2. `/auth/login` → redirect to Google with `scope=openid email` and a signed `state` cookie (CSRF).
3. `/auth/google/callback` → exchanges the code server-side at `oauth2.googleapis.com/token`, decodes
   the `id_token`, verifies `email_verified`, and checks the email against `allowedEmails`.
4. On success it sets an **HMAC-signed session cookie** (`ev_session`, `HttpOnly; Secure; SameSite=Lax`,
   30-day expiry) and redirects to `/`.
5. **WebSocket upgrades** (`/api`) are gated too: `ws-api.js` calls
   `auth.isAuthedCookieHeader(req.headers.cookie)` and destroys unauthenticated sockets.

Exempt paths (no auth): `/auth/login`, `/auth/google/callback`, `/auth/logout`, `/health`.

> Cookie names are app-scoped (`ev_session` / `ev_oauth_state`) so EufyView and the sibling
> ClaudeRelay app — which share the `clbox.tailb9842a.ts.net` host on different ports, and cookies are
> not port-isolated — don't collide. Sessions also use different signing secrets per app.

### Wiring (must be preserved on refactors)
- `rest.js`: `auth.installAuth(app)` is called **after CORS, before any content route**.
- `ws-api.js`: the auth check is the **first thing** in the `upgrade` handler.

If auth wiring is missing or `auth.json` is absent, `installAuth` logs `DISABLED` and the app serves
**without** authentication (intended for local dev) — `isAuthedCookieHeader` returns `true` in that mode.

## `auth.json` (gitignored — never commit)

Lives in the app root (next to `main.js`). Holds secrets, so it is in `.gitignore`. Schema:

```jsonc
{
  "enabled": true,
  "clientId": "<google-oauth-client-id>.apps.googleusercontent.com",
  "clientSecret": "<google-oauth-client-secret>",
  "baseUrl": "https://clbox.tailb9842a.ts.net:8443",   // public origin; used to build the redirect URI
  "allowedEmails": ["you@gmail.com"],                   // ONLY these accounts may sign in
  "sessionSecret": "<random-32-byte-base64>"            // HMAC key for the session cookie
}
```

- `enabled: false` (or a missing file) disables the gate entirely (dev mode).
- Add/remove accounts via `allowedEmails`, then restart the app.
- The Google OAuth client (one client can serve both apps) must list this exact redirect URI:
  `${baseUrl}/auth/google/callback`.
- Generate `sessionSecret` with e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

### Google Cloud setup (one-time)
1. Create an OAuth **Web application** client in Google Cloud Console.
2. Authorized redirect URI: `https://<host>:8443/auth/google/callback` (EufyView).
   ClaudeRelay uses `https://<host>/auth/google/callback` — add both to the same client if shared.
3. OAuth consent screen can stay in **Testing** mode (only `openid`/`email` scopes → no verification);
   add each allow-listed address as a Test user.
4. Put the client ID/secret into `auth.json`.

## Remote access (how the public URL exists)

The home PC publishes the local server to the internet via **Tailscale Funnel** (the app also bundles
`cloudflared`, so a Cloudflare tunnel may be configured too — `config.json: networkMode`). The in-app
auth gate covers whichever path is used.

- EufyView local `127.0.0.1:3001` → public `https://clbox.tailb9842a.ts.net:8443`.
  (Funnel allows ports 443/8443/10000 only; EufyView uses 8443.)
- Enable/disable Funnel (Tailscale CLI):
  ```
  tailscale funnel --bg --https=8443 3001      # on
  tailscale funnel --https=8443 off            # off
  ```
- The hostname resolves the same on and off the tailnet, so installed PWAs need no URL change.

## Quick verification

```
# Unauthenticated browser navigation should redirect to Google sign-in:
GET  /                → 302  /auth/login
GET  /auth/login      → 302  https://accounts.google.com/o/oauth2/v2/auth?...
GET  /config          → 401  (no session, non-HTML)
GET  /health          → 200  (exempt)
```
