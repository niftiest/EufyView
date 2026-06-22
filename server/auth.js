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

function parseCookies(header) {
    const out = {};
    (header || '').split(';').forEach((p) => {
        const i = p.indexOf('=');
        if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
}

function cookieStr(name, value, maxAgeSec) {
    let s = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
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
    const allowed = (cfg.allowedEmails || []).map((e) => e.toLowerCase());

    app.get('/auth/login', (_req, res) => {
        const state = crypto.randomBytes(16).toString('hex');
        res.setHeader('Set-Cookie', cookieStr(STATE_COOKIE, sign(state, cfg.sessionSecret), 600));
        const params = new URLSearchParams({
            client_id: cfg.clientId || '',
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: 'openid email',
            state,
            access_type: 'online',
            prompt: 'select_account',
        });
        res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
    });

    app.get('/auth/google/callback', async (req, res) => {
        try {
            const code = req.query.code;
            const state = req.query.state;
            const stateCookie = parseCookies(req.headers.cookie)[STATE_COOKIE];
            if (!code || !state || !stateCookie || stateCookie !== sign(String(state), cfg.sessionSecret)) {
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
            if (!allowed.includes(String(claims.email).toLowerCase())) {
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

module.exports = { installAuth, isAuthedCookieHeader };
