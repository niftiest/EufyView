/**
 * Utility Module
 * 
 * Provides shared utility functions for:
 * - Configuration management (load/save)
 * - Logging with severity levels
 * - Active stream client tracking
 * - Snapshot and picture hash persistence
 * - File system operations
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Development mode flag (enables additional debug features)
const isDev = process.env.NODE_ENV === 'development' || process.env.DEV === 'true';

// Directory for persistent data (config, snapshots, hashes)
const DATA_DIR = process.env.DATA_DIR || path.join(require.main.path, 'data');
const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PICTURE_HASH_FILE = path.join(DATA_DIR, 'picture-hashes.json');
// Logging level: 0=error, 1=warn, 2=info, 3=debug
const LOGGINGLEVEL = process.env.LOGGINGLEVEL || '2';

// --- Persistent file logging -------------------------------------------------
// Everything that passes the level filter in log() is also appended to a
// rotating file under data/logs/, so there is a durable record to check against
// (the tray launches the server without capturing its console output).
const LOG_DIR = process.env.LOG_DIR || path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'eufyview.log');
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES) || 5 * 1024 * 1024;  // rotate at 5 MB
const LOG_KEEP = Number(process.env.LOG_KEEP) || 5;                          // keep 5 rotated files
let logStream = null;
let logBytes = 0;

function openLogStream() {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        logBytes = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
        logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
        logStream.on('error', () => { logStream = null; });   // disk full / locked → drop to console only
    } catch (e) {
        logStream = null;
    }
}

function rotateLogs() {
    try {
        if (logStream) { logStream.end(); logStream = null; }
        const oldest = path.join(LOG_DIR, `eufyview.${LOG_KEEP}.log`);
        if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
        for (let i = LOG_KEEP - 1; i >= 1; i--) {
            const src = path.join(LOG_DIR, `eufyview.${i}.log`);
            if (fs.existsSync(src)) fs.renameSync(src, path.join(LOG_DIR, `eufyview.${i + 1}.log`));
        }
        if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, path.join(LOG_DIR, 'eufyview.1.log'));
    } catch (e) { /* best-effort rotation */ }
    openLogStream();
}

function writeToLogFile(line) {
    try {
        if (!logStream) openLogStream();
        if (!logStream) return;
        const buf = line + '\n';
        logStream.write(buf);
        logBytes += Buffer.byteLength(buf);
        if (logBytes >= LOG_MAX_BYTES) rotateLogs();
    } catch (e) { /* logging must never throw */ }
}

// Capture otherwise-silent crashes/hangs. We log and keep the process alive
// (the tray does not auto-restart), favoring availability over fast failure.
if (!global.__eufyviewErrorHandlers) {
    global.__eufyviewErrorHandlers = true;
    process.on('uncaughtException', (err) => {
        log(`💥 Uncaught exception: ${err && err.stack ? err.stack : err}`, 'error');
    });
    process.on('unhandledRejection', (reason) => {
        log(`💥 Unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`, 'error');
    });
}

/**
 * Default Configuration
 * Can be overridden by config.json or environment variables
 */
const DEFAULT_CONFIG = {
    EUFY_CONFIG: {
        username: '',              // Eufy account username/email
        password: '',              // Eufy account password
        persistentDir: DATA_DIR,   // Directory for Eufy client persistent data
        country: 'US',             // Country code for Eufy API
        language: 'en',            // Language for Eufy API responses
        enableEmbeddedPKCS1Support: true  // Required for Node 22+ (pure JS RSA fallback)
    },
    TRANSCODING_PRESET: process.env.TRANSCODING_PRESET || 'ultrafast',  // FFmpeg encoding speed
    TRANSCODING_CRF: process.env.TRANSCODING_CRF || '23',              // Constant Rate Factor (quality)
    VIDEO_SCALE: process.env.VIDEO_SCALE || '1280:-2',                // Video resolution scaling
    FFMPEG_THREADS: process.env.FFMPEG_THREADS || '4',                // Number of encoding threads
    FFMPEG_SHORT_KEYFRAMES: process.env.FFMPEG_SHORT_KEYFRAMES === 'true' || false,  // Use shorter GOP

    // Data Saver "frame view" - serves discrete JPEG frames instead of an fMP4
    // stream, so the traffic looks like image loads (not media streaming) and
    // uses far less bandwidth. Useful on restricted/metered WiFi (e.g. cruise/airline).
    FRAME_FPS: process.env.FRAME_FPS || '2',          // Frames per second for frame view
    FRAME_SCALE: process.env.FRAME_SCALE || '640:-2', // Frame resolution (width:height, -2 = keep aspect)
    FRAME_QUALITY: process.env.FRAME_QUALITY || '7',  // MJPEG quality (2=best/large .. 31=worst/small)
};

// Set of currently active streaming HTTP clients
let activeStreamClients = new Set();

log('🔧 Utils module initialized', 'debug');
log(`🔧 Development mode: ${isDev}`, 'info');
log(`📝 Logging to ${LOG_FILE} (level ${LOGGINGLEVEL}, rotate ${Math.round(LOG_MAX_BYTES / 1048576)}MB x${LOG_KEEP})`, 'info');

// Ensure data directory exists on module load
checkDataDir();

/**
 * Ensure Data Directory Exists
 * Creates the data directory if it doesn't exist
 */
function checkDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        log(`📁 Created directory: ${DATA_DIR}`, 'debug');
    }
}

/**
 * Load Configuration
 * Loads configuration from config.json if exists, otherwise returns defaults
 * @returns {Object} Merged configuration (defaults + saved values)
 */
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            log(`📋 Configuration loaded from ${CONFIG_FILE}`, 'info');
            return { ...DEFAULT_CONFIG, ...savedConfig };
        }
    } catch (err) {
        log(`⚠️ Failed to load config from ${CONFIG_FILE}: ${err.message}`, 'warn');
    }
    return { ...DEFAULT_CONFIG };
}

/**
 * Save Configuration
 * Persists configuration to config.json file
 * @param {Object} config - Configuration object to save
 * @returns {boolean} True if save was successful
 */
function saveConfig(config) {
    try {
        checkDataDir();
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
        log(`💾 Configuration saved to ${CONFIG_FILE}`, 'debug');
        return true;
    } catch (err) {
        log(`❌ Failed to save config to ${CONFIG_FILE}: ${err.message}`, 'error');
        return false;
    }
}

/**
 * Load Snapshot From Disk
 * Retrieves a saved device snapshot image from disk
 * @param {string} deviceSN - Device serial number
 * @returns {Buffer|null} Image buffer or null if not found
 */
// Snapshots are saved in two sizes: a large master `<sn>.jpg` (for the TV
// dashboard hero/cards) and a small `<sn>.sm.jpg` (for the PWA grid + the
// pushed `picture` property). opts.small prefers the derivative, falling back
// to the master if the small one isn't there yet (e.g. pre-upgrade files).
function loadSnapshotFromDisk(deviceSN, opts = {}) {
    const names = opts.small
        ? [`${deviceSN}.sm.jpg`, `${deviceSN}.jpg`]
        : [`${deviceSN}.jpg`];
    for (const name of names) {
        const snapshotPath = path.join(SNAPSHOT_DIR, name);
        try {
            if (fs.existsSync(snapshotPath)) {
                const buffer = fs.readFileSync(snapshotPath);
                log(`✅ Snapshot loaded from disk: ${snapshotPath} (${buffer.length} bytes)`, 'debug');
                return buffer;
            }
        } catch (err) {
            log(`❌ Snapshot load error: ${err}`, 'error');
            console.error(err);
            return null;
        }
    }
    return null;
}

/**
 * Add Active Stream Client
 * Registers a new HTTP client connection for stream tracking
 * @param {Object} client - Client object containing response stream and metadata
 */
function addActiveStreamClient(client) {
    activeStreamClients.add(client);
}

/**
 * Remove Active Stream Client
 * Unregisters a disconnected HTTP client
 * @param {Object} client - Client object to remove
 */
function removeActiveStreamClient(client) {
    activeStreamClients.delete(client);
}

/**
 * Get Active Stream Clients
 * @returns {Set} Set of currently active streaming clients
 */
function getActiveStreamClients() {
    return activeStreamClients;
}

/**
 * Clear Active Stream Clients
 * Removes all active clients (used during shutdown)
 */
function clearActiveStreamClients() {
    activeStreamClients.clear();
}

/**
 * Central Logging Function
 * Provides severity-based logging with configurable levels
 * @param {string} message - Log message to output
 * @param {string} severity - Log level: 'error', 'warn', 'info', 'debug'
 */
function log(message, severity = 'info') {
    const levels = ['error', 'warn', 'info', 'debug', 'trace'];
    const msgLevel = levels.indexOf(severity);
    if (msgLevel === -1) return;
    if (LOGGINGLEVEL < 0) LOGGINGLEVEL = 0;
    // Only log if message severity is at or below configured level
    if (msgLevel > LOGGINGLEVEL) return;

    const prefix = {
        trace: '[TRACE]',
        debug: '[DEBUG]',
        info: '[INFO]',
        warn: '[WARN]',
        error: '[ERROR]',
    }[severity] || '';

    // Persist to the rotating log file (timestamped), then to the console
    writeToLogFile(`${new Date().toISOString()} ${prefix} ${message}`);

    // Route to appropriate console method based on severity
    if (severity === 'error') {
        console.error(`${prefix} ${message}`);
    } else if (severity === 'warn') {
        console.warn(`${prefix} ${message}`);
    } else {
        console.log(`${prefix} ${message}`);
    }
}

/**
 * Generate Checksum
 * Creates MD5 hash of data for change detection
 * @param {Buffer|string} data - Data to hash
 * @returns {string} MD5 hash in hexadecimal format
 */
function generateChecksum(data) {
    return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Save Picture Hash
 * Stores MD5 hash of a device snapshot for change detection
 * Preserves existing fields like snapshotDatetime
 * @param {string} deviceSN - Device serial number
 * @param {string} hash - MD5 hash of the picture
 */
function savePictureHash(deviceSN, hash) {
    let hashes = {};

    // Load existing hashes from disk
    try {
        if (fs.existsSync(PICTURE_HASH_FILE)) {
            hashes = JSON.parse(fs.readFileSync(PICTURE_HASH_FILE, 'utf8'));
        }
    } catch (err) {
        log(`⚠️ Failed to load picture hashes: ${err.message}`, 'warn');
    }

    // Update hash for this device while preserving other fields
    hashes[deviceSN] = {
        ...hashes[deviceSN],  // Preserve existing fields (e.g., snapshotDatetime)
        hash: hash,
        datetime: new Date().toISOString()
    };

    // Persist updated hashes to disk
    try {
        fs.writeFileSync(PICTURE_HASH_FILE, JSON.stringify(hashes, null, 2), 'utf8');
        log(`💾 Picture hash saved for device ${deviceSN}`, 'debug');
    } catch (err) {
        log(`❌ Failed to save picture hash: ${err.message}`, 'error');
    }

    return {
        hash: hashes[deviceSN].hash,
        datetime: hashes[deviceSN].datetime
    };
}

/**
 * Load Picture Hash
 * Retrieves stored MD5 hash and timestamp for a device snapshot
 * @param {string} deviceSN - Device serial number
 * @returns {Object|null} Object with hash and datetime, or null if not found
 */
function loadPictureHash(deviceSN) {
    try {
        if (fs.existsSync(PICTURE_HASH_FILE)) {
            const hashes = JSON.parse(fs.readFileSync(PICTURE_HASH_FILE, 'utf8'));
            if (hashes[deviceSN]) {
                return {
                    hash: hashes[deviceSN].hash,
                    datetime: hashes[deviceSN].datetime
                };
            }
        }
    } catch (err) {
        log(`❌ Failed to load picture hash: ${err.message}`, 'error');
    }

    return null;
}

/**
 * Save Snapshot Datetime
 * Records the timestamp when a snapshot was taken
 * Preserves existing hash and datetime fields
 * @param {string} deviceSN - Device serial number
 */
function saveSnapshotDatetime(deviceSN) {
    let hashes = {};

    // Load existing hashes from disk
    try {
        if (fs.existsSync(PICTURE_HASH_FILE)) {
            hashes = JSON.parse(fs.readFileSync(PICTURE_HASH_FILE, 'utf8'));
        }
    } catch (err) {
        log(`⚠️ Failed to load picture hashes: ${err.message}`, 'warn');
    }

    // Update snapshotDatetime while preserving other fields
    hashes[deviceSN] = {
        ...hashes[deviceSN],  // Preserve existing fields (e.g., hash, datetime)
        snapshotDatetime: new Date().toISOString()
    };

    // Persist updated data to disk
    try {
        fs.writeFileSync(PICTURE_HASH_FILE, JSON.stringify(hashes, null, 2), 'utf8');
        log(`💾 Snapshot datetime saved for device ${deviceSN}`, 'debug');
    } catch (err) {
        log(`❌ Failed to save snapshot datetime: ${err.message}`, 'error');
    }
}

/**
 * Load Snapshot Datetime
 * Retrieves the timestamp of when a snapshot was taken
 * @param {string} deviceSN - Device serial number
 * @returns {string|null} ISO datetime string or null if not found
 */
function loadSnapshotDatetime(deviceSN) {
    try {
        if (fs.existsSync(PICTURE_HASH_FILE)) {
            const hashes = JSON.parse(fs.readFileSync(PICTURE_HASH_FILE, 'utf8'));
            if (hashes[deviceSN] && hashes[deviceSN].snapshotDatetime) {
                return hashes[deviceSN].snapshotDatetime;
            }
        }
    } catch (err) {
        log(`❌ Failed to load snapshot datetime: ${err.message}`, 'error');
    }

    return null;
}

/**
 * Module Exports
 * Exposes utility functions and read-only properties
 */
module.exports = {
    // Configuration management
    loadConfig,
    saveConfig,

    // Snapshot and hash management
    loadSnapshotFromDisk,
    generateChecksum,
    savePictureHash,
    loadPictureHash,
    saveSnapshotDatetime,
    loadSnapshotDatetime,

    // Stream client tracking
    addActiveStreamClient,
    removeActiveStreamClient,
    clearActiveStreamClients,
    getActiveStreamClients,

    // Read-only properties
    get isDev() { return isDev; },
    get dataDir() { return DATA_DIR; },
    get snapshotDir() { return SNAPSHOT_DIR; },
    get logDir() { return LOG_DIR; },
    get logFile() { return LOG_FILE; },

    // Logging
    log
};