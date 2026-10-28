/**
 * auth.js - built-in multi-user password gate for EufyView (dependency-free).
 *
 * One administrator + any number of scoped users. The administrator manages
 * everyone and delegates each user's camera access through the web admin panel;
 * users never change their own scope. First passwords are claimed with a
 * one-time code the admin generates. Sessions are HMAC-signed cookies; headless
 * appliances (TV app) use long-lived bearer device tokens. No external identity
 * provider.
 *
 * auth.json shape:
 *   {
 *     "enabled": true,
 *     "sessionSecret": "<hex>",
 *     "baseUrl": "https://…",          // remote URL, for display only (optional)
 *     "admin":  { "email", "passwordHash", "lastLogin", "lastIp" },
 *     "users": [ {
 *       "email", "cameras": "all" | ["SN",…],
 *       "passwordHash": "<salt:hash>" | null,
 *       "claim": { "hash": "<salt:hash>", "expires": <ms> } | null,
 *       "lastLogin", "lastIp", "passwordSetAt", "passwordSetIp"
 *     } ]
 *   }
 * Passwords and claim codes are stored only as salted scrypt hashes - never
 * as plaintext.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// auth.json lives in data/ with the rest of the persistent state, so it survives
// a reinstall/upgrade (the installer never writes into data/ except first-run
// seeding) and moves with the app as one unit. DATA_DIR mirrors utils.
// AUTH_CONFIG_PATH lets tests point at a throwaway config without touching it.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_PATH = process.env.AUTH_CONFIG_PATH || path.join(DATA_DIR, 'auth.json');
const LEGACY_CONFIG_PATH = path.join(__dirname, '..', 'auth.json');  // pre-unify: install root

// One-time migration: older installs kept auth.json at the install root. Move it
// into data/ once, so existing admin/users carry over after upgrading.
(function migrateLegacyAuth() {
    if (process.env.AUTH_CONFIG_PATH) return;   // tests use their own file
    try {
        if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(LEGACY_CONFIG_PATH)) {
            fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
            fs.renameSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
        }
    } catch (e) { /* best-effort; absent → treated as fresh setup */ }
})();

const COOKIE = 'ev_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;             // 30 days (browser session)
const DEVICE_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000; // 10 years (appliance/TV tokens)
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;            // claim codes expire after 7 days

let _cfg;
let _loaded = false;
let _configCorrupt = false;   // file present but unreadable/unparseable → fail closed
function loadConfig() {
    if (_loaded) return _cfg;
    _loaded = true;
    try {
        // Strip a leading UTF-8 BOM if present - a config written by some tools
        // (e.g. PowerShell's Out-File -Encoding utf8) starts with ﻿, which
        // makes JSON.parse throw and would silently disable the whole auth gate.
        _cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
        _configCorrupt = false;
    } catch (e) {
        _cfg = null;
        // Distinguish a genuinely absent config (fresh install / dev → gate off)
        // from one that EXISTS but can't be read/parsed. A corrupt auth.json must
        // NOT silently disable authentication - that would expose the whole app.
        _configCorrupt = (e.code !== 'ENOENT') && fs.existsSync(CONFIG_PATH);
    }
    return _cfg;
}
function isConfigCorrupt() { return _configCorrupt; }

// Persist config back to auth.json and refresh the in-memory cache.
// Pretty-printed so the file stays hand-editable.
function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    _cfg = cfg;
    _loaded = true;
    return cfg;
}

const lc = (s) => String(s || '').trim().toLowerCase();

// ---- scrypt hashing (passwords and claim codes) ----
// Stored as "<saltHex>:<hashHex>" - one-way, salted, memory-hard.
function hashSecret(secret) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(secret), salt, 32);
    return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifySecret(secret, stored) {
    try {
        const [saltHex, hashHex] = String(stored || '').split(':');
        if (!saltHex || !hashHex) return false;
        const expected = Buffer.from(hashHex, 'hex');
        const actual = crypto.scryptSync(String(secret), Buffer.from(saltHex, 'hex'), expected.length);
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch (e) {
        return false;
    }
}
// Back-compat aliases (other modules / the tray import these names).
const hashPassword = hashSecret;
const verifyPassword = verifySecret;

// A short, human-friendly one-time claim code (unambiguous alphabet, grouped).
// ~5.1e10 combinations over 8 chars; single-use, hashed at rest, rate-limited.
function genClaimCode() {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
    let s = '';
    for (let i = 0; i < 8; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    return s.slice(0, 4) + '-' + s.slice(4);  // e.g. "H7KP-9XTM"
}
const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---- config / user model helpers ----

function adminConfigured(cfg) {
    return !!(cfg && cfg.admin && cfg.admin.email && cfg.admin.passwordHash);
}

// Which gate mode applies. OAuth is gone; it's password or (not yet set up).
function authMode(cfg) {
    if (!cfg || !cfg.enabled) return null;
    return adminConfigured(cfg) ? 'password' : 'setup';
}

function findUser(cfg, email) {
    const e = lc(email);
    return (cfg.users || []).find((u) => lc(u.email) === e) || null;
}

// Is this email the administrator?
function isAdminEmail(cfg, email) {
    return !!(cfg && cfg.admin && lc(cfg.admin.email) === lc(email));
}

// Ensure a sessionSecret exists (generated on first admin setup).
function ensureSecret(cfg) {
    if (!cfg.sessionSecret) cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
    return cfg.sessionSecret;
}

// ---- rate limiting / lockout (in-memory; resets on restart) ----
// Tracks failed logins/claims per account email and per source IP. After enough
// failures the email (and/or IP) is locked for an exponentially growing window.
const FAIL_WINDOW_MS = 15 * 60 * 1000;   // failures older than this don't count
const EMAIL_FAIL_LIMIT = 5;              // per-account fails before lockout
const IP_FAIL_LIMIT = 20;                // per-IP fails before lockout
const LOCK_BASE_MS = 60 * 1000;          // first lockout = 1 min, doubling each time
const LOCK_MAX_MS = 60 * 60 * 1000;      // capped at 1 hour

const emailGuard = new Map();  // lc(email) -> { fails:[ts], lockedUntil, lockCount }
const ipGuard = new Map();     // ip        -> { fails:[ts], lockedUntil, lockCount }

function guardFor(map, key) {
    let g = map.get(key);
    if (!g) { g = { fails: [], lockedUntil: 0, lockCount: 0 }; map.set(key, g); }
    return g;
}
function pruneGuard(g, now) { g.fails = g.fails.filter((t) => now - t < FAIL_WINDOW_MS); }

// Returns { locked, retryAfterSec } - locked if the email or IP is in a lockout.
function checkLockout(email, ip) {
    const now = Date.now();
    let until = 0;
    if (email) { const g = emailGuard.get(lc(email)); if (g && g.lockedUntil > now) until = Math.max(until, g.lockedUntil); }
    if (ip)    { const g = ipGuard.get(ip);           if (g && g.lockedUntil > now) until = Math.max(until, g.lockedUntil); }
    return until > now ? { locked: true, retryAfterSec: Math.ceil((until - now) / 1000) } : { locked: false, retryAfterSec: 0 };
}

function recordFail(email, ip) {
    const now = Date.now();
    const bump = (map, key, limit) => {
        if (!key) return;
        const g = guardFor(map, key);
        pruneGuard(g, now);
        g.fails.push(now);
        if (g.fails.length >= limit) {
            g.lockCount += 1;
            g.lockedUntil = now + Math.min(LOCK_BASE_MS * Math.pow(2, g.lockCount - 1), LOCK_MAX_MS);
            g.fails = [];
        }
    };
    bump(emailGuard, email ? lc(email) : null, EMAIL_FAIL_LIMIT);
    bump(ipGuard, ip || null, IP_FAIL_LIMIT);
}

function recordSuccess(email, ip) {
    if (email) emailGuard.delete(lc(email));
    if (ip)    ipGuard.delete(ip);
}

// Currently-locked accounts/IPs (for the Security tab).
function lockoutStatus() {
    const now = Date.now();
    const out = { emails: [], ips: [] };
    for (const [k, g] of emailGuard) if (g.lockedUntil > now) out.emails.push({ email: k, retryAfterSec: Math.ceil((g.lockedUntil - now) / 1000) });
    for (const [k, g] of ipGuard)    if (g.lockedUntil > now) out.ips.push({ ip: k, retryAfterSec: Math.ceil((g.lockedUntil - now) / 1000) });
    return out;
}

// ---- signed tokens + cookies ----
const sign = (value, secret) => crypto.createHmac('sha256', secret).update(value).digest('base64url');

function makeToken(email, secret) {
    const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + MAX_AGE_MS })).toString('base64url');
    return `${payload}.${sign(payload, secret)}`;
}

// Long-lived token for a headless appliance (Fire TV / Android TV alert app)
// that can't hold a browser cookie. Same signed format; inherits email's scope.
function makeDeviceToken(email, secret) {
    const payload = Buffer.from(JSON.stringify({ email, kind: 'device', exp: Date.now() + DEVICE_MAX_AGE_MS })).toString('base64url');
    return `${payload}.${sign(payload, secret)}`;
}

// Pull a bearer token off a request: `Authorization: Bearer <t>` or `?token=<t>`
// (query is handy for a WebSocket upgrade, which can't set custom headers).
function tokenFromReq(req) {
    if (!req) return null;
    const h = req.headers && (req.headers.authorization || req.headers.Authorization);
    if (h && /^Bearer\s+/i.test(h)) return h.slice(7).trim();
    if (req.query && req.query.token) return String(req.query.token);
    try {
        const t = new URL(req.url, 'http://x').searchParams.get('token');
        if (t) return t;
    } catch (e) {}
    return null;
}

function verifyToken(token, secret) {
    // No secret yet (setup mode, before any admin exists) → no token can be
    // valid. Guard here so a leftover cookie from a previous install doesn't
    // crash createHmac with an undefined key.
    if (!secret) return null;
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
    // SameSite=None (with Secure) so the session cookie is sent when the
    // installed PWA/TWA relaunches - its launch navigation is treated as
    // cross-site by Chrome, which drops SameSite=Lax cookies. Cross-site
    // state-changing requests are still blocked by CORS.
    let s = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=None`;
    if (maxAgeSec != null) s += `; Max-Age=${Math.floor(maxAgeSec)}`;
    return s;
}

// ---- scope resolution ----
// Resolve a session email's camera scope. Only ever called with an email that
// came from a verified session/device token, so no password check here.
function getScopeForEmail(email) {
    const cfg = loadConfig();
    if (!cfg || !cfg.enabled) {
        // Auth disabled → wide-open (local/dev). Treat as admin so the owner can
        // still reach the management UI when testing without a gate.
        return { email: email || null, allowed: true, admin: true, cameras: 'all', authEnabled: false };
    }
    const e = lc(email);
    if (!e) return { email: null, allowed: false, admin: false, cameras: [], authEnabled: true };
    if (isAdminEmail(cfg, e)) return { email: e, allowed: true, admin: true, cameras: 'all', authEnabled: true };
    const u = findUser(cfg, e);
    if (u) {
        const cams = u.cameras === 'all' ? 'all' : (Array.isArray(u.cameras) ? u.cameras : []);
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

function scopeForCookieHeader(cookieHeader) {
    const cfg = loadConfig();
    if (!cfg || !cfg.enabled) return { email: null, allowed: true, admin: true, cameras: 'all', authEnabled: false };
    return getScopeForEmail(getSessionEmail(cookieHeader));
}

// Resolve a camera scope from a request's cookie OR bearer device token.
function scopeForRequest(req) {
    const cfg = loadConfig();
    if (!cfg || !cfg.enabled) return { email: null, allowed: true, admin: true, cameras: 'all', authEnabled: false };
    const email = getSessionEmail(req.headers && req.headers.cookie);
    if (email) return getScopeForEmail(email);
    const t = tokenFromReq(req);
    const data = t ? verifyToken(t, cfg.sessionSecret) : null;
    return data ? getScopeForEmail(data.email) : { email: null, allowed: false, admin: false, cameras: [], authEnabled: true };
}

function isAuthedCookieHeader(cookieHeader) {
    const cfg = loadConfig();
    if (!cfg || !cfg.enabled) return true;
    if (!cfg.sessionSecret) return false;
    return !!verifyToken(parseCookies(cookieHeader)[COOKIE], cfg.sessionSecret);
}

function isAuthedRequest(req) {
    const cfg = loadConfig();
    if (!cfg || !cfg.enabled) return true;
    if (!cfg.sessionSecret) return false;
    if (isAuthedCookieHeader(req.headers && req.headers.cookie)) return true;
    const t = tokenFromReq(req);
    return !!(t && verifyToken(t, cfg.sessionSecret));
}

function isEmailAllowed(email) { return getScopeForEmail(email).allowed; }

function isCameraAllowed(scope, serialNumber) {
    if (!scope || !scope.allowed) return false;
    if (scope.cameras === 'all') return true;
    return Array.isArray(scope.cameras) && scope.cameras.includes(serialNumber);
}

// ---- login / claim ----

// Verify an email+password. Applies lockout. On success records lastLogin/lastIp
// and returns { ok, email, admin }. On failure returns { error, retryAfterSec }.
function authenticate(email, password, ip) {
    const cfg = loadConfig();
    if (!adminConfigured(cfg)) return { error: 'not_setup' };
    const lock = checkLockout(email, ip);
    if (lock.locked) return { error: 'locked', retryAfterSec: lock.retryAfterSec };

    const e = lc(email);
    let record = null, isAdmin = false;
    if (isAdminEmail(cfg, e)) { record = cfg.admin; isAdmin = true; }
    else record = findUser(cfg, e);

    const ok = record && record.passwordHash && verifySecret(password, record.passwordHash);
    if (!ok) { recordFail(email, ip); return { error: 'invalid' }; }

    recordSuccess(email, ip);
    record.lastLogin = Date.now();
    record.lastIp = ip || null;
    saveConfig(cfg);
    return { ok: true, email: e, admin: isAdmin };
}

// Claim an account's first password with a one-time code. Applies lockout.
// Returns { ok, email } or { error, retryAfterSec }.
function claimAccount(email, code, password, ip) {
    const cfg = loadConfig();
    if (!cfg || !cfg.enabled) return { error: 'not_setup' };
    const lock = checkLockout(email, ip);
    if (lock.locked) return { error: 'locked', retryAfterSec: lock.retryAfterSec };
    if (String(password || '').length < 8) return { error: 'weak' };

    const u = findUser(cfg, email);
    const now = Date.now();
    const valid = u && !u.passwordHash && u.claim && u.claim.hash &&
                  u.claim.expires > now && verifySecret(normalizeCode(code), u.claim.hash);
    if (!valid) { recordFail(email, ip); return { error: 'invalid' }; }

    u.passwordHash = hashSecret(password);
    u.claim = null;
    u.passwordSetAt = now;
    u.passwordSetIp = ip || null;
    u.lastLogin = now;
    u.lastIp = ip || null;
    recordSuccess(email, ip);
    saveConfig(cfg);
    return { ok: true, email: lc(u.email) };
}

// ---- administrator account ----

// Create or replace the administrator (installer / tray break-glass / first
// run). Turns the gate on and generates a session secret if missing. The old
// `setPassword(username, password)` entry point maps here.
function setAdmin(email, password) {
    const e = lc(email);
    if (!e) throw new Error('an admin email/username is required');
    if (String(password || '').length < 8) throw new Error('password must be at least 8 characters');
    const cfg = loadConfig() || {};
    cfg.enabled = true;
    ensureSecret(cfg);
    const prev = cfg.admin || {};
    cfg.admin = {
        email: e,
        passwordHash: hashSecret(password),
        lastLogin: prev.lastLogin || null,
        lastIp: prev.lastIp || null,
    };
    saveConfig(cfg);
    return { ok: true, email: e, mode: authMode(cfg) };
}

// Change the admin's email and/or password while signed in. Requires the
// current password. Pass only the fields to change.
function updateAdminAccount({ currentPassword, newEmail, newPassword }) {
    const cfg = loadConfig();
    if (!adminConfigured(cfg)) throw new Error('no administrator configured');
    if (!verifySecret(currentPassword, cfg.admin.passwordHash)) throw new Error('current password is incorrect');
    if (newEmail) {
        const e = lc(newEmail);
        if (findUser(cfg, e)) throw new Error('that email is already a user');
        cfg.admin.email = e;
    }
    if (newPassword) {
        if (String(newPassword).length < 8) throw new Error('new password must be at least 8 characters');
        cfg.admin.passwordHash = hashSecret(newPassword);
    }
    saveConfig(cfg);
    return { ok: true, email: cfg.admin.email };
}

// ---- user management (administrator only) ----

// Add a user (or update access if they already exist). New users get a one-time
// claim code; the PLAINTEXT code is returned once (never stored) for the admin
// to share. cameras = 'all' | array of serials.
function addUser(email, cameras) {
    const cfg = loadConfig();
    if (!cfg) throw new Error('auth not configured');
    const e = lc(email);
    if (!e || e.indexOf('@') === -1) throw new Error('a valid email is required');
    if (isAdminEmail(cfg, e)) throw new Error('that email is the administrator');
    const cams = cameras === 'all' ? 'all' : (Array.isArray(cameras) ? cameras.filter(Boolean) : []);
    cfg.users = cfg.users || [];
    let u = findUser(cfg, e);
    let claimCode = null;
    if (u) {
        u.cameras = cams;                 // existing user: just update access
    } else {
        claimCode = genClaimCode();
        u = {
            email: e, cameras: cams, passwordHash: null,
            claim: { hash: hashSecret(normalizeCode(claimCode)), expires: Date.now() + CLAIM_TTL_MS },
            lastLogin: null, lastIp: null, passwordSetAt: null, passwordSetIp: null,
        };
        cfg.users.push(u);
    }
    saveConfig(cfg);
    return { user: publicUser(u), claimCode };   // claimCode is null when updating
}

function updateUserAccess(email, cameras) {
    const cfg = loadConfig();
    const u = findUser(cfg, email);
    if (!u) throw new Error('no such user');
    u.cameras = cameras === 'all' ? 'all' : (Array.isArray(cameras) ? cameras.filter(Boolean) : []);
    saveConfig(cfg);
    return { user: publicUser(u) };
}

// Clear a user's password and issue a fresh claim code (admin reset). Returns
// the new plaintext code once.
function resetUserPassword(email) {
    const cfg = loadConfig();
    const u = findUser(cfg, email);
    if (!u) throw new Error('no such user');
    const claimCode = genClaimCode();
    u.passwordHash = null;
    u.claim = { hash: hashSecret(normalizeCode(claimCode)), expires: Date.now() + CLAIM_TTL_MS };
    u.passwordSetAt = null;
    u.passwordSetIp = null;
    saveConfig(cfg);
    return { claimCode };
}

// Reissue a claim code for a user who hasn't set a password yet (e.g. expired).
function regenClaim(email) {
    const cfg = loadConfig();
    const u = findUser(cfg, email);
    if (!u) throw new Error('no such user');
    if (u.passwordHash) throw new Error('user already has a password; use reset instead');
    const claimCode = genClaimCode();
    u.claim = { hash: hashSecret(normalizeCode(claimCode)), expires: Date.now() + CLAIM_TTL_MS };
    saveConfig(cfg);
    return { claimCode };
}

function removeUser(email) {
    const cfg = loadConfig();
    if (!cfg) throw new Error('auth not configured');
    const e = lc(email);
    cfg.users = (cfg.users || []).filter((u) => lc(u.email) !== e);
    saveConfig(cfg);
    return { email: e };
}

// Public (no-secret) view of a user record.
function publicUser(u) {
    return {
        email: lc(u.email),
        cameras: u.cameras === 'all' ? 'all' : (Array.isArray(u.cameras) ? u.cameras : []),
        hasPassword: !!u.passwordHash,
        claimPending: !!(u.claim && u.claim.expires > Date.now()),
        claimExpires: u.claim ? u.claim.expires : null,
        lastLogin: u.lastLogin || null,
        lastIp: u.lastIp || null,
        passwordSetAt: u.passwordSetAt || null,
    };
}

// Full access listing for the admin panel.
function listAccess() {
    const cfg = loadConfig() || {};
    return {
        admin: cfg.admin ? { email: lc(cfg.admin.email), lastLogin: cfg.admin.lastLogin || null, lastIp: cfg.admin.lastIp || null } : null,
        users: (cfg.users || []).map(publicUser),
        lockouts: lockoutStatus(),
    };
}

// Legacy alias used by rest.js POST /admin/users.
function upsertUser(email, cameras) { return addUser(email, cameras).user; }

// Report what auth is configured (no secrets) - for setup UI + /status.
function authStatus() {
    const cfg = loadConfig() || {};
    return {
        enabled: !!cfg.enabled,
        mode: authMode(cfg),                 // 'password' | 'setup' | null
        adminSet: adminConfigured(cfg),
        adminEmail: (cfg.admin && cfg.admin.email) ? lc(cfg.admin.email) : null,
        userCount: (cfg.users || []).length,
    };
}

// The configured public origin (Tailscale/Cloudflare URL), or null.
function getPublicBaseUrl() {
    const cfg = loadConfig();
    return (cfg && cfg.baseUrl) || null;
}

// Mint a device token bound to the admin account, for server-side auto-pairing
// (the smart-device installer). Placeholder in open/dev mode.
function mintDeviceTokenForAdmin() {
    const cfg = loadConfig();
    if (!cfg || !cfg.sessionSecret) return 'local';
    const email = (cfg.admin && cfg.admin.email) || 'admin';
    return makeDeviceToken(email, cfg.sessionSecret);
}

// ---- TV pairing codes ----
// A short-lived numeric code the web app shows ("Pair a TV") and the TV redeems
// for a device token. In memory only, one per account, expire quickly,
// single-use, globally rate-limited against brute force of the 6-digit space.
const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
const PAIR_REDEEM_WINDOW_MS = 60 * 1000;
const PAIR_REDEEM_MAX_FAILS = 20;
const pairCodes = new Map();   // code -> { email, expires }
let pairRedeemFails = [];

function prunePairCodes() {
    const now = Date.now();
    for (const [c, v] of pairCodes) if (v.expires < now) pairCodes.delete(c);
}

function makePairCode(email) {
    prunePairCodes();
    for (const [c, v] of pairCodes) if (v.email === email) pairCodes.delete(c);
    let code;
    do { code = String(crypto.randomInt(100000, 1000000)); } while (pairCodes.has(code));
    pairCodes.set(code, { email, expires: Date.now() + PAIR_CODE_TTL_MS });
    return { code, expiresInSec: Math.floor(PAIR_CODE_TTL_MS / 1000) };
}

function redeemPairCode(rawCode) {
    prunePairCodes();
    const now = Date.now();
    pairRedeemFails = pairRedeemFails.filter((t) => now - t < PAIR_REDEEM_WINDOW_MS);
    if (pairRedeemFails.length >= PAIR_REDEEM_MAX_FAILS) return { error: 'rate_limited' };
    const code = String(rawCode || '').trim();
    const entry = code && pairCodes.get(code);
    if (!entry) { pairRedeemFails.push(now); return { error: 'invalid' }; }
    pairCodes.delete(code);
    const cfg = loadConfig();
    return { token: makeDeviceToken(entry.email, cfg.sessionSecret), email: entry.email };
}

// ---- login page ----
// Two tabs: Sign in (email+password) and First time (email+claim code+password).
// Neither reveals whether an email exists (both fail generically).
function loginPage() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>EufyView - Sign in</title>
<style>
:root{--bg:#eef1f5;--card:#fff;--field:#f1f3f6;--border:#d9dee6;--text:#161a20;--muted:#667085;--primary:#1f6fff;--primary-h:#155ae0;--danger:#e23b3b;--ring:rgba(31,111,255,.4);color-scheme:light}
:root[data-theme=dark]{--bg:#0c0d0f;--card:#17191d;--field:#212530;--border:#2c313b;--text:#e9ebf0;--muted:#9aa2b1;--primary:#4a9eff;--primary-h:#6ab4ff;--danger:#ff5a5f;--ring:rgba(74,158,255,.5);color-scheme:dark}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;background:var(--bg);color:var(--text);display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px;-webkit-font-smoothing:antialiased}
.card{background:var(--card);padding:28px 26px;border-radius:18px;width:340px;max-width:100%;border:1px solid var(--border);box-shadow:0 1px 2px rgba(16,24,40,.06),0 16px 48px rgba(16,24,40,.12)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.brand .logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--primary),#7db4ff);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.brand .logo svg{width:20px;height:20px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
h1{font-size:20px;font-weight:700;margin:0;letter-spacing:-.3px}
.tabs{display:flex;gap:4px;margin:4px 0 14px;background:var(--field);padding:4px;border-radius:12px}
.tabs button{flex:1;padding:9px;border:0;border-radius:9px;background:transparent;color:var(--muted);font-weight:600;font-size:14px;cursor:pointer;transition:.15s}
.tabs button.active{background:var(--card);color:var(--text);box-shadow:0 1px 2px rgba(16,24,40,.14)}
input{width:100%;padding:12px 14px;margin:6px 0;border-radius:11px;border:1px solid var(--border);background:var(--field);color:var(--text);font-size:16px;transition:.15s}
input:focus{outline:0;border-color:var(--primary);box-shadow:0 0 0 3px var(--ring)}
button.go{width:100%;padding:13px;margin-top:12px;border:0;border-radius:11px;background:var(--primary);color:#fff;font-weight:600;font-size:15px;cursor:pointer;transition:.15s}
button.go:hover{background:var(--primary-h)}
.msg{color:var(--danger);font-size:13px;min-height:18px;margin-top:6px}
.hint{color:var(--muted);font-size:12.5px;margin:2px 0 0;line-height:1.5}
.hide{display:none}
</style>
<script>try{if(localStorage.getItem('eufyview-theme')==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}</script></head>
<body><div class="card"><div class="brand"><span class="logo"><svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></span><h1>EufyView</h1></div>
<div class="tabs"><button id="t-signin" class="active">Sign in</button><button id="t-claim">First time</button></div>
<form id="signin"><input id="si-email" type="email" placeholder="Email" autocomplete="username" autofocus>
<input id="si-pass" type="password" placeholder="Password" autocomplete="current-password">
<button class="go" type="submit">Sign in</button></form>
<form id="claim" class="hide"><p class="hint">Enter the one-time code your administrator gave you and choose a password.</p>
<input id="cl-email" type="email" placeholder="Email" autocomplete="username">
<input id="cl-code" placeholder="Claim code (e.g. ABCD-2345)" autocomplete="off">
<input id="cl-pass" type="password" placeholder="New password (8+ characters)" autocomplete="new-password">
<button class="go" type="submit">Set password &amp; sign in</button></form>
<div class="msg" id="msg"></div></div>
<script>
var msg=document.getElementById('msg');
function tab(which){
  document.getElementById('t-signin').classList.toggle('active',which==='signin');
  document.getElementById('t-claim').classList.toggle('active',which==='claim');
  document.getElementById('signin').classList.toggle('hide',which!=='signin');
  document.getElementById('claim').classList.toggle('hide',which!=='claim');
  msg.textContent='';
}
document.getElementById('t-signin').onclick=function(){tab('signin')};
document.getElementById('t-claim').onclick=function(){tab('claim')};
document.getElementById('signin').addEventListener('submit',async function(e){e.preventDefault();msg.textContent='';
  var r=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email:document.getElementById('si-email').value,password:document.getElementById('si-pass').value})});
  if(r.ok){location.href='/';return;}
  if(r.status===429){var j=await r.json().catch(function(){return{}});msg.textContent='Too many attempts. Try again in '+(j.retryAfterSec||60)+'s.';}
  else msg.textContent='Incorrect email or password.';
});
document.getElementById('claim').addEventListener('submit',async function(e){e.preventDefault();msg.textContent='';
  var r=await fetch('/auth/claim',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email:document.getElementById('cl-email').value,code:document.getElementById('cl-code').value,password:document.getElementById('cl-pass').value})});
  if(r.ok){location.href='/';return;}
  var j=await r.json().catch(function(){return{}});
  if(r.status===429)msg.textContent='Too many attempts. Try again in '+(j.retryAfterSec||60)+'s.';
  else if(j.error==='weak')msg.textContent='Password must be at least 8 characters.';
  else msg.textContent='That email and code don\\'t match, or the code has expired.';
});
</script></body></html>`;
}

// First-run "Initial Setup" page: create the administrator account. Shown only
// while no admin exists (setup mode). Creating the admin is restricted to the
// server machine itself (loopback) - see the /setup/set-password handler - so a
// reachable server can't be hijacked by whoever loads this first.
function setupPage() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>EufyView - Set up</title>
<style>
:root{--bg:#eef1f5;--card:#fff;--field:#f1f3f6;--border:#d9dee6;--text:#161a20;--muted:#667085;--primary:#1f6fff;--primary-h:#155ae0;--danger:#e23b3b;--ok:#1f9d4d;--ring:rgba(31,111,255,.4);color-scheme:light}
:root[data-theme=dark]{--bg:#0c0d0f;--card:#17191d;--field:#212530;--border:#2c313b;--text:#e9ebf0;--muted:#9aa2b1;--primary:#4a9eff;--primary-h:#6ab4ff;--danger:#ff5a5f;--ok:#41c972;--ring:rgba(74,158,255,.5);color-scheme:dark}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;background:var(--bg);color:var(--text);display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px;-webkit-font-smoothing:antialiased}
.card{background:var(--card);padding:30px 28px;border-radius:18px;width:360px;max-width:100%;border:1px solid var(--border);box-shadow:0 1px 2px rgba(16,24,40,.06),0 16px 48px rgba(16,24,40,.12)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.brand .logo{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--primary),#7db4ff);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.brand .logo svg{width:22px;height:22px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
h1{font-size:21px;font-weight:700;margin:0;letter-spacing:-.3px}
.sub{color:var(--muted);font-size:14px;margin:0 0 14px;line-height:1.5}
label{display:block;font-size:13px;color:var(--muted);margin-top:14px;font-weight:500}
input{width:100%;padding:12px 14px;margin-top:6px;border-radius:11px;border:1px solid var(--border);background:var(--field);color:var(--text);font-size:16px;transition:.15s}
input:focus{outline:0;border-color:var(--primary);box-shadow:0 0 0 3px var(--ring)}
button.go{width:100%;padding:13px;margin-top:20px;border:0;border-radius:11px;background:var(--primary);color:#fff;font-weight:600;font-size:15px;cursor:pointer;transition:.15s}
button.go:hover{background:var(--primary-h)}
button.go:disabled{opacity:.6}
.msg{font-size:13px;min-height:18px;margin-top:10px}
.msg.err{color:var(--danger)}.msg.ok{color:var(--ok)}
.foot{color:var(--muted);font-size:12px;margin-top:14px;line-height:1.5}
</style>
<script>try{if(localStorage.getItem('eufyview-theme')==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}</script></head>
<body><div class="card">
<div class="brand"><span class="logo"><svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></span><h1>Welcome to EufyView</h1></div>
<p class="sub">Create your administrator account to finish setup. You'll manage cameras and users with this login.</p>
<form id="f">
<label>Email (your username)<input id="email" type="email" autocomplete="username" autofocus placeholder="you@example.com"></label>
<label>Password (8+ characters)<input id="p1" type="password" autocomplete="new-password"></label>
<label>Confirm password<input id="p2" type="password" autocomplete="new-password"></label>
<button class="go" type="submit">Create account &amp; continue</button>
</form>
<div class="msg" id="msg"></div>
<p class="foot">Only a salted hash of your password is stored - never the password itself. Set this up on the server computer; it can't be done from another device for security.</p>
</div>
<script>
var msg=document.getElementById('msg');
function set(t,ok){msg.textContent=t;msg.className='msg '+(ok?'ok':'err');}
document.getElementById('f').addEventListener('submit',async function(e){e.preventDefault();
  var email=document.getElementById('email').value.trim();
  var p1=document.getElementById('p1').value,p2=document.getElementById('p2').value;
  if(!email||email.indexOf('@')===-1){set('Enter an email to use as your username.',false);return;}
  if(p1.length<8){set('Password must be at least 8 characters.',false);return;}
  if(p1!==p2){set('Passwords don\\'t match.',false);return;}
  var btn=document.querySelector('button.go');btn.disabled=true;set('Creating account…',true);
  try{
    var r=await fetch('/setup/set-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email,password:p1})});
    if(r.status===403){set('For security, finish setup on the server computer - open http://localhost:'+location.port+' there.',false);btn.disabled=false;return;}
    var j=await r.json().catch(function(){return{}});
    if(!r.ok){set(j.error||'Could not create the account.',false);btn.disabled=false;return;}
    var lr=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email,password:p1})});
    if(lr.ok){set('Done! Loading EufyView…',true);location.href='/';}
    else{set('Account created. Please sign in.',true);location.href='/auth/login';}
  }catch(err){set('Could not reach the server.',false);btn.disabled=false;}
});
</script></body></html>`;
}

const EXEMPT = new Set([
    '/auth/login', '/auth/claim', '/auth/logout', '/health', '/status',
    '/auth/pair-code/redeem', '/auth/pair-code/local',
    '/devices/scan', '/devices/install', '/devices/uninstall', '/devices/status', '/devices/env', '/setup/set-password',
    // Update endpoints: reachable from the server machine itself (tray, loopback)
    // which has no session. The handlers enforce loopback-or-admin themselves.
    '/updates/check', '/updates/apply', '/updates/apply/status',
]);

const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

// Mounts /auth/* routes and a gate middleware. Call AFTER express.json() and
// BEFORE any other routes so unauthenticated requests are intercepted.
function installAuth(app) {
    const cfg = loadConfig();
    if (!cfg && isConfigCorrupt()) {
        // auth.json exists but is corrupt/unreadable. Fail CLOSED - refuse every
        // request rather than booting with no authentication (which a silent
        // parse failure, e.g. the historical BOM bug, would otherwise cause).
        console.error('[auth] auth.json is present but UNREADABLE/corrupt - failing closed (all requests blocked until fixed).');
        app.use((_req, res) => res.status(503).json({ error: 'authentication unavailable - server misconfigured' }));
        return { enabled: false, corrupt: true };
    }
    if (!cfg || !cfg.enabled) {
        console.log('[auth] DISABLED (no auth.json or enabled:false) - running WITHOUT authentication');
        return { enabled: false };
    }

    // Login page (GET) and credential endpoints (POST) - reachable unauthed
    // because they're registered before the gate middleware.
    // Serve the Initial Setup page until an administrator exists, then the login
    // page. Checked dynamically so it switches the moment the admin is created.
    app.get('/auth/login', (_req, res) => {
        if (authMode(loadConfig()) === 'setup') return res.send(setupPage());
        res.send(loginPage());
    });

    app.post('/auth/login', async (req, res) => {
        const ip = req.socket.remoteAddress || '';
        const { email, password } = req.body || {};
        const r = authenticate(email, password, ip);
        if (r.ok) {
            res.setHeader('Set-Cookie', cookieStr(COOKIE, makeToken(r.email, cfg.sessionSecret), MAX_AGE_MS / 1000));
            return res.json({ ok: true });
        }
        if (r.error === 'locked') return res.status(429).json({ error: 'locked', retryAfterSec: r.retryAfterSec });
        await new Promise((s) => setTimeout(s, 400));   // slow automated guessing
        return res.status(401).json({ error: 'invalid' });
    });

    app.post('/auth/claim', async (req, res) => {
        const ip = req.socket.remoteAddress || '';
        const { email, code, password } = req.body || {};
        const r = claimAccount(email, code, password, ip);
        if (r.ok) {
            res.setHeader('Set-Cookie', cookieStr(COOKIE, makeToken(r.email, cfg.sessionSecret), MAX_AGE_MS / 1000));
            return res.json({ ok: true });
        }
        if (r.error === 'locked') return res.status(429).json({ error: 'locked', retryAfterSec: r.retryAfterSec });
        if (r.error === 'weak') return res.status(400).json({ error: 'weak' });
        await new Promise((s) => setTimeout(s, 400));
        return res.status(401).json({ error: 'invalid' });
    });

    app.get('/auth/logout', (_req, res) => {
        res.setHeader('Set-Cookie', cookieStr(COOKIE, '', 0));
        res.redirect('/auth/login');
    });

    // Redeem a pairing code for a device token (the code IS the credential).
    app.post('/auth/pair-code/redeem', (req, res) => {
        const r = redeemPairCode(req.body && req.body.code);
        if (r.error === 'rate_limited') return res.status(429).json({ error: 'too many attempts; wait a minute' });
        if (r.error) return res.status(400).json({ error: 'invalid or expired code' });
        res.json({ token: r.token, email: r.email, baseUrl: cfg.baseUrl });
    });

    // Create a pairing code from the server machine itself (tray). Localhost
    // only; bound to the admin account.
    app.get('/auth/pair-code/local', (req, res) => {
        if (!isLoopback(req.socket.remoteAddress || '')) return res.status(403).json({ error: 'localhost only' });
        const email = cfg.admin && cfg.admin.email;
        if (!email) return res.status(400).json({ error: 'no admin account configured' });
        res.json(makePairCode(email));
    });

    // The gate: everything else needs a valid session cookie or device token.
    app.use((req, res, next) => {
        if (EXEMPT.has(req.path)) return next();
        if (req.method === 'GET' && /^\/push\/thumb\/[0-9a-f]{32}\.jpg$/.test(req.path)) return next();
        if (verifyToken(parseCookies(req.headers.cookie)[COOKIE], cfg.sessionSecret)) return next();
        const bearer = tokenFromReq(req);
        if (bearer && verifyToken(bearer, cfg.sessionSecret)) return next();
        const accept = req.headers.accept || '';
        if (req.method === 'GET' && accept.includes('text/html')) return res.redirect('/auth/login');
        return res.status(401).json({ error: 'unauthorized' });
    });

    // Mint a device token for pairing a TV/appliance. Requires a browser session
    // (a device token can't mint more tokens).
    app.get('/auth/device-token', (req, res) => {
        const email = getSessionEmail(req.headers.cookie);
        if (!email) return res.status(401).json({ error: 'sign in in a browser first' });
        res.json({ token: makeDeviceToken(email, cfg.sessionSecret), email, baseUrl: cfg.baseUrl });
    });

    app.post('/auth/pair-code/new', (req, res) => {
        const email = getSessionEmail(req.headers.cookie);
        if (!email) return res.status(401).json({ error: 'sign in in a browser first' });
        res.json(makePairCode(email));
    });

    const mode = authMode(cfg);
    if (mode === 'password') console.log('[auth] password gate ENABLED (admin: ' + cfg.admin.email + ', users: ' + (cfg.users || []).length + ')');
    else console.log('[auth] SETUP REQUIRED - no administrator configured; set one from the server (tray) or installer before remote access.');
    return { enabled: true };
}

module.exports = {
    installAuth,
    isAuthedCookieHeader,
    isAuthedRequest,
    scopeForRequest,
    scopeForCookieHeader,
    getScopeForEmail,
    getSessionEmail,
    isEmailAllowed,
    isCameraAllowed,
    makeDeviceToken,
    tokenFromReq,
    getPublicBaseUrl,
    mintDeviceTokenForAdmin,
    // passwords / admin / users
    hashPassword,
    verifyPassword,
    authMode,
    authStatus,
    setAdmin,
    setPassword: setAdmin,          // back-compat: tray / /setup/set-password
    updateAdminAccount,
    authenticate,
    claimAccount,
    addUser,
    upsertUser,
    updateUserAccess,
    resetUserPassword,
    regenClaim,
    removeUser,
    listAccess,
};
