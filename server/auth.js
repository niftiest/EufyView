/**
 * auth.js — Google OAuth gate for EufyView (dependency-free).
 *
 * Reads config from ../auth.json (app root). Protects all HTTP routes and
 * exposes a helper to gate WebSocket upgrades. Uses HMAC-signed cookies for
 * sessions — no express-session / passport needed.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'auth.json');

const COOKIE = 'ev_session';
const STATE_COOKIE = 'ev_oauth_state';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let _cfg;
let _loaded = false;
function loadConfig() {
    if (_loaded) return _cfg;
    _loaded = true;
    try {
        _cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        _cfg = null;
    }
    return _cfg;
}

// Persist config back to auth.json and refresh the in-memory cache. Used by the
// admin user-management endpoints. Pretty-printed so the file stays editable.
function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    _cfg = cfg;
    _loaded = true;
    return cfg;
}

const lc = (s) => String(s || '').trim().toLowerCase();

const sign = (value, secret) =>
    crypto.createHmac('sha256', secret).update(value).digest('base64url');

function makeToken(email, secret) {
    const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + MAX_AGE_MS })).toString('base64url');
    return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token, secret) {
    if (!token || token.indexOf('.') === -1) return null;
    const [payload, sig] = token.split('.');
    const expected = sign(payload, secret);
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!data.exp || data.exp < Date.now()) return null;
        return data;
    } catch (e) {
        return null;
    }
}

// Stateless OAuth `state`: a signed "nonce.timestamp.sig" the callback can
// verify WITHOUT a cookie. Avoids the CSRF state-cookie getting clobbered when
// several parallel unauthenticated requests (page + manifest + icons + SW) each
// hit /auth/login on a fresh load and overwrite each other's state cookie —
// which caused "Invalid OAuth state" on the first sign-in attempt.
function makeState(secret) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const ts = Date.now().toString();
    const body = nonce + '.' + ts;
    return body + '.' + sign(body, secret);
}

function verifyState(state, secret, maxAgeMs) {
    if (!state) return false;
    const parts = String(state).split('.');
    if (parts.length !== 3) return false;
    const [nonce, ts, sig] = parts;
    const expected = sign(nonce + '.' + ts, secret);
    if (sig.length !== expected.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const t = parseInt(ts, 10);
    if (!t || Date.now() - t > (maxAgeMs || 10 * 60 * 1000)) return false;
    return true;
}

function parseCookies(header) {
    const out = {};
    (header || '').split(';').forEach((p) => {
        const i = p.indexOf('=');
        if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
}

function cookieStr(name, value, maxAgeSec) {
    // SameSite=None (with Secure) so the session cookie is sent when the
    // installed PWA/TWA relaunches — its launch navigation is treated as
    // cross-site by Chrome, which drops SameSite=Lax cookies and forced a
    // re-login on every open. Cross-site state-changing requests are still
    // blocked by CORS, and OAuth state is stateless, so CSRF risk is minimal.
    let s = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=None`;
    if (maxAgeSec != null) s += `; Max-Age=${Math.floor(maxAgeSec)}`;
    return s;
}

function decodeJwt(jwt) {
    try {
        return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    } catch (e) {
        return null;
    }
}

// True if the request carries a valid session cookie. When auth is disabled
// (no config), returns true so the app stays open for local/dev use.
function isAuthedCookieHeader(cookieHeader) {
    const cfg = loadConfig();
    if (!cfg || !cfg.enabled) return true;
    if (!cfg.sessionSecret) return false;
    return !!verifyToken(parseCookies(cookieHeader)[COOKIE], cfg.sessionSecret);
}

const EXEMPT = new Set(['/auth/login', '/auth/google/callback', '/auth/logout', '/health']);

// Mounts /auth/* routes and a gate middleware. Call AFTER express.json() and
// BEFORE any other routes so unauthenticated requests are intercepted.
function installAuth(app) {
    const cfg = loadConfig();
    if (!cfg || !cfg.enabled) {
        console.log('[auth] DISABLED (no auth.json or enabled:false) — running WITHOUT authentication');
        return { enabled: false };
    }
    const redirectUri = cfg.baseUrl + '/auth/google/callback';

    app.get('/auth/login', (_req, res) => {
        // Self-validating state (no cookie) — see makeState/verifyState.
        const state = makeState(cfg.sessionSecret);
        const params = new URLSearchParams({
            client_id: cfg.clientId || '',
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: 'openid email',
            state,
            access_type: 'online',
            // No prompt=select_account: with an active Google session this lets
            // Google silently re-auth (a quick redirect) instead of forcing the
            // account chooser on every relaunch.
        });
        res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
    });

    app.get('/auth/google/callback', async (req, res) => {
        try {
            const code = req.query.code;
            const state = req.query.state;
            if (!code || !verifyState(state, cfg.sessionSecret)) {
                return res.status(400).send("Invalid OAuth state. <a href='/auth/login'>Try again</a>");
            }
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    code: String(code),
                    client_id: cfg.clientId || '',
                    client_secret: cfg.clientSecret || '',
                    redirect_uri: redirectUri,
                    grant_type: 'authorization_code',
                }),
            });
            if (!tokenRes.ok) return res.status(502).send('Google token exchange failed');
            const tok = await tokenRes.json();
            const claims = decodeJwt(tok.id_token);
            if (!claims || !claims.email || claims.email_verified !== true) {
                return res.status(403).send('Could not verify your Google email.');
            }
            if (!isEmailAllowed(claims.email)) {
                return res.status(403).send(`Access denied for ${claims.email}. <a href='/auth/logout'>Sign out</a>`);
            }
            res.setHeader('Set-Cookie', [
                cookieStr(COOKIE, makeToken(claims.email, cfg.sessionSecret), MAX_AGE_MS / 1000),
                cookieStr(STATE_COOKIE, '', 0),
            ]);
            res.redirect('/');
        } catch (e) {
            res.status(500).send('Authentication error.');
        }
    });

    app.get('/auth/logout', (_req, res) => {
        res.setHeader('Set-Cookie', cookieStr(COOKIE, '', 0));
        res.redirect('/auth/login');
    });

    app.use((req, res, next) => {
        if (EXEMPT.has(req.path)) return next();
        // Notification thumbnails: the unguessable expiring token is the credential (rest.js)
        if (req.method === 'GET' && /^\/push\/thumb\/[0-9a-f]{32}\.jpg$/.test(req.path)) return next();
        if (verifyToken(parseCookies(req.headers.cookie)[COOKIE], cfg.sessionSecret)) return next();
        const accept = req.headers.accept || '';
        if (req.method === 'GET' && accept.includes('text/html')) return res.redirect('/auth/login');
        return res.status(401).json({ error: 'unauthorized' });
    });

    if (!cfg.clientId || !cfg.clientSecret) {
        console.log('[auth] WARNING: clientId/clientSecret missing in auth.json — all access is blocked until set');
    } else {
        console.log('[auth] Google OAuth gate ENABLED for ' + cfg.baseUrl);
    }
    return { enabled: true };
}

// ============================================================================
// Multi-user access scoping
// ----------------------------------------------------------------------------
// auth.json shape (all fields optional except clientId/secret/sessionSecret):
//   allowedEmails: []   legacy full-access list (treated as admins by default)
//   admins:        []   emails with admin rights + access to every camera
//   users:         [ { email, cameras: ["SN1","SN2"] | "all" } ]  scoped users
// An email is permitted to sign in if it appears in any of the three lists.
// ============================================================================

// Resolve the admin list. If `admins` is explicitly set, use it; otherwise the
// legacy allowedEmails behave as admins (preserves pre-scoping behavior).
function adminEmails(cfg) {
    const list = (cfg.admins && cfg.admins.length) ? cfg.admins : (cfg.allowedEmails || []);
    return list.map(lc);
}

// Compute a user's access scope: { email, allowed, admin, cameras }.
// cameras is the string 'all' or an array of allowed serial numbers.
function getScopeForEmail(email) {
    const cfg = loadConfig();
    if (!cfg || !cfg.enabled) {
        // Auth disabled → wide-open (local/dev). Treat as admin so the owner can
        // still see the management UI when testing without OAuth.
        return { email: email || null, allowed: true, admin: true, cameras: 'all', authEnabled: false };
    }
    const e = lc(email);
    if (!e) return { email: null, allowed: false, admin: false, cameras: [], authEnabled: true };

    if (adminEmails(cfg).includes(e)) {
        return { email: e, allowed: true, admin: true, cameras: 'all', authEnabled: true };
    }
    // Legacy full-access (in allowedEmails but admins explicitly set elsewhere)
    if ((cfg.allowedEmails || []).map(lc).includes(e)) {
        return { email: e, allowed: true, admin: false, cameras: 'all', authEnabled: true };
    }
    const user = (cfg.users || []).find((u) => lc(u.email) === e);
    if (user) {
        const cams = user.cameras === 'all' ? 'all' : (Array.isArray(user.cameras) ? user.cameras : []);
        return { email: e, allowed: true, admin: false, cameras: cams, authEnabled: true };
    }
    return { email: e, allowed: false, admin: false, cameras: [], authEnabled: true };
}

// Read the verified session email from a Cookie header (null if not signed in).
function getSessionEmail(cookieHeader) {
    const cfg = loadConfig();
    if (!cfg || !cfg.enabled || !cfg.sessionSecret) return null;
    const data = verifyToken(parseCookies(cookieHeader)[COOKIE], cfg.sessionSecret);
    return data ? data.email : null;
}

// Resolve scope directly from a request's Cookie header.
function scopeForCookieHeader(cookieHeader) {
    const cfg = loadConfig();
    if (!cfg || !cfg.enabled) {
        return { email: null, allowed: true, admin: true, cameras: 'all', authEnabled: false };
    }
    return getScopeForEmail(getSessionEmail(cookieHeader));
}

// True if an email is permitted to sign in at all (any list).
function isEmailAllowed(email) {
    return getScopeForEmail(email).allowed;
}

// True if a given scope grants access to a specific camera serial number.
function isCameraAllowed(scope, serialNumber) {
    if (!scope || !scope.allowed) return false;
    if (scope.cameras === 'all') return true;
    return Array.isArray(scope.cameras) && scope.cameras.includes(serialNumber);
}

// ---- Admin: scoped-user CRUD (persisted to auth.json) ----

// List scoped users plus the admin emails (for display in the management UI).
function listAccess() {
    const cfg = loadConfig() || {};
    return {
        admins: adminEmails(cfg),
        users: (cfg.users || []).map((u) => ({
            email: lc(u.email),
            cameras: u.cameras === 'all' ? 'all' : (Array.isArray(u.cameras) ? u.cameras : [])
        }))
    };
}

// Add or update a scoped user. cameras is 'all' or an array of serials.
// Refuses to shadow an admin/legacy-full email (those already have full access).
function upsertUser(email, cameras) {
    const cfg = loadConfig();
    if (!cfg) throw new Error('auth not configured');
    const e = lc(email);
    if (!e || e.indexOf('@') === -1) throw new Error('valid email required');
    if (adminEmails(cfg).includes(e)) throw new Error('that email is an admin (already has full access)');

    const cams = cameras === 'all' ? 'all' : (Array.isArray(cameras) ? cameras.filter(Boolean) : []);
    cfg.users = cfg.users || [];
    const existing = cfg.users.find((u) => lc(u.email) === e);
    if (existing) {
        existing.email = e;
        existing.cameras = cams;
    } else {
        cfg.users.push({ email: e, cameras: cams });
    }
    saveConfig(cfg);
    return { email: e, cameras: cams };
}

// Remove a scoped user. (Admins cannot be removed via this endpoint.)
function removeUser(email) {
    const cfg = loadConfig();
    if (!cfg) throw new Error('auth not configured');
    const e = lc(email);
    cfg.users = (cfg.users || []).filter((u) => lc(u.email) !== e);
    saveConfig(cfg);
    return { email: e };
}

module.exports = {
    installAuth,
    isAuthedCookieHeader,
    getScopeForEmail,
    getSessionEmail,
    scopeForCookieHeader,
    isEmailAllowed,
    isCameraAllowed,
    listAccess,
    upsertUser,
    removeUser
};
