/**
 * Event Log Module
 *
 * EufyView's own detection history. Every detection the server receives (the
 * HomeBase P2P feed, library events, cloud-poll fallback - all funnelled through
 * eufy-client's notifyDetection) is saved here with its type, camera and time,
 * plus the event snapshot once the camera's picture arrives.
 *
 * This exists because the HomeBase S380 (HomeBase 3) doesn't expose its
 * recording list to eufy-security-client (station queries return nothing
 * useful and the cloud event index is empty), so the official app's clip list
 * can't be reproduced. Detections + snapshots we can capture reliably.
 *
 * Storage: data/events.json (index) + data/event-snaps/<id>.jpg (snapshots).
 * Retention: RETENTION_DAYS, capped at MAX_EVENTS.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const utils = require('./utils');
const auth = require('./auth');

const INDEX_FILE = path.join(utils.dataDir, 'events.json');
const SNAP_DIR = path.join(utils.dataDir, 'event-snaps');
const RETENTION_DAYS = 90;
const MAX_EVENTS = 5000;
const SNAPSHOT_WINDOW_MS = 120000;     // a picture arriving this soon after an event belongs to it
const SAVE_DEBOUNCE_MS = 2000;

let events = [];                       // newest first: { id, serialNumber, cameraName, event, label, time, snap }
let saveTimer = null;

function init() {
    try { fs.mkdirSync(SNAP_DIR, { recursive: true }); } catch (e) { /* exists */ }
    try {
        if (fs.existsSync(INDEX_FILE)) events = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) || [];
    } catch (e) {
        utils.log(`⚠️ Failed to load event log: ${e.message}`, 'warn');
        events = [];
    }
    prune();
    utils.log(`📒 Event log loaded (${events.length} events)`, 'info');
}

function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(INDEX_FILE, JSON.stringify(events), 'utf8');
        } catch (e) {
            utils.log(`❌ Failed to save event log: ${e.message}`, 'error');
        }
    }, SAVE_DEBOUNCE_MS);
}

function snapPath(id) {
    return path.join(SNAP_DIR, `${id}.jpg`);
}

// Drop events past retention / over the cap, and their snapshots
function prune() {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    const keep = [];
    for (const ev of events) {
        if (ev.time >= cutoff && keep.length < MAX_EVENTS) keep.push(ev);
        else if (ev.snap) { try { fs.unlinkSync(snapPath(ev.id)); } catch (e) {} }
    }
    if (keep.length !== events.length) { events = keep; save(); }
}

/**
 * Record a detection
 * @param {Object} ev - { serialNumber, cameraName, event, label }
 * @returns {string} event id
 */
function record({ serialNumber, cameraName, event, label }) {
    const time = Date.now();
    const id = `${String(serialNumber).replace(/[^A-Za-z0-9]/g, '')}_${time}_${crypto.randomBytes(2).toString('hex')}`;
    events.unshift({ id, serialNumber, cameraName, event, label, time, snap: false });
    if (events.length > MAX_EVENTS + 100) prune();
    save();
    return id;
}

/**
 * Attach a snapshot to the camera's latest event that doesn't have one yet,
 * if that event is recent enough for the picture to belong to it.
 * @returns {boolean} attached
 */
function attachSnapshot(serialNumber, buf) {
    if (!buf || !buf.length) return false;
    const now = Date.now();
    const ev = events.find(e => e.serialNumber === serialNumber);
    if (!ev || ev.snap || now - ev.time > SNAPSHOT_WINDOW_MS) return false;
    try {
        fs.writeFileSync(snapPath(ev.id), buf);
        ev.snap = true;
        save();
        return true;
    } catch (e) {
        utils.log(`❌ Failed to save event snapshot: ${e.message}`, 'warn');
        return false;
    }
}

/**
 * Events in [start, end) visible to this viewer
 * @param {Object} scope - viewer's camera scope (null = unrestricted)
 * @param {Object} opts - { serialNumber?, start (ms), end (ms) }
 */
function list(scope, { serialNumber, start, end }) {
    return events.filter(e =>
        e.time >= start && e.time < end &&
        (!serialNumber || e.serialNumber === serialNumber) &&
        (!scope || auth.isCameraAllowed(scope, e.serialNumber)));
}

function isValidId(id) {
    return /^[A-Za-z0-9]+_[0-9]+_[0-9a-f]{4}$/.test(String(id));
}

function serialFromId(id) {
    return String(id).split('_')[0];
}

function getSnapshotFile(id) {
    if (!isValidId(id)) return null;
    const p = snapPath(id);
    return fs.existsSync(p) ? p : null;
}

// Flush pending writes (process exit)
function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    try { fs.writeFileSync(INDEX_FILE, JSON.stringify(events), 'utf8'); } catch (e) {}
}

module.exports = {
    init,
    record,
    attachSnapshot,
    list,
    isValidId,
    serialFromId,
    getSnapshotFile,
    flush
};
