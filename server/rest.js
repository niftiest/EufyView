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
const fs = require('fs');
const crypto = require('crypto');
const { fixV2Thumbnail } = require('./v2thumb');

const utils = require('./utils');
const eufy = require('./eufy-client');
const transcode = require('./transcode');
const rtspStream = require('./rtsp-stream');
const wsApi = require('./ws-api');
const push = require('./push');
const history = require('./history');
const events = require('./events');
const auth = require('./auth');
const tvInstaller = require('./tv-installer');
const updates = require('./updates');

// Directory for static files (HTML, CSS, JS)
const STATIC_DIR = process.env.STATIC_DIR || path.join(require.main.path, 'public');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3001;

// Currently active streaming device (only one device can stream at a time)
let currentDevice = null;
let gracePeriodTimer = null;
let deviceReleaseTimer = null;

// Resolve the requesting client's camera access scope from the session cookie OR
// a bearer device token (so appliance clients like the TV app can stream too).
function reqScope(req) {
    return auth.scopeForRequest(req);
}

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

    // Security headers + (locked-down) CORS + CSRF protection.
    app.use((req, res, next) => {
        // Hardening headers on every response.
        res.header('X-Content-Type-Options', 'nosniff');
        res.header('X-Frame-Options', 'DENY');                 // no framing → no clickjacking
        res.header('Referrer-Policy', 'no-referrer');
        res.header('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");

        // The web app is served from this same origin, so no cross-origin access
        // is granted. Deliberately NO permissive Access-Control-Allow-Origin - that
        // combined with the SameSite=None session cookie would let any website make
        // authenticated state-changing requests. (The TV app is native, not a
        // browser, so it isn't subject to CORS.) A cross-origin preflight gets 204
        // with no allow-origin header → the browser blocks the real request.
        if (req.method === 'OPTIONS') return res.sendStatus(204);

        // CSRF: block cross-site state-changing requests that ride on the ambient
        // session cookie. Bearer-token callers (the TV app) are exempt - a bearer
        // credential isn't sent automatically by a browser. GET/HEAD are not state-
        // changing. Trust Sec-Fetch-Site (page JS can't forge it); fall back to an
        // Origin/Host comparison for older browsers. Requests with no browser
        // signals at all (native app / curl / server-to-server) are allowed.
        const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
        const isBearer = /^Bearer\s/i.test(req.headers.authorization || '');
        if (isMutation && !isBearer) {
            const sfs = req.headers['sec-fetch-site'];
            let crossSite = false;
            if (sfs) {
                crossSite = !(sfs === 'same-origin' || sfs === 'same-site' || sfs === 'none');
            } else if (req.headers.origin) {
                try { crossSite = new URL(req.headers.origin).host !== req.headers.host; }
                catch (e) { crossSite = true; }
            }
            if (crossSite) return res.status(403).json({ error: 'cross-site request blocked' });
        }
        next();
    });

    // Auth gate (password sign-in) - must run before any content routes
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

        // Camera scoping: block users who aren't granted this camera
        if (!auth.isCameraAllowed(reqScope(req), requestedDevice)) {
            return res.status(403).json({ error: 'forbidden', message: 'Not authorized for this camera' });
        }

        // Cancel any pending grace period timers from previous disconnects
        if (gracePeriodTimer) { clearTimeout(gracePeriodTimer); gracePeriodTimer = null; }
        if (deviceReleaseTimer) { clearTimeout(deviceReleaseTimer); deviceReleaseTimer = null; }

        // Frame mode and fMP4 streaming are mutually exclusive - stop frame mode first
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
    /**
     * Route: GET /rtsp/:serialNumber.mp4
     * RTSP fast path - stream the camera's local RTSP feed as fragmented MP4,
     * independent of the P2P pipeline (so it works alongside a P2P stream and
     * doesn't use the station's single video slot). 409 if RTSP isn't enabled.
     */
    app.get('/rtsp/:serialNumber.mp4', async (req, res) => {
        const sn = req.params.serialNumber;
        if (!/^[A-Z0-9]+$/i.test(sn)) {
            return res.status(400).json({ error: 'Invalid serial number format' });
        }
        if (!auth.isCameraAllowed(reqScope(req), sn)) {
            return res.status(403).json({ error: 'forbidden', message: 'Not authorized for this camera' });
        }
        // Auto-manage RTSP: enable on the camera now (if needed), turn back off
        // after the viewer leaves. null => camera can't RTSP right now (e.g.
        // asleep) → tell the client to fall back to P2P.
        const url = await eufy.acquireRtspSession(sn);
        if (!url) {
            return res.status(409).json({ error: 'rtsp_unavailable', message: 'RTSP not available; use P2P' });
        }
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Connection': 'close' });
        const stream = rtspStream.startRtspStream(url);
        let stopped = false;
        let received = 0;
        const cleanup = () => {
            if (stopped) return; stopped = true;
            stream.stop();
            eufy.releaseRtspSession(sn);
            // Empty stream = camera asleep despite RTSP being on → cool down so
            // the next watch falls back to P2P immediately.
            if (received < 4096) eufy.markRtspMiss(sn);
        };
        stream.stdout.on('data', (d) => { received += d.length; });
        stream.stdout.pipe(res);
        stream.stdout.on('error', cleanup);
        req.on('close', cleanup);
        res.on('close', cleanup);
    });

    app.get('/frame/stop', (req, res) => {
        teardownFrameStream();
        res.json({ stopped: true });
    });

    /**
     * Frame View Endpoint (Data Saver)
     * Route: GET /frame/:serialNumber.jpg
     *
     * Returns a single JPEG frame from the camera. The client polls this to
     * produce a low-bandwidth "stream" made of discrete image requests - looks
     * like normal web browsing rather than media streaming, and uses far less
     * data (useful on restricted/metered WiFi).
     *
     * Supports conditional requests via ETag: if the client already has the
     * latest frame (If-None-Match matches), the request long-polls for up to
     * 5s waiting for the next frame, then returns 304 - so no bytes are wasted
     * re-sending an unchanged frame and round-trips stay minimal.
     */
    app.get('/frame/:serialNumber.jpg', async (req, res) => {
        const sn = req.params.serialNumber;

        if (!/^[A-Z0-9]+$/i.test(sn)) {
            return res.status(400).json({ error: 'Invalid serial number format' });
        }

        // Camera scoping: block users who aren't granted this camera
        if (!auth.isCameraAllowed(reqScope(req), sn)) {
            return res.status(403).json({ error: 'forbidden', message: 'Not authorized for this camera' });
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
                res.status(503).end();  // not ready yet - client will retry
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

        // Client is up to date - long-poll for the next frame
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
     * Saved snapshot (last keyframe written to disk), for clients that fetch
     * thumbnails over HTTP rather than receiving the pushed `picture` buffer -
     * e.g. the TV dashboard's hero/cards, which want the large master. Defaults
     * to the master; ?size=sm serves the small PWA derivative.
     * Route: GET /snapshot/:serialNumber.jpg
     */
    app.get('/snapshot/:serialNumber.jpg', (req, res) => {
        const sn = req.params.serialNumber;
        if (!/^[A-Z0-9]+$/i.test(sn)) {
            return res.status(400).json({ error: 'Invalid serial number format' });
        }
        if (!auth.isCameraAllowed(reqScope(req), sn)) {
            return res.status(403).json({ error: 'forbidden', message: 'Not authorized for this camera' });
        }
        const small = req.query.size === 'sm';
        const jpg = utils.loadSnapshotFromDisk(sn, { small });
        if (!jpg) return res.status(404).end();
        res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'no-cache',
            'Content-Length': jpg.length
        });
        res.end(jpg);
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
     * Route: POST /push/subscribe  Body: { subscription, prefs, mutes, types, style, oldEndpoint }
     */
    app.post('/push/subscribe', (req, res) => {
        const { subscription, prefs, mutes, types, style, oldEndpoint } = req.body;
        const ok = push.addSubscription(subscription, { prefs, mutes, types, style, oldEndpoint, email: reqScope(req).email });
        res.json({ success: ok });
    });

    /**
     * Web Push: update per-camera preferences / mutes / alert types / style
     * Route: POST /push/prefs  Body: { endpoint, prefs, mutes, types, style }
     */
    app.post('/push/prefs', (req, res) => {
        const { endpoint, prefs, mutes, types, style } = req.body;
        const ok = push.updatePrefs(endpoint, { prefs, mutes, types, style, email: reqScope(req).email });
        res.json({ success: ok });
    });

    /**
     * Web Push: event thumbnail for a notification
     * Route: GET /push/thumb/:token.jpg
     * Auth-exempt (see auth.js): the 128-bit random token, only ever sent inside
     * an end-to-end encrypted push payload and expiring after 30 min, is the
     * credential - the OS may fetch notification images without our cookie.
     */
    app.get('/push/thumb/:token.jpg', (req, res) => {
        const t = /^[0-9a-f]{32}$/.test(req.params.token) ? push.getThumbnail(req.params.token) : null;
        if (!t) return res.status(404).end();
        res.set('Content-Type', t.mime);
        res.set('Cache-Control', 'private, max-age=1800');
        res.send(t.buf);
    });

    /**
     * History: recorded clip (downloaded + muxed by history.js)
     * Route: GET /history/clip/:id.mp4 - Range requests supported for seeking
     */
    app.get('/history/clip/:id.mp4', (req, res) => {
        const id = req.params.id;
        if (!history.isValidId(id) || !auth.isCameraAllowed(reqScope(req), history.serialFromId(id))) {
            return res.status(403).end();
        }
        const file = history.getClipFile(id);
        if (file) {
            return res.sendFile(file, { headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, max-age=86400' } });
        }
        // Not cached yet: if a download is in flight, stream the fragmented MP4 as
        // it's produced so playback starts at the first keyframe. Otherwise 404.
        if (history.attachStream(id, res)) return;
        return res.status(404).end();
    });

    /**
     * History Data Saver: extract (or report) low-fps JPEG frames for a clip, so a
     * past event can be watched as a low-bandwidth slideshow on restricted WiFi.
     * Route: GET /history/frames/:id.json  → { ready, count, fps }
     */
    app.get('/history/frames/:id.json', async (req, res) => {
        const id = req.params.id;
        if (!history.isValidId(id) || !auth.isCameraAllowed(reqScope(req), history.serialFromId(id))) {
            return res.status(403).end();
        }
        try { res.json(await history.extractFrames(id)); }
        catch (e) { res.status(502).json({ error: e.message }); }
    });

    /**
     * History Data Saver: serve one extracted frame (1-based).
     * Route: GET /history/frame/:id/:n.jpg
     */
    app.get('/history/frame/:id/:n.jpg', (req, res) => {
        const id = req.params.id;
        if (!history.isValidId(id) || !auth.isCameraAllowed(reqScope(req), history.serialFromId(id))) {
            return res.status(403).end();
        }
        const file = history.getFrameFile(id, req.params.n);
        if (!file) return res.status(404).end();
        return res.sendFile(file, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
    });

    /**
     * History: snapshot saved by EufyView's own event log
     * Route: GET /history/snap/:id.jpg
     */
    app.get('/history/snap/:id.jpg', async (req, res) => {
        const id = req.params.id;
        if (!events.isValidId(id) || !auth.isCameraAllowed(reqScope(req), events.serialFromId(id))) {
            return res.status(403).end();
        }
        const file = events.getSnapshotFile(id);
        if (!file) return res.status(404).end();
        try {
            // Repair HomeBase 2 v2 snapshots sheared by the library's fixed-geometry
            // splice, and write the clean image back so it's a one-time cost per file.
            let buf = fs.readFileSync(file);
            const fixed = await fixV2Thumbnail(buf, `${events.serialFromId(id)}:snap`);
            if (fixed !== buf) { try { fs.writeFileSync(file, fixed); } catch (e) {} buf = fixed; }
            res.set('Cache-Control', 'private, max-age=604800');
            res.type('image/jpeg').send(buf);
        } catch (e) {
            res.sendFile(file, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=604800' } });
        }
    });

    /**
     * History: event thumbnail
     * Route: GET /history/thumb/:id.jpg
     */
    app.get('/history/thumb/:id.jpg', async (req, res) => {
        const id = req.params.id;
        if (!history.isValidId(id) || !auth.isCameraAllowed(reqScope(req), history.serialFromId(id))) {
            return res.status(403).end();
        }
        try {
            const buf = await history.getThumbnail(id);
            if (!buf) return res.status(404).end();
            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'private, max-age=86400');
            res.send(buf);
        } catch (e) {
            res.status(502).end();
        }
    });

    /**
     * Web Push: unsubscribe
     * Route: POST /push/unsubscribe  Body: { endpoint }
     */
    app.post('/push/unsubscribe', (req, res) => {
        const ok = push.removeSubscription(req.body.endpoint);
        res.json({ success: ok });
    });

    // ========================================================================
    // Current user + access management (admin only)
    // ========================================================================

    /**
     * GET /auth/me - who is the signed-in user and what can they see.
     * Returns { email, admin, cameras: 'all'|[sn], authEnabled }.
     */
    app.get('/auth/me', (req, res) => {
        const scope = reqScope(req);
        res.json({
            email: scope.email,
            admin: !!scope.admin,
            cameras: scope.cameras,
            authEnabled: scope.authEnabled !== false
        });
    });

    // Reject non-admin callers. Returns the scope on success, null otherwise.
    function requireAdmin(req, res) {
        const scope = reqScope(req);
        if (!scope.admin) { res.status(403).json({ error: 'forbidden' }); return null; }
        return scope;
    }

    // Allow the server machine itself (tray, loopback) OR a signed-in admin.
    // Used for server-level actions (config, Eufy account, shutdown) that a
    // scoped viewer must never perform. Returns true on success.
    function requireAdminOrLoopback(req, res) {
        const ip = req.socket.remoteAddress || '';
        if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
        const scope = reqScope(req);
        if (scope && scope.admin) return true;
        res.status(403).json({ error: 'admin only' });
        return false;
    }

    /**
     * GET /admin/cameras - full camera catalog for assigning access.
     */
    app.get('/admin/cameras', (req, res) => {
        if (!requireAdmin(req, res)) return;
        res.json({ cameras: eufy.getDeviceCatalog() });
    });

    /**
     * GET /admin/users - list scoped users + admin emails.
     */
    app.get('/admin/users', (req, res) => {
        if (!requireAdmin(req, res)) return;
        res.json(auth.listAccess());
    });

    /**
     * POST /admin/users - add a user (or update access if they already exist).
     * Body: { email, cameras: 'all' | ["SN1","SN2"] }
     * Returns a one-time claimCode for a brand-new user (null when updating).
     */
    app.post('/admin/users', (req, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const r = auth.addUser(req.body.email, req.body.cameras);
            res.json({ success: true, user: r.user, claimCode: r.claimCode });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    /**
     * PUT /admin/users/access - change a user's camera scope. Body: { email, cameras }
     */
    app.put('/admin/users/access', (req, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            res.json({ success: true, user: auth.updateUserAccess(req.body.email, req.body.cameras).user });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    /**
     * POST /admin/users/reset - clear a user's password + issue a new claim code.
     * POST /admin/users/claim - reissue a claim code for an unclaimed user.
     * Both return the one-time plaintext claimCode. Body: { email }
     */
    app.post('/admin/users/reset', (req, res) => {
        if (!requireAdmin(req, res)) return;
        try { res.json({ success: true, claimCode: auth.resetUserPassword(req.body.email).claimCode }); }
        catch (e) { res.status(400).json({ success: false, error: e.message }); }
    });
    app.post('/admin/users/claim', (req, res) => {
        if (!requireAdmin(req, res)) return;
        try { res.json({ success: true, claimCode: auth.regenClaim(req.body.email).claimCode }); }
        catch (e) { res.status(400).json({ success: false, error: e.message }); }
    });

    /**
     * DELETE /admin/users - remove a user. Body: { email }
     */
    app.delete('/admin/users', (req, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            auth.removeUser(req.body.email);
            res.json({ success: true });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    /**
     * POST /admin/account - change the administrator's email and/or password.
     * Body: { currentPassword, newEmail?, newPassword? }
     */
    app.post('/admin/account', (req, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            res.json({ success: true, result: auth.updateAdminAccount(req.body || {}) });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    /**
     * GET /updates/check - is a newer release available on GitHub?
     * Any signed-in user may read it (cached; drives the header badge + About
     * pane). `?force=1` bypasses the cache and is admin-only so a viewer can't
     * burn the unauthenticated GitHub rate limit.
     */
    app.get('/updates/check', async (req, res) => {
        const scope = reqScope(req);
        const ip = req.socket.remoteAddress || '';
        const loop = (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
        // Path is auth-exempt (so the loopback tray can reach it); gate here:
        // allow the server machine (tray), any signed-in user, or dev no-auth mode.
        if (!loop && !(scope && (scope.email || scope.authEnabled === false))) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        const force = req.query.force === '1' && (loop || !!(scope && scope.admin));
        try {
            res.json(await updates.check({ force }));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /**
     * POST /updates/apply - download + launch the platform updater (admin only).
     * Windows installs self-update; docker/manual return notify-only guidance.
     * GET /updates/apply/status - progress of an in-flight apply.
     */
    app.post('/updates/apply', async (req, res) => {
        if (!requireAdminOrLoopback(req, res)) return;   // admin session or the tray (loopback)
        try {
            res.json(await updates.apply());
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    app.get('/updates/apply/status', (req, res) => {
        if (!requireAdminOrLoopback(req, res)) return;
        res.json(updates.getApplyState());
    });

    /**
     * GET /updates/tv - latest TV-app APK version + download URL (for the native
     * TV client's in-app self-update). Any authenticated caller (the TV sends its
     * bearer device token). Returns { available, versionCode, versionName, url, tag, notes }.
     */
    app.get('/updates/tv', async (req, res) => {
        try {
            res.json(await updates.tvInfo());
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /**
     * Configuration GET Endpoint
     * Route: GET /config
     * Returns current server configuration
     */
    app.get('/config', (req, res) => {
        // Never expose secrets (the Eufy account credentials) over the API - any
        // signed-in user can reach this, and nothing needs to read them back.
        const cfg = { ...(utils.loadConfig() || {}) };
        delete cfg.EUFY_CONFIG;
        res.json(cfg);
    });

    /**
     * Status Endpoint (localhost only)
     * Route: GET /status
     * Rich snapshot for the tray Status window: Eufy connection, sync counts,
     * remote URL, version/uptime, last detection, log path. Auth-exempt but
     * restricted to loopback so it never leaks counts/URL over public ingress.
     */
    app.get('/status', (req, res) => {
        const ip = req.socket.remoteAddress || '';
        if (!(ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) {
            return res.status(403).json({ error: 'localhost only' });
        }
        const st = eufy.getStatus();
        let last = null;
        try {
            const recent = events.list(null, { start: 0, end: Date.now() + 1 });
            if (recent && recent.length) {
                const e = recent[0];
                last = { label: e.label, camera: e.cameraName, time: e.time };
            }
        } catch (e) { /* events may be empty */ }
        let networkMode = null;
        try { networkMode = utils.loadConfig().networkMode || null; } catch (e) {}
        res.json({
            ok: true,
            connected: st.connected,
            houses: st.houses,
            stations: st.stations,
            cameras: st.devices,
            version: require('../package.json').version,
            uptimeSec: Math.floor(process.uptime()),
            remoteUrl: auth.getPublicBaseUrl(),
            networkMode,
            lastDetection: last,
            logFile: utils.logFile,
            auth: auth.authStatus()   // localhost-only, so safe to include username/mode
        });
    });

    /**
     * First-run Eufy login (onboarding wizard)
     * GET  /setup/status      - current login phase (idle/connecting/captcha/tfa/connected/error)
     * POST /setup/eufy-login  - { username, password, country?, language? } → start login
     * POST /setup/eufy-verify - { verifyCode } or { captchaCode } → answer a captcha/2FA prompt
     * The login calls are async (fire-and-forget); the wizard polls /setup/status.
     */
    app.get('/setup/status', (req, res) => {
        res.json(Object.assign({}, eufy.getSetupState(), { auth: auth.authStatus() }));
    });

    // Set / change the built-in password gate. Allowed from the server machine
    // (tray/loopback), from a remote admin, OR during first-run when no gate is
    // configured yet (fresh install - authStatus().mode is null). Stores only a
    // scrypt hash; the plaintext is never written to disk.
    app.post('/setup/set-password', (req, res) => {
        const ip = req.socket.remoteAddress || '';
        const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
        // Creating/seeding the administrator is restricted to the server machine
        // itself (loopback) so a reachable server can't be hijacked during
        // first-run setup; an existing admin can also change it. NOT allowed from
        // a remote address just because no admin exists yet.
        const scope = reqScope(req);
        if (!(isLoopback || (scope && scope.admin))) {
            return res.status(403).json({ error: 'initial setup must be done on the server computer' });
        }
        const { username, email, password } = req.body || {};
        try {
            res.json(auth.setAdmin(email || username, password));
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.post('/setup/eufy-login', (req, res) => {
        if (!requireAdminOrLoopback(req, res)) return;   // binds the Eufy account - admin/server only
        const { username, password, country, language } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
        eufy.startEufyLogin({ username, password, country, language });
        res.json({ ok: true });
    });

    app.post('/setup/eufy-verify', (req, res) => {
        if (!requireAdminOrLoopback(req, res)) return;
        const { verifyCode, captchaCode } = req.body || {};
        if (!verifyCode && !captchaCode) return res.status(400).json({ error: 'verifyCode or captchaCode is required' });
        eufy.submitEufyVerification({ verifyCode, captchaCode });
        res.json({ ok: true });
    });

    /**
     * Smart-device installer (admin only) - scan the LAN for Android/Fire TVs and
     * one-click install + pair the TV app over ADB. Drives adb on the server.
     *   GET  /devices/scan     - probe the LAN for devices with ADB (:5555) open
     *   POST /devices/install  - { ip } → connect/auth/install/pair (async)
     *   GET  /devices/status   - per-ip install progress
     */
    // Allowed from the server machine itself (tray, loopback) OR a remote admin.
    function requireDeviceAccess(req, res) {
        const ip = req.socket.remoteAddress || '';
        if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
        const scope = reqScope(req);
        if (scope && scope.admin) return true;
        res.status(403).json({ error: 'admin only' });
        return false;
    }

    app.get('/devices/scan', async (req, res) => {
        if (!requireDeviceAccess(req, res)) return;
        try { res.json(await tvInstaller.scan()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/devices/install', (req, res) => {
        if (!requireDeviceAccess(req, res)) return;
        const ip = (req.body && req.body.ip) || '';
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return res.status(400).json({ error: 'valid ip required' });
        tvInstaller.install(ip);   // async; poll /devices/status
        res.json({ ok: true });
    });

    app.post('/devices/uninstall', (req, res) => {
        if (!requireDeviceAccess(req, res)) return;
        const ip = (req.body && req.body.ip) || '';
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return res.status(400).json({ error: 'valid ip required' });
        tvInstaller.uninstall(ip);   // async; poll /devices/status
        res.json({ ok: true });
    });

    app.get('/devices/status', (req, res) => {
        if (!requireDeviceAccess(req, res)) return;
        res.json(tvInstaller.status());
    });

    // Install environment - lets the app hide LAN-only TV install on a VPS, where
    // scanning the local network would find nothing.
    app.get('/devices/env', (req, res) => {
        if (!requireDeviceAccess(req, res)) return;
        res.json(tvInstaller.environment());
    });

    /**
     * Configuration POST Endpoint
     * Route: POST /config
     * Updates server configuration dynamically
     * Restarts affected services automatically
     */
    app.post('/config', (req, res) => {
        if (!requireAdmin(req, res)) return;   // server-wide settings → admin only
        const newConfig = req.body || {};
        // Redact secrets from logs (EUFY_CONFIG carries the Eufy account password).
        const logView = { ...newConfig };
        if (logView.EUFY_CONFIG) logView.EUFY_CONFIG = '[redacted]';
        utils.log(`📝 Config update requested: ${JSON.stringify(logView)}`, 'debug');

        // Whitelist of allowed configuration keys for security
        const allowedKeys = ['EUFY_CONFIG', 'TRANSCODING_PRESET', 'TRANSCODING_CRF', 'VIDEO_SCALE', 'FFMPEG_THREADS', 'FFMPEG_SHORT_KEYFRAMES', 'FRAME_FPS', 'FRAME_SCALE', 'FRAME_QUALITY'];

        // Several of these values are interpolated into FFmpeg argument strings
        // (scale=…, fps=…). Validate strictly so nothing but the expected shape can
        // reach FFmpeg, even for an admin (defense-in-depth against filter injection).
        const validValue = (key, v) => {
            switch (key) {
                case 'VIDEO_SCALE':
                case 'FRAME_SCALE':            return v === '' || /^\d{1,5}:-?\d{1,5}$/.test(String(v));
                case 'TRANSCODING_PRESET':     return ['ultrafast','superfast','veryfast','faster','fast','medium','slow','slower','veryslow'].includes(String(v));
                case 'TRANSCODING_CRF':        { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 51; }
                case 'FRAME_QUALITY':          { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 31; }
                case 'FRAME_FPS':              { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 30; }
                case 'FFMPEG_THREADS':         { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 64; }
                case 'FFMPEG_SHORT_KEYFRAMES': return typeof v === 'boolean';
                case 'EUFY_CONFIG':            return v && typeof v === 'object' && !Array.isArray(v);
                default:                       return false;
            }
        };
        for (const key of Object.keys(newConfig)) {
            if (allowedKeys.includes(key) && !validValue(key, newConfig[key])) {
                return res.status(400).json({ success: false, message: `Invalid value for ${key}` });
            }
        }

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

            const configView = { ...CONFIG };
            delete configView.EUFY_CONFIG;   // never echo the Eufy credentials back
            res.json({
                success: true,
                message: 'Configuration updated successfully',
                updatedFields: updatedFields,
                saved: saved,
                config: configView
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

    // Diagnostic: houses debug (full inventory → admin only)
    app.get('/debug/houses', (req, res) => {
        if (!requireAdmin(req, res)) return;
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
        if (!requireAdminOrLoopback(req, res)) return;   // tray (loopback) or admin only
        res.json({ status: 'shutting down' });
        utils.log('🛑 Shutting down...', 'warn');
        teardownFrameStream();
        transcode.stopTranscoding();
        process.exit(0);
    });

    // --- Automatic cache-busting ------------------------------------------------
    // Instead of hand-bumping a ?v=N in index.html and CACHE_NAME in sw.js every
    // release, both files carry a literal `__ASSETVER__` placeholder which we
    // replace at serve time with a short content hash of the client assets. The
    // hash changes IFF app.js/css/index.html/sw.js change, so:
    //   - app.js?v=<hash> / styles.css?v=<hash> get a fresh URL -> Cloudflare +
    //     browser cache-miss and refetch (the only reliable edge bust - we can't
    //     purge Cloudflare), and
    //   - sw.js's CACHE_NAME changes -> the "Update available" banner fires.
    // index.html and sw.js are served no-store so the edge never caches the
    // placeholder/old hash; the hashed asset URLs stay cacheable. Computed once
    // and memoised by newest mtime, so it costs nothing per request.
    let _assetVer = null, _assetVerKey = '';
    const ASSET_VER_FILES = ['js/app.js', 'css/styles.css', 'index.html', 'sw.js'].map(f => path.join(STATIC_DIR, f));
    function assetVersion() {
        let newest = 0;
        for (const f of ASSET_VER_FILES) { try { newest = Math.max(newest, fs.statSync(f).mtimeMs); } catch (e) { /* missing */ } }
        const key = String(newest);
        if (_assetVer && key === _assetVerKey) return _assetVer;
        const h = crypto.createHash('sha1');
        for (const f of ASSET_VER_FILES) { try { h.update(fs.readFileSync(f)); } catch (e) { /* missing */ } }
        _assetVer = h.digest('hex').slice(0, 8);
        _assetVerKey = key;
        return _assetVer;
    }
    function sendTemplated(res, file, contentType) {
        fs.readFile(file, 'utf8', (err, body) => {
            if (err) { res.status(404).end(); return; }
            res.set('Content-Type', contentType);
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.send(body.split('__ASSETVER__').join(assetVersion()));
        });
    }
    // These three carry the version token, so serve them templated + uncacheable
    // (registered before express.static so they win over the raw files).
    app.get(['/', '/index.html'], (req, res) => sendTemplated(res, path.join(STATIC_DIR, 'index.html'), 'text/html; charset=utf-8'));
    app.get('/sw.js', (req, res) => sendTemplated(res, path.join(STATIC_DIR, 'sw.js'), 'text/javascript; charset=utf-8'));

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