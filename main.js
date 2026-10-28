/**
 * EufyView - Streaming Proxy Server
 *
 * Main entry point for the streaming proxy server that handles:
 * - Connection to Eufy Security devices
 * - Video stream transcoding via FFmpeg
 * - REST API + WebSocket for client communication
 */

const utils = require('./server/utils');

// ---- CLI: cross-platform admin setup / recovery (Windows + Linux) ----
// `node main.js --set-admin <email> [password]` seeds or resets the single
// administrator account without a browser or the tray. If the password is
// omitted it's read from the EUFYVIEW_ADMIN_PASSWORD env var. This is the
// out-of-band path for a fresh install or a locked-out admin on any OS.
if (process.argv.includes('--set-admin')) {
    const auth = require('./server/auth');
    const i = process.argv.indexOf('--set-admin');
    const email = process.argv[i + 1];
    const password = process.argv[i + 2] || process.env.EUFYVIEW_ADMIN_PASSWORD;
    if (!email || !password) {
        console.error('Usage: node main.js --set-admin <email> <password>');
        console.error('   or: EUFYVIEW_ADMIN_PASSWORD=... node main.js --set-admin <email>');
        process.exit(2);
    }
    try {
        auth.setAdmin(email, password);
        console.log('Administrator set to ' + String(email).toLowerCase() + '. Restart the server for it to take effect.');
        process.exit(0);
    } catch (e) {
        console.error('Failed: ' + e.message);
        process.exit(1);
    }
}

const transcode = require('./server/transcode');
const eufy = require('./server/eufy-client');
const restServer = require('./server/rest');
const push = require('./server/push');
const events = require('./server/events');

// Load configuration
let CONFIG = utils.loadConfig();

// Start HTTP/WS server and transcoding first (always available)
transcode.initTranscode();
push.initPush();
events.init();
restServer.initRestServer();

utils.log('Server started - HTTP ready', 'info');

// Connect to Eufy in background (may fail if no credentials yet)
const eufyConfig = CONFIG.EUFY_CONFIG;
if (eufyConfig.username && eufyConfig.password) {
    utils.log('Connecting to Eufy...', 'info');
    eufy.connect(eufyConfig);
} else {
    utils.log('No Eufy credentials configured. Use the web UI to set them.', 'warn');
}

/**
 * Graceful shutdown handler
 */
// Write any debounced event-log changes before the process goes away
process.on('exit', () => events.flush());

process.on('SIGINT', async () => {
    utils.log('Shutting down...', 'warn');
    transcode.stopFrameMode();
    transcode.stopTranscoding();
    await eufy.close();
    process.exit(0);
});

/**
 * Global exception handler
 */
process.on('uncaughtException', (err) => {
    if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'EOF Error') {
        utils.log(`${err.code} uncaught exception. Ignored.`, 'debug');
        return;
    }
    utils.log(`Uncaught exception: ${err.code} ${err}`, 'error');
    console.error(err);
    process.exit(1);
});
