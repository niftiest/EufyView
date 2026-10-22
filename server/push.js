/**
 * Web Push Module
 *
 * Sends background push notifications to subscribed PWA clients via the browser
 * push services (FCM / Apple / Mozilla), so detection alerts arrive even when
 * the app is closed. The server makes outbound HTTPS requests to those services,
 * so this works from a home PC behind NAT — no inbound ports required.
 *
 * Every choice about WHAT to receive (cameras, alert types, mutes, thumbnail
 * style) is stored per subscription, i.e. per person/phone — never on the Eufy
 * device, whose notification switches would affect the whole family.
 *
 * VAPID keys and client subscriptions are persisted to disk under the data dir.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const webpush = require('web-push');

const utils = require('./utils');
const auth = require('./auth');

const VAPID_FILE = path.join(utils.dataDir, 'vapid.json');
const SUBS_FILE = path.join(utils.dataDir, 'push-subscriptions.json');

// Per-(camera, event) throttle so a busy camera can't flood the OS with pushes
const COOLDOWN_MS = 30000;

let vapidKeys = null;
let subscriptions = {};   // endpoint -> { subscription, prefs, mutes, types, style, email }
let cooldowns = {};       // `${serial}:${event}` -> last-sent timestamp

/**
 * Initialize Push
 * Loads or generates VAPID keys and loads persisted subscriptions.
 */
function initPush() {
    // Load or generate VAPID keys
    try {
        if (fs.existsSync(VAPID_FILE)) {
            vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
        }
    } catch (e) {
        utils.log(`⚠️ Failed to load VAPID keys: ${e.message}`, 'warn');
    }

    if (!vapidKeys || !vapidKeys.publicKey || !vapidKeys.privateKey) {
        vapidKeys = webpush.generateVAPIDKeys();
        try {
            fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2), 'utf8');
            utils.log('🔑 Generated new VAPID keypair for Web Push', 'info');
        } catch (e) {
            utils.log(`❌ Failed to save VAPID keys: ${e.message}`, 'error');
        }
    }

    webpush.setVapidDetails('mailto:eufyview@localhost', vapidKeys.publicKey, vapidKeys.privateKey);

    // Load persisted subscriptions
    try {
        if (fs.existsSync(SUBS_FILE)) {
            subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')) || {};
        }
    } catch (e) {
        utils.log(`⚠️ Failed to load push subscriptions: ${e.message}`, 'warn');
        subscriptions = {};
    }

    utils.log(`🔔 Push initialized (${Object.keys(subscriptions).length} subscription(s))`, 'info');
}

/**
 * Get VAPID Public Key
 * @returns {string|null} The public key clients use to subscribe
 */
function getPublicKey() {
    return vapidKeys ? vapidKeys.publicKey : null;
}

function saveSubs() {
    try {
        fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2), 'utf8');
    } catch (e) {
        utils.log(`❌ Failed to save push subscriptions: ${e.message}`, 'error');
    }
}

// ---- Per-user alert types ----
// Detection events are grouped into the categories a user can switch off per
// camera (Settings → Per-camera alerts). Unknown events count as "motion".
const EVENT_CATEGORIES = {
    'ring': 'ring',
    'person detected': 'person',
    'stranger detected': 'person',
    'familiar face': 'person',
    'someone loitering': 'person',
    'pet detected': 'pet',
    'dog detected': 'pet',
    'dog lick detected': 'pet',
    'dog poop detected': 'pet',
    'vehicle detected': 'vehicle',
    'crying detected': 'sound',
    'sound detected': 'sound',
    'package delivered': 'package',
    'package taken': 'package',
};

function categoryOf(event) {
    return EVENT_CATEGORIES[event] || 'motion';
}

// ---- Notification style (per subscription) ----
// Mirrors the official app's options:
//   text  — "Most Efficiency": text only, no delay
//   full  — "Full Effect": text immediately, then silently updated with the
//           event thumbnail once the camera's picture arrives
//   thumb — "Include Thumbnail": wait (up to THUMB_WAIT_MS) for the thumbnail
//           and send a single alert with it; falls back to text
const STYLES = ['text', 'full', 'thumb'];
const DEFAULT_STYLE = 'full';
const THUMB_WAIT_MS = 15000;       // 'thumb' style: max wait before sending text anyway
const THUMB_WINDOW_MS = 60000;     // accept a picture up to this long after the alert
const THUMB_TTL_MS = 30 * 60000;   // how long a thumbnail URL stays fetchable

let pending = {};   // serial -> { base, at, full: [endpoint], waiting: [endpoint], timer }
let thumbs = {};    // token -> { buf, mime, expires }

function sanitizeStyle(style) {
    return STYLES.includes(style) ? style : undefined;
}

// { [serial]: { [category]: bool } } — keep only booleans
function sanitizeTypes(types) {
    if (!types || typeof types !== 'object') return undefined;
    const out = {};
    for (const [sn, cats] of Object.entries(types)) {
        if (!cats || typeof cats !== 'object') continue;
        out[sn] = {};
        for (const [cat, on] of Object.entries(cats)) {
            if (typeof on === 'boolean') out[sn][cat] = on;
        }
    }
    return out;
}

/**
 * Add / Update Subscription
 * @param {Object} subscription - Browser PushSubscription JSON
 * @param {Object} opts
 * @param {Object} opts.prefs - Per-camera notification prefs ({ [serial]: bool })
 * @param {Object} opts.mutes - Per-camera temporary mute expiries ({ [serial]: epochMs })
 * @param {Object} opts.types - Per-camera alert-type prefs ({ [serial]: { [category]: bool } })
 * @param {string} opts.style - Notification style ('text' | 'full' | 'thumb')
 * @param {string} opts.email - Signed-in user (camera scoping)
 * @param {string} opts.oldEndpoint - Rotated-away endpoint whose settings carry over
 * @returns {boolean} success
 */
function addSubscription(subscription, opts = {}) {
    if (!subscription || !subscription.endpoint) return false;
    const endpoint = subscription.endpoint;
    // The service worker re-subscribes on rotation without access to the page's
    // settings; carry them over from the old (or existing) entry instead of
    // resetting this person's choices.
    const prev = subscriptions[endpoint] || (opts.oldEndpoint && subscriptions[opts.oldEndpoint]) || {};
    subscriptions[endpoint] = {
        subscription,
        prefs: opts.prefs || prev.prefs || {},
        mutes: opts.mutes || prev.mutes || {},
        types: sanitizeTypes(opts.types) || prev.types || {},
        style: sanitizeStyle(opts.style) || prev.style || DEFAULT_STYLE,
        email: opts.email || prev.email || null
    };
    if (opts.oldEndpoint && opts.oldEndpoint !== endpoint) delete subscriptions[opts.oldEndpoint];
    saveSubs();
    utils.log(`🔔 Push subscription added (${Object.keys(subscriptions).length} total)`, 'info');
    return true;
}

/**
 * Update Preferences for an existing subscription
 * @param {string} endpoint - Subscription endpoint
 * @param {Object} opts - Any of { prefs, mutes, types, style, email } (see addSubscription)
 */
function updatePrefs(endpoint, opts = {}) {
    const entry = subscriptions[endpoint];
    if (!entry) return false;
    if (opts.prefs !== undefined) entry.prefs = opts.prefs || {};
    if (opts.mutes !== undefined) entry.mutes = opts.mutes || {};
    if (opts.types !== undefined) entry.types = sanitizeTypes(opts.types) || {};
    if (sanitizeStyle(opts.style)) entry.style = opts.style;
    if (opts.email) entry.email = opts.email;
    saveSubs();
    return true;
}

/**
 * Remove Subscription
 * @param {string} endpoint - Subscription endpoint
 */
function removeSubscription(endpoint) {
    if (subscriptions[endpoint]) {
        delete subscriptions[endpoint];
        saveSubs();
        utils.log(`🔔 Push subscription removed (${Object.keys(subscriptions).length} total)`, 'info');
        return true;
    }
    return false;
}

// Does this subscription want this alert? (camera scope, on/off, mute, type)
function wants(entry, serialNumber, event, now) {
    // Camera scoping: a scoped user must not receive alerts for cameras
    // they aren't granted. (No email = legacy/auth-disabled = unrestricted.)
    if (entry.email) {
        const scope = auth.getScopeForEmail(entry.email);
        if (!auth.isCameraAllowed(scope, serialNumber)) return false;
    }
    // Respect per-camera preference (default enabled when unspecified)
    if (entry.prefs && entry.prefs[serialNumber] === false) return false;
    // Respect a temporary mute that hasn't expired yet
    if (entry.mutes && entry.mutes[serialNumber] && now < entry.mutes[serialNumber]) return false;
    // Respect per-camera alert types (default enabled when unspecified)
    const types = entry.types && entry.types[serialNumber];
    if (types && types[categoryOf(event)] === false) return false;
    return true;
}

// Send one payload to one endpoint; prunes dead endpoints.
async function sendTo(endpoint, data) {
    const entry = subscriptions[endpoint];
    // A concurrent notify() call (e.g. Person + Motion firing together)
    // may have already pruned this endpoint (410).
    if (!entry) return;
    try {
        // urgency:high → Android/FCM delivers immediately even in doze (a
        // detection alert is time-critical). TTL caps how long it's queued.
        const r = await webpush.sendNotification(entry.subscription, JSON.stringify(data), { urgency: 'high', TTL: 600 });
        utils.log(`🔔 push sent (${r.statusCode}${data.image ? ', thumbnail' : ''}) → ${(entry.email || 'no-email')} ${endpoint.slice(-10)}`, 'info');
    } catch (err) {
        const code = err.statusCode;
        if (code === 404 || code === 410) {
            delete subscriptions[endpoint];
            saveSubs();
            utils.log(`🔔 Pruned expired push subscription (${code}) ${endpoint.slice(-10)}`, 'info');
        } else {
            utils.log(`❌ Push send error (${code}): ${err.message}`, 'warn');
        }
    }
}

function sendAll(endpoints, data) {
    return Promise.all(endpoints.map(ep => sendTo(ep, data)));
}

// 'thumb'-style recipients still waiting on a picture get the text alert now.
function flushPending(serialNumber) {
    const p = pending[serialNumber];
    if (!p) return;
    clearTimeout(p.timer);
    if (p.waiting.length) {
        sendAll(p.waiting, p.base);
        p.full.push(...p.waiting);   // a late picture can still update it
        p.waiting = [];
    }
}

/**
 * Notify
 * Sends a detection notification to every subscription that wants it,
 * throttled per camera+event. Subscriptions using a thumbnail style are
 * remembered so attachThumbnail() can follow up with the event picture.
 * @param {Object} info - { serialNumber, cameraName, event, label }
 */
async function notify({ serialNumber, cameraName, event, label }) {
    const endpoints = Object.keys(subscriptions);
    if (endpoints.length === 0) return;

    // Throttle repeated events from the same camera
    const key = `${serialNumber}:${event}`;
    const now = Date.now();
    if (cooldowns[key] && now - cooldowns[key] < COOLDOWN_MS) {
        utils.log(`🔔 notify SKIPPED (cooldown) ${label || event} on ${cameraName || serialNumber}`, 'debug');
        return;
    }
    cooldowns[key] = now;

    const recipients = endpoints.filter(ep => wants(subscriptions[ep], serialNumber, event, now));
    utils.log(`🔔 notify ${label || event} on ${cameraName || serialNumber} → ${recipients.length}/${endpoints.length} sub(s)`, 'info');
    if (recipients.length === 0) return;

    const base = {
        title: label || event,
        body: cameraName || `Camera ${serialNumber}`,
        tag: key,
        event,
        serialNumber
    };
    const styleOf = ep => subscriptions[ep].style || DEFAULT_STYLE;
    const textNow = recipients.filter(ep => styleOf(ep) !== 'thumb');
    const waiting = recipients.filter(ep => styleOf(ep) === 'thumb');
    const full = textNow.filter(ep => styleOf(ep) === 'full');

    // A newer alert takes over the camera's pending thumbnail slot
    flushPending(serialNumber);
    delete pending[serialNumber];
    if (full.length || waiting.length) {
        pending[serialNumber] = {
            base, at: now, full, waiting,
            timer: waiting.length ? setTimeout(() => flushPending(serialNumber), THUMB_WAIT_MS) : null
        };
    }

    await sendAll(textNow, base);
}

/**
 * Attach Thumbnail
 * Called when a camera's event picture arrives. If an alert for that camera is
 * waiting on it, publish the image under an unguessable short-lived URL and
 * send it to the subscriptions that want thumbnails.
 * @param {string} serialNumber
 * @param {Buffer} buf - Image data
 * @param {string} mime
 * @returns {boolean} whether a thumbnail push was sent
 */
function attachThumbnail(serialNumber, buf, mime) {
    const p = pending[serialNumber];
    const now = Date.now();
    if (!p || now - p.at > THUMB_WINDOW_MS || !buf || !buf.length) return false;
    clearTimeout(p.timer);
    delete pending[serialNumber];

    for (const t of Object.keys(thumbs)) {
        if (thumbs[t].expires < now) delete thumbs[t];
    }
    const token = crypto.randomBytes(16).toString('hex');
    thumbs[token] = { buf, mime: mime || 'image/jpeg', expires: now + THUMB_TTL_MS };
    const image = `/push/thumb/${token}.jpg`;

    utils.log(`🖼️ Thumbnail for "${p.base.title}" on ${p.base.body} after ${Math.round((now - p.at) / 1000)}s`, 'info');
    // 'thumb' style: this IS the alert. 'full' style: quietly replaces the text one.
    sendAll(p.waiting, { ...p.base, image });
    sendAll(p.full, { ...p.base, image, update: true });
    return true;
}

/**
 * Get Thumbnail
 * @param {string} token
 * @returns {{buf: Buffer, mime: string}|null}
 */
function getThumbnail(token) {
    const t = thumbs[token];
    if (!t || t.expires < Date.now()) return null;
    return t;
}

module.exports = {
    initPush,
    getPublicKey,
    addSubscription,
    updatePrefs,
    removeSubscription,
    notify,
    attachThumbnail,
    getThumbnail,
    get subscriptionCount() { return Object.keys(subscriptions).length; }
};
