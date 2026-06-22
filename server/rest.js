/**
 * REST API Server Module
 * 
 * Provides HTTP endpoints for:
 * - Live video streaming via fMP4 format
 * - Configuration management (GET/POST)
 * - Health status monitoring
 * - Static file serving for web UI
 * - WebSocket API integration
 */

const express = require('express');
const path = require('path');

const utils = require('./utils');
const eufy = require('./eufy-client');
const transcode = require('./transcode');
const wsApi = require('./ws-api');
const push = require('./push');
const auth = require('./auth');

// Directory for static files (HTML, CSS, JS)
const STATIC_DIR = process.env.STATIC_DIR || path.join(require.main.path, 'public');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3001;

// Currently active streaming device (only one device can stream at a time)
let currentDevice = null;
let gracePeriodTimer = null;
let deviceReleaseTimer = null;

// Frame view (Data Saver) state
let frameStreamDevice = null;          // Device currently in MJPEG frame mode
let lastFrameRequestTime = 0;          // Timestamp of the last /frame request
let frameWatchdog = null;              // Idle watchdog interval
const FRAME_IDLE_MS = 8000;            // Stop frame stream after this long with no requests

/**
 * Tear Down fMP4 Stream
 * Ends all HTTP streaming clients and stops the Eufy livestream + transcoding.
 * Used when switching to frame mode (the two are mutually exclusive).
 */
async function teardownMp4Stream() {
    for (const client of utils.getActiveStreamClients()) {
        client.active = false;
        try { client.response.end(); } catch (e) { /* ignore */ }
    }
    utils.clearActiveStreamClients();
    if (currentDevice) {
        await eufy.stopStreamForDevice(currentDevice);
    }
    transcode.stopTranscoding();
    currentDevice = null;
}

/**
 * Tear Down Frame Stream
 * Stops the MJPEG frame pipeline and its idle watchdog.
 */
function teardownFrameStream() {
    if (frameWatchdog) { clearInterval(frameWatchdog); frameWatchdog = null; }
    if (frameStreamDevice || transcode.isFrameMode) {
        eufy.stopFrameStream();
        frameStreamDevice = null;
    }
}

/**
 * Ensure Frame Stream
 * Makes sure the MJPEG frame pipeline is running for the requested device,
 * switching away from any active fMP4 stream or other frame device first.
 * @param {string} sn - Device serial number
 */
async function ensureFrameStream(sn) {
    if (frameStreamDevice === sn && transcode.isFrameMode) return;

    // Stop any active fMP4 stream (mutually exclusive with frame mode)
    if (currentDevice) {
        await teardownMp4Stream();
    }
    // Stop a frame stream for a different device
    if (frameStreamDevice && frameStreamDevice !== sn) {
        await eufy.stopFrameStream();
    }

    frameStreamDevice = sn;
    await eufy.startFrameStreamForDevice(sn);
    startFrameWatchdog();
}

/**
 * Start Frame Watchdog
 * Polls for inactivity and tears down the frame stream once clients stop
 * requesting frames (covers the case where the client crashes/loses network).
 */
function startFrameWatchdog() {
    if (frameWatchdog) return;
    frameWatchdog = setInterval(() => {
        if (frameStreamDevice && Date.now() - lastFrameRequestTime > FRAME_IDLE_MS) {
            utils.log(`🖼️ Frame stream idle, stopping ${frameStreamDevice}`, 'info');
            teardownFrameStream();
        }
    }, 2000);
}

/**
 * Initialize REST API Server
 * Sets up all HTTP endpoints, middleware, and WebSocket integration
 */
function initRestServer() {
    utils.log(`📺 Stream URL: http://localhost:${PORT}/<SERIAL_NUMBER>.mp4`, 'info');
    utils.log(`📁 Static files from: ${STATIC_DIR}`, 'info');

    // Enable JSON body parsing for POST requests
    app.use(express.json());

    // Enable CORS for cross-origin requests from web clients
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Range');
        next();
    });

    // Google OAuth gate — must run before any content routes
    auth.installAuth(app);

    /**
     * fMP4 Live Stream Endpoint
     * Route: GET /:serialNumber.mp4
     * 
     * Streams live video from a Eufy device in fMP4 format.
     * Only one device can stream at a time to prevent resource conflicts.
     */
    app.get('/:serialNumber.mp4', async (req, res) => {
        const requestedDevice = req.params.serialNumber;

        // Validate serial number format (must be alphanumeric)
        if (!/^[A-Z0-9]+$/i.test(requestedDevice)) {
            return res.status(400).json({
                error: 'Invalid serial number format',
                message: 'Serial number must be alphanumeric'
            });
        }

        // Cancel any pending grace period timers from previous disconnects
        if (gracePeriodTimer) { clearTimeout(gracePeriodTimer); gracePeriodTimer = null; }
        if (deviceReleaseTimer) { clearTimeout(deviceReleaseTimer); deviceReleaseTimer = null; }

        // Frame mode and fMP4 streaming are mutually exclusive — stop frame mode first
        if (frameStreamDevice || transcode.isFrameMode) {
            teardownFrameStream();
            await new Promise(r => setTimeout(r, 500));  // let P2P settle before re-requesting
        }

        // If a different device is streaming, stop it first and switch
        if (currentDevice && currentDevice !== requestedDevice) {
            utils.log(`🔄 Switching stream from ${currentDevice} to ${requestedDevice}`, 'info');

            // End all existing client connections
            for (const client of utils.getActiveStreamClients()) {
                client.active = false;
                try { client.response.end(); } catch (e) {}
            }
            utils.clearActiveStreamClients();

            // Stop current stream and transcoding (await to ensure P2P teardown starts)
            await eufy.stopStreamForDevice(currentDevice);
            transcode.stopTranscoding();
            currentDevice = null;

            // Brief delay to let P2P connection fully tear down
            await new Promise(r => setTimeout(r, 500));
        }

        utils.log(`👁️ New stream client for ${requestedDevice} (${utils.getActiveStreamClients().size + 1} active)`, 'info');

        // Set HTTP headers optimized for live fMP4 streaming
        res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'
        });

        // Set this device as the active streaming device
        if (!currentDevice) {
            currentDevice = requestedDevice;
            utils.log(`📹 Device set: ${currentDevice}`, 'info');
        }

        // Initialize Eufy stream and transcoding for this device
        eufy.startStreamForDevice(requestedDevice);
        transcode.currentDevice = requestedDevice;

        // Create client stream object to track this connection
        const clientStream = {
            response: res,
            active: true,
            device: requestedDevice,
            hasReceivedInit: false,
            listenerRegistered: false
        };
        utils.addActiveStreamClient(clientStream);

        /**
         * Stream data handler
         * Forwards transcoded video chunks to the HTTP client.
         * Registered immediately to ensure no data is missed.
         */
        const streamDataHandler = (chunk) => {
            if (clientStream.active && !res.writableEnded && clientStream.hasReceivedInit) {
                try {
                    res.write(chunk);
                } catch (e) {
                    utils.log(`Stream write error: ${e}`, 'error');
                    clientStream.active = false;
                }
            }
        };

        /**
         * Wait for transcoding to start and init segment to be ready
         * The init segment contains essential fMP4 metadata that must be
         * sent before any media data
         */
        const waitForStream = setInterval(() => {
            const outputStream = transcode.getOutputStream;
            if (outputStream && transcode.isTranscoding) {
                // Register stream listener (only once per client)
                if (!clientStream.listenerRegistered) {
                    outputStream.on('data', streamDataHandler);
                    clientStream.listenerRegistered = true;
                    utils.log(`🎧 Registered stream listener for client`, 'debug');
                }

                // Send fMP4 init segment to client (contains codec info, timescale, etc.)
                const initSegment = transcode.getInitSegment;
                if (initSegment && !clientStream.hasReceivedInit) {
                    utils.log(`📦 Sending init segment to client (${initSegment.length} bytes)`, 'debug');
                    try {
                        res.write(initSegment);
                        clientStream.hasReceivedInit = true;
                        clearInterval(waitForStream);
                    } catch (e) {
                        utils.log(`Init segment write error: ${e}`, 'error');
                        clientStream.active = false;
                        clearInterval(waitForStream);
                    }
                } else if (!initSegment) {
                    utils.log(`⏳ Waiting for init segment...`, 'debug');
                }
            }
        }, 100);

        // Timeout after 10 seconds if stream doesn't start
        setTimeout(() => {
            clearInterval(waitForStream);
            if (!res.headersSent) {
                res.status(503).send('Stream not ready');
            }
        }, 10000);

        /**
         * Handle client disconnection
         * Cleanup resources and stop streaming if no clients remain
         */
        req.on('close', () => {
            clearInterval(waitForStream);

            // Cleanup stream listener to prevent memory leaks
            const outputStream = transcode.getOutputStream;
            if (clientStream.listenerRegistered && outputStream) {
                outputStream.removeListener('data', streamDataHandler);
            }

            // Remove this client from active clients list
            for (let client of utils.getActiveStreamClients()) {
                if (client.response === res) {
                    client.active = false;
                    utils.removeActiveStreamClient(client);
                    break;
                }
            }

            utils.log(`👁️ Stream client lost (${utils.getActiveStreamClients().size} active)`, 'info');

            // Stop streaming if all clients have disconnected (with grace period)
            if (utils.getActiveStreamClients().size === 0) {
                // Wait 3 seconds before stopping (allows quick reconnections)
                gracePeriodTimer = setTimeout(() => {
                    gracePeriodTimer = null;
                    if (utils.getActiveStreamClients().size === 0) {
                        eufy.stopStreamForDevice(requestedDevice);
                        transcode.stopTranscoding();

                        // Release device after additional 1 second delay
                        deviceReleaseTimer = setTimeout(() => {
                            deviceReleaseTimer = null;
                            if (utils.getActiveStreamClients().size === 0) {
                                utils.log(`📹 Device released: ${currentDevice}`, 'info');
                                currentDevice = null;
                            }
                        }, 1000);
                    }
                }, 3000);
            }
        });
    });

    /**
     * Frame View Stop Endpoint (Data Saver)
     * Route: GET /frame/stop
     * Explicitly stops the active frame stream (called when the client leaves
     * the view, so we don't wait for the idle watchdog).
     * NOTE: must be registered before the parameterised frame route below.
     */
    app.get('/frame/stop', (req, res) => {
        teardownFrameStream();
        res.json({ stopped: true });
    });

    /**
     * Frame View Endpoint (Data Saver)
     * Route: GET /frame/:serialNumber.jpg
     *
     * Returns a single JPEG frame from the camera. The client polls this to
     * produce a low-bandwidth "stream" made of discrete image requests — looks
     * like normal web browsing rather than media streaming, and uses far less
     * data (useful on restricted/metered WiFi).
     *
     * Supports conditional requests via ETag: if the client already has the
     * latest frame (If-None-Match matches), the request long-polls for up to
     * 5s waiting for the next frame, then returns 304 — so no bytes are wasted
     * re-sending an unchanged frame and round-trips stay minimal.
     */
    app.get('/frame/:serialNumber.jpg', async (req, res) => {
        const sn = req.params.serialNumber;

        if (!/^[A-Z0-9]+$/i.test(sn)) {
            return res.status(400).json({ error: 'Invalid serial number format' });
        }

        // Make sure the frame pipeline is running for this device
        try {
            await ensureFrameStream(sn);
        } catch (e) {
            utils.log(`❌ Failed to start frame stream for ${sn}: ${e.message}`, 'error');
            return res.status(500).json({ error: 'Failed to start frame stream' });
        }
        lastFrameRequestTime = Date.now();

        // Send the current frame with caching/ETag headers
        const sendFrame = () => {
            const frame = transcode.getLatestFrame();
            if (!frame) {
                res.status(503).end();  // not ready yet — client will retry
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'ETag': transcode.frameEtag,
                'Content-Length': frame.length
            });
            res.end(frame);
        };

        const clientEtag = req.headers['if-none-match'];
        const haveFrame = transcode.getLatestFrame() !== null;

        // Client is up to date — long-poll for the next frame
        if (haveFrame && clientEtag && clientEtag === transcode.frameEtag) {
            let settled = false;
            const onFrame = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                req.removeListener('close', onClose);
                sendFrame();
            };
            const onClose = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                transcode.event.removeListener('frame', onFrame);
            };
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                transcode.event.removeListener('frame', onFrame);
                req.removeListener('close', onClose);
                res.status(304).end();
            }, 5000);
            transcode.event.once('frame', onFrame);
            req.on('close', onClose);
            return;
        }

        sendFrame();
    });

    /**
     * Web Push: VAPID public key
     * Route: GET /push/key
     */
    app.get('/push/key', (req, res) => {
        res.json({ publicKey: push.getPublicKey() });
    });

    /**
     * Web Push: subscribe
     * Route: POST /push/subscribe  Body: { subscription, prefs, mutes }
     */
    app.post('/push/subscribe', (req, res) => {
        const ok = push.addSubscription(req.body.subscription, req.body.prefs, req.body.mutes);
        res.json({ success: ok });
    });

    /**
     * Web Push: update per-camera preferences / temporary mutes
     * Route: POST /push/prefs  Body: { endpoint, prefs, mutes }
     */
    app.post('/push/prefs', (req, res) => {
        const ok = push.updatePrefs(req.body.endpoint, req.body.prefs, req.body.mutes);
        res.json({ success: ok });
    });

    /**
     * Web Push: unsubscribe
     * Route: POST /push/unsubscribe  Body: { endpoint }
     */
    app.post('/push/unsubscribe', (req, res) => {
        const ok = push.removeSubscription(req.body.endpoint);
        res.json({ success: ok });
    });

    /**
     * Configuration GET Endpoint
     * Route: GET /config
     * Returns current server configuration
     */
    app.get('/config', (req, res) => {
        res.json(utils.loadConfig());
    });

    /**
     * Configuration POST Endpoint
     * Route: POST /config
     * Updates server configuration dynamically
     * Restarts affected services automatically
     */
    app.post('/config', (req, res) => {
        const newConfig = req.body;
        utils.log(`📝 Config update requested: ${JSON.stringify(newConfig)}`, 'debug');

        // Whitelist of allowed configuration keys for security
        const allowedKeys = ['EUFY_CONFIG', 'TRANSCODING_PRESET', 'TRANSCODING_CRF', 'VIDEO_SCALE', 'FFMPEG_THREADS', 'FFMPEG_SHORT_KEYFRAMES', 'FRAME_FPS', 'FRAME_SCALE', 'FRAME_QUALITY'];
        const updatedFields = [];

        let CONFIG = utils.loadConfig();
        for (const key of Object.keys(newConfig)) {
            if (allowedKeys.includes(key)) {
                // Track only fields that actually changed (avoid unnecessary restarts)
                if (JSON.stringify(CONFIG[key]) !== JSON.stringify(newConfig[key])) {
                    if (key === 'EUFY_CONFIG') {
                        // Merge EUFY_CONFIG subfields
                        CONFIG[key] = { ...CONFIG[key], ...newConfig[key] };
                    } else {
                        CONFIG[key] = newConfig[key];
                    }

                    updatedFields.push(key);
                }
            }
        }

        if (updatedFields.length > 0) {
            utils.log(`✅ Config updated: ${updatedFields.join(', ')}`, 'debug');

            // Persist configuration changes to disk
            const saved = utils.saveConfig(CONFIG);

            // Determine which services need to be restarted based on changed fields
            const transcodingFields = ['TRANSCODING_PRESET', 'TRANSCODING_CRF', 'VIDEO_SCALE', 'FFMPEG_THREADS', 'FFMPEG_SHORT_KEYFRAMES'];
            const eufyFields = ['EUFY_CONFIG'];

            const needsTranscodeRestart = updatedFields.some(field => transcodingFields.includes(field));
            const needsEufyRestart = updatedFields.some(field => eufyFields.includes(field));

            if (needsTranscodeRestart) {
                utils.log('🔄 Restarting transcoding due to config changes', 'debug');
                transcode.stopTranscoding();
                transcode.initTranscode();
            }

            if (needsEufyRestart) {
                utils.log('🔄 Restarting Eufy client due to config changes', 'debug');
                eufy.close();
                eufy.connect(CONFIG.EUFY_CONFIG);
            }

            res.json({
                success: true,
                message: 'Configuration updated successfully',
                updatedFields: updatedFields,
                saved: saved,
                config: CONFIG
            });
        } else {
            res.status(400).json({
                success: false,
                message: 'No valid configuration fields provided',
                allowedFields: allowedKeys
            });
        }
    });

    /**
     * Health Check Endpoint
     * Route: GET /health
     * Returns current server status and streaming information
     */
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            _ts: Date.now(),
            eufyConnected: eufy.isConnected(),
            eufyVideo: transcode.videoMetadata,
            eufyAudio: transcode.audioMetadata,
            streamClients: utils.getActiveStreamClients().size,
            transcoding: transcode.isTranscoding,
            currentDevice: currentDevice,
            transcodeScale: transcode.videoScale,
            hasInitSegment: transcode.hasInitSegment,
            hasKeyframeSegment: transcode.hasKeyframeSegment,
            frameMode: transcode.isFrameMode,
            frameStreamDevice: frameStreamDevice
        });
    });

    // Diagnostic: houses debug
    app.get('/debug/houses', (req, res) => {
        try {
            const data = eufy.getHousesDebug();
            // Safely stringify (avoid circular refs)
            const safe = JSON.parse(JSON.stringify(data, (key, val) => {
                if (key === 'member_avatar' || key === 'extra') return undefined;
                return val;
            }));
            res.json(safe);
        } catch (e) {
            res.json({ error: e.message, stack: e.stack });
        }
    });

    /**
     * Shutdown Endpoint
     * Route: GET /quit
     * Gracefully shuts down the server
     */
    app.get('/quit', (req, res) => {
        res.json({ status: 'shutting down' });
        utils.log('🛑 Shutting down...', 'warn');
        teardownFrameStream();
        transcode.stopTranscoding();
        process.exit(0);
    });

    // Serve static files (HTML, CSS, JS) for the web UI
    app.use(express.static(STATIC_DIR, {
        index: 'index.html',
        extensions: ['html', 'htm']
    }));

    const server = app.listen(PORT, '0.0.0.0', () => {
        utils.log(`🌐 HTTP server running at http://0.0.0.0:${PORT}`, 'info');
        utils.log(`📺 Stream format: http://<IP>:${PORT}/<SERIAL_NUMBER>.mp4`, 'info');
    });

    // Initialize WebSocket API on /api path for real-time communication
    wsApi.initWebSocketServer(server, PORT, getServerStatus);
}

/**
 * Get Server Status
 * Returns current operational status for WebSocket API and monitoring
 * @returns {Object} Server status including connection states and active streams
 */
function getServerStatus() {
    return {
        eufyConnected: eufy.isConnected(),
        streamClients: utils.getActiveStreamClients().size,
        transcoding: transcode.isTranscoding,
        currentDevice: currentDevice,
        wsClients: wsApi.getClientCount(),
        videoMetadata: transcode.videoMetadata,
        audioMetadata: transcode.audioMetadata
    };
}

module.exports = {
    initRestServer,
    wsEmitEvent: wsApi.wsEmitEvent,
    wsBroadcast: wsApi.wsBroadcast
};