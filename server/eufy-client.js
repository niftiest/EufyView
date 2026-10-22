/**
 * Eufy Security Client Module
 * 
 * Manages connection to Eufy Security system and provides:
 * - Device and station discovery and management
 * - Live streaming control
 * - Event handling and broadcasting
 * - WebSocket API command handlers
 * - Snapshot management and updates
 */

const utils = require('./utils');

const { EufySecurity, AudioCodec, VideoCodec, LogLevel, DeviceType } = require('eufy-security-client');
const eufyVersion = require('eufy-security-client/package.json').version;

const transcode = require('./transcode');
const snapshotGrabber = require('./snapshot-grabber');
const rtspStream = require('./rtsp-stream');
const wsApi = require('./ws-api');
const push = require('./push');
const auth = require('./auth');
const history = require('./history');
const events = require('./events');

history.init({
    getClient: () => eufyClient,
    // A clip download shares the station's P2P session with live view
    isStationBusy: (stationSN) => {
        if (snapshotStations.has(stationSN)) return true;
        if (!currentStreamingSN || !eufyClient) return false;
        for (const d of devices) {
            if (d.getSerial() === currentStreamingSN) return d.getStationSerial() === stationSN;
        }
        return false;
    }
});

// Detection events that generate a background push notification (with a
// human-readable label). Repeated events per camera are throttled in push.js.
const PUSH_EVENTS = {
    'motion detected': 'Motion detected',
    'person detected': 'Person detected',
    'pet detected': 'Pet detected',
    'vehicle detected': 'Vehicle detected',
    'crying detected': 'Crying detected',
    'sound detected': 'Sound detected',
    'rings': 'Doorbell ring',
    'stranger person detected': 'Stranger detected',
    'dog detected': 'Dog detected',
    'package delivered': 'Package delivered',
    'package taken': 'Package taken',
    'someone loitering': 'Someone loitering'
};

// State management
let eufyClient = null;                      // EufySecurity client instance
let wsEvnentHandlersRegistered = false;     // Flag to prevent duplicate handler registration
let currentStreamingSN = null;              // Serial number of currently streaming device
let stations = new Set();                   // Set of discovered stations
let devices = new Set();                    // Set of discovered devices

// Auto-reconnect state
let reconnectAttempt = 0;
let reconnectTimer = null;
let lastEufyConfig = null;

// Detection-derived push: the HomeBase delivers a fresh event snapshot per
// detection (real-time, via P2P) even though this library never surfaces the
// motion/person boolean for these cameras. We fire a push when a camera's
// `picture` property updates. Armed a short while after connect so the library's
// initial thumbnail fetches on startup don't trigger false alerts.
let detectionPushReady = false;
let detectionPushTimer = null;
let cloudPollTimer = null;            // periodic refreshCloudData() fallback for new events
const lastEventThumb = {};            // device serial -> last event thumbnail (dedup the poll path)
const CLOUD_POLL_MS = 45000;          // how often to poll the cloud (fallback path)

// Unified detection notification + dedup. Both the real-time P2P path and the
// cloud-poll fallback funnel through here so the same detection notifies once.
const lastNotifiedAt = {};            // "serial:type" -> last notify time (ms)
const lastP2PAt = {};                 // serial -> last P2P detection (ms); suppresses poll dupes
const DETECTION_DEDUP_MS = 90000;     // collapse repeats / P2P-instant + poll-later into one

// HomeBase P2P event_type → { event, label }. Codes match the library's
// HB3PairedDevicePushEvent (3101-3112) and the official app's event list
// ("Motion Detected", "Ring", "Stranger"). `event` names are the ones the PWA
// keys its timeline icons/colors on.
const EVENT_TYPES = {
    3101: { event: 'motion detected',   label: 'Motion detected' },
    3102: { event: 'person detected',   label: 'Person detected' },
    3103: { event: 'ring',              label: 'Doorbell ring' },
    3104: { event: 'crying detected',   label: 'Crying detected' },
    3105: { event: 'sound detected',    label: 'Sound detected' },
    3106: { event: 'pet detected',      label: 'Pet detected' },
    3107: { event: 'vehicle detected',  label: 'Vehicle detected' },
    3108: { event: 'dog detected',      label: 'Dog detected' },
    3109: { event: 'dog lick detected', label: 'Dog lick detected' },
    3110: { event: 'dog poop detected', label: 'Dog poop detected' },
    3111: { event: 'familiar face',     label: 'Familiar face detected' },
    3112: { event: 'stranger detected', label: 'Stranger detected' },
};

// Library event names → the canonical names above (the library says "rings"
// and "stranger person detected"; the PWA and push prefs use the short forms).
const LIB_EVENT_NAMES = {
    'rings': 'ring',
    'stranger person detected': 'stranger detected',
};

// Single funnel for every detection source (library events, P2P 2037, cloud
// poll): dedups per camera+type, broadcasts to open PWAs for the timeline, and
// sends the background push. `event` must be type-specific so push.js's
// per-(camera,event) cooldown can't swallow a ring that follows a person alert.
function notifyDetection(serialNumber, cameraName, event, label, eventType) {
    if (!serialNumber) return;
    const now = Date.now();
    const key = serialNumber + ':' + event;
    if (lastNotifiedAt[key] && now - lastNotifiedAt[key] < DETECTION_DEDUP_MS) return;
    lastNotifiedAt[key] = now;
    // Unknown codes keep a [type N] suffix so they can still be mapped from the phone
    const title = (eventType != null && !EVENT_TYPES[eventType]) ? `${label} [type ${eventType}]` : label;
    events.record({ serialNumber, cameraName: cameraName || serialNumber, event, label: title });
    wsApi.wsBroadcast({
        type: 'event',
        event: { source: 'device', event, serialNumber, state: true, label: title }
    });
    push.notify({
        serialNumber,
        cameraName: cameraName || serialNumber,
        event,
        label: title
    });
}

// Real-time detection: the HomeBase pushes the event over P2P as a
// CMD_NOTIFY_PAYLOAD with cmd 2037, carrying device_sn / name / event_type /
// trigger_time. The library logs but doesn't parse it ("Not implemented 2"), so
// we pull it out of the logger stream. Instant and typed — no cloud-poll lag.
function handleP2PDetection(args) {
    for (const x of args) {
        if (!x || typeof x !== 'object' || typeof x.payload !== 'string') continue;
        if (x.payload.indexOf('"cmd":2037') === -1) continue;
        let inner = null;
        try {
            const outer = JSON.parse(x.payload);
            if (outer.cmd !== 2037) continue;
            inner = typeof outer.payload === 'string' ? JSON.parse(outer.payload) : outer.payload;
        } catch (e) {
            // Some payloads carry trailing binary; fall back to regex extraction.
            const sn = (x.payload.match(/device_sn\\?"?\s*:\s*\\?"?([A-Z0-9]+)/) || [])[1];
            const nm = (x.payload.match(/\\?"name\\?"\s*:\s*\\?"([^"\\]+)/) || [])[1];
            const et = parseInt((x.payload.match(/event_type\\?"?\s*:\s*([0-9]+)/) || [])[1], 10);
            if (sn) inner = { device_sn: sn, name: nm, event_type: et };
        }
        if (inner && inner.device_sn) {
            const type = EVENT_TYPES[inner.event_type] || { event: 'motion detected', label: 'Motion detected' };
            let label = type.label;
            const person = inner.nick_name || inner.person_name;
            if (inner.event_type === 3111 && person) label = `${person} detected`;
            // Clean, greppable code log — captures EVERY detection's event_type
            // (even ones deduped/pre-arm) so we can map codes → types.
            utils.log(`🔍 DETECTION cam="${inner.name || inner.device_sn}" event_type=${inner.event_type} label="${label}"`, 'info');
            if (detectionPushReady) {
                lastP2PAt[inner.device_sn] = Date.now();   // mark P2P covered this camera
                notifyDetection(inner.device_sn, inner.name, type.event, label, inner.event_type);
                requestEventPicture(inner.device_sn);
            }
        }
    }
}

// Event thumbnail for notifications: after a HomeBase detection, ask the
// station (over P2P, no cloud round-trip) for its latest event record. The
// library turns the returned cover path into a `picture` download, and the
// property-changed handler hands the new picture to push.attachThumbnail().
// Asked twice because the HomeBase may still be writing the snapshot.
const EVENT_PICTURE_DELAYS_MS = [3000, 10000];
const pictureRequestTimers = {};      // serial -> [timeouts]
const lastPictureHash = {};           // serial -> md5 of last seen picture

// "Refresh all thumbnails" sweep
const SNAPSHOT_KEYFRAME_TIMEOUT_MS = 12000;   // healthy cameras measured 4-7s to first picture
const SNAPSHOT_CONNECT_WAIT_MS = 5000;        // reconnect grace for a station that's dropped
const SNAPSHOT_STATION_GAP_MS = 1500;         // pause between two cameras on the same station
let snapshotAllRunning = false;
const snapshotGrabbers = new Map();           // device serial -> grabber factory awaiting that camera's stream
const snapshotStations = new Set();           // stations a refresh is currently streaming from

function requestEventPicture(deviceSN) {
    (pictureRequestTimers[deviceSN] || []).forEach(clearTimeout);
    pictureRequestTimers[deviceSN] = EVENT_PICTURE_DELAYS_MS.map(ms => setTimeout(async () => {
        try {
            const device = await eufyClient.getDevice(deviceSN);
            const station = await eufyClient.getStation(device.getStationSerial());
            // HomeBase 3 / S380 doesn't answer the latest-info query (see history.js),
            // so pull its new event picture through the cloud instead.
            if (station.hasCommand('stationDatabaseQueryLatestInfo') && station.getDeviceType() !== DeviceType.HB3) {
                station.databaseQueryLatestInfo();
            } else {
                await eufyClient.refreshCloudData();
            }
        } catch (e) {
            utils.log(`🖼️ Event picture request failed for ${deviceSN}: ${e.message}`, 'debug');
        }
    }, ms));
}

// Talkback state
let talkbackDeviceSN = null;
let talkbackFFmpeg = null;

/**
 * Snapshot Saved Event Handler
 * Triggered when transcode module saves a new snapshot to disk.
 * Loads the snapshot and broadcasts it to all WebSocket clients.
 */
transcode.event.on('snapshotSaved', (deviceSN) => broadcastSnapshot(deviceSN));

/**
 * Broadcast Snapshot
 * Sends a camera's saved snapshot from disk to all WebSocket clients
 * as a picture property change.
 * @param {string} deviceSN - Device serial number
 */
function broadcastSnapshot(deviceSN) {
    const jpg = utils.loadSnapshotFromDisk(deviceSN);
    if (!jpg) {
        utils.log(`❌ Failed to load snapshot from disk for device: ${deviceSN}`, 'warn');
        return;
    }

    // Broadcast updated snapshot to all WebSocket clients
    wsApi.wsBroadcast({
        "type": "event",
        "event": {
            "source": "device",
            "event": "property changed",
            "serialNumber": deviceSN,
            "name": "picture",
            "value": {
                "data": {
                    "type": "Buffer",
                    "data": Array.from(jpg)
                }, "type": {
                    "ext": "jpg",
                    "mime": "image/jpeg"
                },
                "isSnapshot": true,
                "isRecent": "snapshot"
            }
        }
    });

    utils.log(`📡 Broadcasted snapshot update for device: ${deviceSN}`, 'debug');
}

/**
 * Connect to Eufy Security System
 * Initializes the Eufy Security client and registers all event handlers
 * @param {Object} eufyConfig - Configuration object with username, password, country, etc.
 */
async function connect(eufyConfig) {
    try {
        utils.log('Initializing Eufy Security Client...', 'info');

        // Prevent duplicate connections
        if (eufyClient && eufyClient.isConnected()) {
            utils.log('✓ Eufy client is already connected.', 'warn');
            return;
        }

        // Validate required configuration parameters
        if (eufyConfig.username && eufyConfig.password && eufyConfig.persistentDir && eufyConfig.country && eufyConfig.language) {
            // Store config for reconnection
            lastEufyConfig = eufyConfig;

            // Initialize Eufy Security client.
            // Pass a logger so the library's internal push-registration /
            // device-readiness flow is visible (diagnosing why cloud detection
            // pushes never arrive). Forwarded into our captured stdout log.
            const fmt = (args) => {
                try {
                    return args.map(x => (x && typeof x === 'object') ? JSON.stringify(x) : String(x)).join(' ');
                } catch (e) { return args.map(String).join(' '); }
            };
            const libLogger = {
                trace: (...a) => utils.log('[lib] ' + fmt(a), 'trace'),
                debug: (...a) => { handleP2PDetection(a); utils.log('[lib] ' + fmt(a), 'debug'); },
                info:  (...a) => utils.log('[lib] ' + fmt(a), 'debug'),
                warn:  (...a) => utils.log('[lib] ' + fmt(a), 'warn'),
                error: (...a) => utils.log('[lib] ' + fmt(a), 'error'),
            };
            // The library gates its output behind config.logging.level (default
            // silent), so set a verbose level to actually see the push flow.
            eufyConfig.logging = { level: LogLevel.Debug };
            eufyClient = await EufySecurity.initialize(eufyConfig, libLogger);

            /**
             * Connection Event Handlers
             * Register handlers for connection lifecycle events
             */
            eufyClient.on('connect', () => {
                utils.log('✓ Successfully connected to Eufy!', 'info');
                reconnectAttempt = 0;
                // Arm detection-based push after the startup thumbnail fetches settle
                detectionPushReady = false;
                if (detectionPushTimer) clearTimeout(detectionPushTimer);
                detectionPushTimer = setTimeout(() => {
                    detectionPushReady = true;
                    utils.log('🔔 Detection-based push notifications armed', 'info');
                }, 60000);

                // Real-time P2P/FCM event delivery is unreliable for this setup
                // (P2P station timeouts, unparsed CMD_NOTIFY_PAYLOAD, no FCM), so
                // poll the cloud periodically. Each refresh updates each camera's
                // latest event thumbnail (hidden-pictureUrl); the property-changed
                // handler turns a *new* thumbnail into a push. ~poll-interval latency.
                if (cloudPollTimer) clearInterval(cloudPollTimer);
                cloudPollTimer = setInterval(() => {
                    if (eufyClient && eufyClient.isConnected()) {
                        Promise.resolve(eufyClient.refreshCloudData())
                            .catch(e => utils.log(`☁️ Cloud refresh error: ${e.message}`, 'warn'));
                    }
                }, CLOUD_POLL_MS);
                // Register WebSocket API handlers once connection is established
                registerWebSocketHandlers();
                // Broadcast reconnected event if this was a reconnection
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }
                wsApi.wsBroadcast({
                    type: 'event',
                    event: { source: 'system', event: 'eufy connected' }
                });
            });

            eufyClient.on("connection error", (error) => {
                utils.log('❌ Eufy connection error: ' + error, 'error');
                stations.clear();
                devices.clear();
                scheduleReconnect();
            });

            eufyClient.on("push connect", () => {
                utils.log('🔌 Eufy push connection established.', 'debug');
            });

            eufyClient.on("push close", () => {
                utils.log('⚠️ Eufy push connection closed.', 'warn');
            });

            eufyClient.on("close", () => {
                utils.log('⚠️ Connection to Eufy closed.', 'warn');
                stations.clear();
                devices.clear();
                scheduleReconnect();
            });

            /**
             * Device and Station Discovery Events
             * Handle addition and removal of stations and devices
             */
            eufyClient.on('station added', (station) => {
                addStation(station);
            });

            eufyClient.on("station removed", (station) => {
                stations.delete(station);
                utils.log(`⚠️ Station removed: ${station.getName()} (${station.getSerial()})`, 'warn');
            });

            eufyClient.on('device added', (device) => {
                addDevice(device)
            });

            eufyClient.on("device removed", (device) => {
                devices.delete(device);
                utils.log(`⚠️ Device removed: ${device.getName()} (${device.getSerial()})`, 'warn');
            });

            // Note: SDK "houses" event is internal-only (not re-emitted).
            // We read eufyClient.houses directly in start_listening instead.

            /**
             * Livestream Events
             * Handle video/audio stream data and forward to transcoding module
             */
            eufyClient.on("station livestream start", (station, device, metadata, videostream, audiostream) => {
                utils.log(`▶️ Livestream started for station: ${station.getName()}, device: ${device.getName()} (${device.getSerial()})`, 'debug');

                // A thumbnail refresh for this camera takes its video instead of live view
                const pendingSnapshot = snapshotGrabbers.get(device.getSerial());
                if (pendingSnapshot) {
                    const grabber = pendingSnapshot(VideoCodec[metadata.videoCodec]);
                    videostream.on("data", (chunk) => grabber.write(chunk));
                    audiostream.resume();   // not needed; keep it drained
                    return;
                }

                // Forward video chunks to transcoder with metadata
                videostream.on("data", (chunk) => {
                    utils.log(`📹 Video chunk received - Size: ${chunk.length} bytes`, 'trace');
                    transcode.handleVideoData(chunk, {
                        videoCodec: VideoCodec[metadata.videoCodec],
                        videoFPS: metadata.videoFPS,
                        videoHeight: metadata.videoHeight,
                        videoWidth: metadata.videoWidth,
                    });
                });

                // Forward audio chunks to transcoder with metadata
                audiostream.on("data", (chunk) => {
                    utils.log(`🎵 Audio chunk received - Size: ${chunk.length} bytes`, 'trace');
                    transcode.handleAudioData(chunk, {
                        audioCodec: AudioCodec[metadata.audioCodec],
                    })
                });

            });

            eufyClient.on("station livestream stop", (station, device) => {
                utils.log(`⏹️ Livestream stopped for station: ${station.getName()}, device: ${device.getName()} (${device.getSerial()})`, 'debug');
            });

            /**
             * Talkback Events
             * Handle two-way audio talkback stream start/stop
             */
            eufyClient.on("station talkback start", (station, device, talkbackStream) => {
                utils.log(`🎤 Talkback stream started for ${device.getName()} (${device.getSerial()})`, 'info');
                startTalkbackTranscode(talkbackStream);
                wsApi.wsBroadcast({
                    type: 'event',
                    event: { source: 'station', event: 'talkback start', serialNumber: device.getSerial() }
                });
            });

            eufyClient.on("station talkback stop", (station, device) => {
                utils.log(`🎤 Talkback stream stopped for ${device.getName()} (${device.getSerial()})`, 'info');
                stopTalkbackTranscode();
                wsApi.wsBroadcast({
                    type: 'event',
                    event: { source: 'station', event: 'talkback stop', serialNumber: device.getSerial() }
                });
            });

            /**
             * Recording Download Events (History viewer)
             * The station streams a recorded clip over P2P; history.js saves and muxes it.
             */
            eufyClient.on("station download start", (station, device, metadata, videostream, audiostream) => {
                utils.log(`⬇️ Recording download started: ${device.getName()} (${device.getSerial()})`, 'debug');
                history.onDownloadStart(station, device, metadata, videostream, audiostream);
            });

            eufyClient.on("station download finish", (station, device) => {
                utils.log(`✅ Recording download finished: ${device.getName()} (${device.getSerial()})`, 'debug');
                history.onDownloadFinish(station, device);
            });

            /**
             * Station Image Download Event
             * Broadcasts downloaded images to WebSocket clients
             */
            eufyClient.on("station database query by date", (station, returnCode, data) => {
                history.onDatabaseQueryByDate(station, returnCode, data);
            });

            eufyClient.on("station image download", (station, file, image) => {
                utils.log(`🖼️ Image downloaded from station: ${station.getName()} (${station.getSerial()}) - File: ${file}`, 'debug');
                // Recording thumbnails requested by the history viewer go only to it
                if (history.isPendingThumb(file)) { history.onImageDownload(station, file, image); return; }

                // Broadcast image to all connected clients
                wsApi.wsBroadcast({
                    type: 'event',
                    event: {
                        source: "station",
                        event: 'image downloaded',
                        serialNumber: station.getSerial(),
                        file: file,
                        image: image
                    }
                });
            });

            // Establish connection to Eufy cloud
            await eufyClient.connect();
        } else {
            throw new Error('Eufy configuration parameters are missing. Please check the settings.');
        }
    } catch (error) {
        utils.log('❌ Error during initialization: ' + error.message, 'error');
    }
}

/**
 * Add Device
 * Registers a newly discovered device and sets up all event handlers
 * Broadcasts device events to WebSocket clients for real-time notifications
 * @param {Device} device - Eufy device object
 */
function addDevice(device) {
    utils.log('📷 Device found: ' + device.getName() + ' (' + device.getSerial() + ')', 'debug');
    devices.add(device);

    /**
     * Background Push Notifications
     * Register a lightweight listener for each push-worthy detection event.
     * These run alongside the existing WS-broadcast handlers and fire even when
     * no client app is open. Throttling/prefs are handled in push.js.
     */
    for (const [evName, label] of Object.entries(PUSH_EVENTS)) {
        device.on(evName, (dev, state) => {
            if (state) {
                notifyDetection(dev.getSerial(), dev.getName(), LIB_EVENT_NAMES[evName] || evName, label);
            }
        });
    }

    /**
     * Device Event Handlers
     * Register handlers for all device events and broadcast to WebSocket clients
     */

    // Motion detection event
    device.on("motion detected", (device, state) => {
        utils.log(`Motion detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'motion detected',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Person detection event
    device.on("person detected", (device, state, person) => {
        utils.log(`Person detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state} - Person: ${person ? person : 'unknown'}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'person detected',
                serialNumber: device.getSerial(),
                state: state,
                person: person ? person : 'unknown'
            }
        });
    });

    // Audio detection events
    device.on("crying detected", (device, state) => {
        utils.log(`Crying detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'crying detected',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Pet detection event
    device.on("pet detected", (device, state) => {
        utils.log(`Pet detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'pet detected',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Vehicle detection event
    device.on("vehicle detected", (device, state) => {
        utils.log(`Vehicle detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'vehicle detected',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // General sound detection event
    device.on("sound detected", (device, state) => {
        utils.log(`Sound detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'sound detected',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Doorbell ring event
    device.on("rings", (device, state) => {
        utils.log(`Doorbell rang on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'rings',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Package delivery events
    device.on("package delivered", (device, state) => {
        utils.log(`Package delivered detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'package delivered',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });
    device.on("package stranded", (device, state) => {
        utils.log(`Package stranded detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'package stranded',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });
    device.on("package taken", (device, state) => {
        utils.log(`Package taken detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'package taken',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Loitering detection event
    device.on("someone loitering", (device, state) => {
        utils.log(`Loitering detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'someone loitering',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Radar motion detection event
    device.on("radar motion detected", (device, state) => {
        utils.log(`Radar motion detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'radar motion detected',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Door/window open event
    device.on("open", (device, state) => {
        utils.log(`Open event on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'open',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Alarm events
    device.on("911 alarm", (device, state, detail) => {
        utils.log(`911 alarm on device: ${device.getName()} (${device.getSerial()}) - State: ${state} - Detail: ${detail}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: '911 alarm',
                serialNumber: device.getSerial(),
                state: state,
                detail: detail
            }
        });
    });
    device.on("shake alarm", (device, state, detail) => {
        utils.log(`Shake alarm on device: ${device.getName()} (${device.getSerial()}) - State: ${state} - Detail: ${detail}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'shake alarm',
                serialNumber: device.getSerial(),
                state: state,
                detail: detail
            }
        });
    });
    device.on("wrong try-protect alarm", (device, state) => {
        utils.log(`Wrong try-protect alarm on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'wrong try-protect alarm',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Lock-related events
    device.on("long time not close", (device, state) => {
        utils.log(`Long time not close alarm on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'long time not close',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });
    device.on("jammed", (device, state) => {
        utils.log(`Jammed alarm on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'jammed',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Battery status event
    device.on("low battery", (device, state) => {
        utils.log(`Low battery on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'low battery',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Lock state changed event
    device.on("locked", (device, state) => {
        utils.log(`Locked state changed on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'locked',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // AI-based detection events
    device.on("stranger person detected", (device, state) => {
        utils.log(`Stranger person detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'stranger person detected',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });
    device.on("dog detected", (device, state) => {
        utils.log(`Dog detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'dog detected',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });
    device.on("dog lick detected", (device, state) => {
        utils.log(`Dog lick detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'dog lick detected',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });
    device.on("dog poop detected", (device, state) => {
        utils.log(`Dog poop detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'dog poop detected',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    /**
     * Property Changed Event
     * Handles property changes on device and updates clients
     * Special handling for picture property to provide latest snapshots
     */
    device.on("property changed", (device, name, value, ready) => {
        // Detection-derived background push: a new event thumbnail means a
        // detection just occurred. `hidden-pictureUrl` updates on every event for
        // BOTH HomeBase (P2P path) and cloud (S3 URL) cameras, so it's the
        // universal signal — used because this library never surfaces the
        // motion/person=true boolean for these cameras. Armed after startup
        // (detectionPushReady) so the initial thumbnail loads don't alert.
        if (name === 'hidden-pictureUrl' && value) {
            const sn = device.getSerial();
            // Dedup on the URL PATH only — S3 signed thumbnail URLs get a fresh
            // ?X-Amz-Signature on every fetch, so the full string changes each
            // poll. The path/object-key is stable per actual event.
            const key = String(value).split('?')[0];
            const changed = lastEventThumb[sn] !== key;
            lastEventThumb[sn] = key;   // track baseline even before armed
            if (detectionPushReady && changed) {
                // Fallback path (cloud-poll). Skip cameras that get real-time P2P
                // detections (they're already covered, and more accurately typed).
                if (Date.now() - (lastP2PAt[sn] || 0) >= DETECTION_DEDUP_MS) {
                    notifyDetection(sn, device.getName(), 'activity detected', 'Activity detected');
                }
            }
        }

        // A genuinely new event picture → thumbnail for a pending notification
        if (name === 'picture' && value && value.data && value.data.length) {
            const sn = device.getSerial();
            const hash = utils.generateChecksum(value.data);
            if (lastPictureHash[sn] !== hash) {
                lastPictureHash[sn] = hash;
                events.attachSnapshot(sn, value.data);
                if (push.attachThumbnail(sn, value.data, value.type && value.type.mime)) {
                    (pictureRequestTimers[sn] || []).forEach(clearTimeout);
                }
            }
        }

        if (ready && !name.startsWith("hidden-")) {
            utils.log(`Property changed on device: ${device.getName()} (${device.getSerial()}) - ${name}: ${JSON.stringify(value)}`, 'debug');

            // Check if a newer snapshot is available for picture property
            value = checkDevicePictureProperty(device.getSerial(), value);

            wsApi.wsBroadcast({
                type: 'event',
                event: {
                    source: "device",
                    event: 'property changed',
                    serialNumber: device.getSerial(),
                    name: name,
                    value: value
                }
            });

        } else utils.log(`Property changed on device: ${device.getName()} (${device.getSerial()}) - ${name}: ${JSON.stringify(value)} (not ready)`, 'debug');
    });

    // Tampering detection event
    device.on("tampering", (device, state) => {
        utils.log(`Tampering detected on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'tampering',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Temperature warning events
    device.on("low temperature", (device, state) => {
        utils.log(`📉 Low temperature on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'low temperature',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });
    device.on("high temperature", (device, state) => {
        utils.log(`📈 High temperature on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'high temperature',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Smart lock specific events
    device.on("pin incorrect", (device, state) => {
        utils.log(`❌ Incorrect PIN entered on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'pin incorrect',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Lid/cover stuck event (e.g., pet feeder)
    device.on("lid stuck", (device, state) => {
        utils.log(`⚠️ Lid stuck on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'lid stuck',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });

    // Battery fully charged event
    device.on("battery fully charged", (device, state) => {
        utils.log(`🔋 Battery fully charged on device: ${device.getName()} (${device.getSerial()}) - State: ${state}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "device",
                event: 'battery fully charged',
                serialNumber: device.getSerial(),
                state: state
            }
        });
    });
}

/**
 * Add Station
 * Registers a newly discovered station and sets up all event handlers
 * Broadcasts station events to WebSocket clients for real-time notifications
 * @param {Station} station - Eufy station object
 */
function addStation(station) {
    utils.log('🏠 Station found: ' + station.getName() + ' (' + station.getSerial() + ')', 'debug');
    stations.add(station);

    /**
     * Station Event Handlers
     * Register handlers for all station events and broadcast to WebSocket clients
     */

    // Station connection events
    station.on("connect", () => {
        utils.log(`✓ Station connected: ${station.getName()} (${station.getSerial()})`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "station",
                event: 'connect',
                serialNumber: station.getSerial()
            }
        });
    });
    station.on("close", () => {
        utils.log(`⚠️ Station connection closed: ${station.getName()} (${station.getSerial()})`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "station",
                event: 'close',
                serialNumber: station.getSerial()
            }
        });
    });
    station.on("connection error", () => {
        utils.log(`❌ Station connection error: ${station.getName()} (${station.getSerial()})`, 'warn');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "station",
                event: 'connection error',
                serialNumber: station.getSerial()
            }
        });
    });

    // Station mode change events
    station.on("guard mode", (station, guardMode) => {
        utils.log(`Station guard mode changed: ${station.getName()} (${station.getSerial()}) - Guard Mode: ${guardMode}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "station",
                event: 'guard mode',
                serialNumber: station.getSerial(),
                guardMode: guardMode
            }
        });
    });
    station.on("current mode", (station, currentMode) => {
        utils.log(`Station current mode changed: ${station.getName()} (${station.getSerial()}) - Current Mode: ${currentMode}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "station",
                event: 'current mode',
                serialNumber: station.getSerial(),
                currentMode: currentMode
            }
        });
    });

    // Alarm event
    station.on("alarm event", (station, alarmEvent) => {
        utils.log(`Station alarm event: ${station.getName()} (${station.getSerial()}) - Alarm Event: ${alarmEvent}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "station",
                event: 'alarm event',
                serialNumber: station.getSerial(),
                alarmEvent: alarmEvent
            }
        });
    });

    // RTSP stream URL event
    station.on("rtsp url", (station, channel, value) => {
        utils.log(`Station RTSP URL received: ${station.getName()} (${station.getSerial()}) - Channel: ${channel} - URL: ${value}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "station",
                event: 'rtsp url',
                serialNumber: station.getSerial(),
                channel: channel,
                value: value
            }
        });
    });

    /**
     * Command Result Event
     * Handles results from station commands
     * Special handling for livestream stop (1004) to restart if clients still connected
     */
    station.on("command result", (station, result) => {
        utils.log(`Station command result: ${station.getName()} (${station.getSerial()}) - ${JSON.stringify(result)}`, 'debug');

        // Handle livestream stop command (e.g., due to resolution change)
        if (result.command_type === 1004 && currentStreamingSN) {
            // Handle livestream_stop forced by station
            if (utils.getActiveStreamClients().size !== 0) {
                // TODO: works not yet properly, needs testing and fixing - perhaps better to close all clients instead? so they can reconnect properly

                utils.log('⚠️ Warning: Livestream stopped, but there are still active clients', 'warn');
                utils.log(`   Active clients: ${utils.getActiveStreamClients().size}`, 'debug');
                utils.log(`   Current device: ${currentStreamingSN}`, 'debug');
                utils.log(`   FFmpeg transcoding active: ${transcode.isTranscoding}`, 'debug');
                utils.log(`   Has init segment: ${transcode.hasInitSegment}`, 'debug');

                // transcode.clearMetadata();
                startStreamForDevice(currentStreamingSN);

                // setTimeout(() => {
                //     utils.log('🔄 Restarting livestream for device after stop command...', 'info');
                //     // transcode.clearMetadata();
                //     startStreamForDevice(currentStreamingSN);
                // }, 1000);

                utils.log(`🔄 Stream restart initiated at ${Date.now()}`, 'debug');
            }
        }

        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "station",
                event: 'command result',
                serialNumber: station.getSerial(),
                command: result.command_type,
                returnCode: result.return_code,
                customData: result.customData
            }
        });
    });

    /**
     * Property Changed Event
     * Handles property changes on station and updates clients
     */
    station.on("property changed", (station, name, value, ready) => {
        if (ready && !name.startsWith("hidden-")) {
            utils.log(`Property changed on station: ${station.getName()} (${station.getSerial()}) - ${name}: ${JSON.stringify(value)}`, 'debug');
            wsApi.wsBroadcast({
                type: 'event',
                event: {
                    source: "station",
                    event: 'property changed',
                    serialNumber: station.getSerial(),
                    name: name,
                    value: value
                }
            });
        } else utils.log(`Property changed on station: ${station.getName()} (${station.getSerial()}) - ${name}: ${JSON.stringify(value)} (not ready)`, 'debug');
    });

    // Alarm delay events
    station.on("alarm delay event", (station, alarmDelayEvent, alarmDelay) => {
        utils.log(`Station alarm delay event: ${station.getName()} (${station.getSerial()}) - Event: ${alarmDelayEvent} - Delay: ${alarmDelay}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "station",
                event: 'alarm delay event',
                serialNumber: station.getSerial(),
                alarmDelayEvent: alarmDelayEvent,
                alarmDelay: alarmDelay
            }
        });
    });
    station.on("alarm armed event", (station) => {
        utils.log(`Station alarm armed: ${station.getName()} (${station.getSerial()})`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "station",
                event: 'alarm armed event',
                serialNumber: station.getSerial()
            }
        });
    });
    station.on("alarm arm delay event", (station, armDelay) => {
        utils.log(`Station alarm arm delay event: ${station.getName()} (${station.getSerial()}) - Delay: ${armDelay}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "station",
                event: 'alarm arm delay event',
                serialNumber: station.getSerial(),
                armDelay: armDelay
            }
        });
    });

    // Device PIN verification event
    station.on("device pin verified", (deviceSN, successfull) => {
        utils.log(`Device PIN verified: ${deviceSN} - Successful: ${successfull}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "station",
                event: 'device pin verified',
                serialNumber: station.getSerial(),
                deviceSN: deviceSN,
                successful: successfull
            }
        });
    });

    // Database query events
    station.on("database query latest", (station, returnCode, data) => {
        utils.log(`Database query latest on station: ${station.getName()} (${station.getSerial()}) - Return Code: ${returnCode} - Data: ${JSON.stringify(data)}`, 'debug');
        wsApi.wsBroadcast({
            type: 'event',
            event: {
                source: "station",
                event: 'database query latest',
                serialNumber: station.getSerial(),
                data: data
            }
        });
    });
    // station.on("database query local", (station, returnCode, data) => {
    //     utils.log(`Database query local on station: ${station.getName()} (${station.getSerial()}) - Return Code: ${returnCode} - Data: ${JSON.stringify(data)}`, 'info');
    // });
    // station.on("database count by date", (station, returnCode, data) => {
    //     utils.log(`Database count by date on station: ${station.getName()} (${station.getSerial()}) - Return Code: ${returnCode} - Data: ${JSON.stringify(data)}`, 'info');
    // });
    // station.on("database delete", (station, returnCode, failedIds) => {
    //     utils.log(`Database delete on station: ${station.getName()} (${station.getSerial()}) - Return Code: ${returnCode} - Failed IDs: ${failedIds.join(', ')}`, 'info');
    // });
}

/**
 * Start Stream for Device
 * Initiates livestream for specified device serial number
 * Checks connection status and prevents duplicate streams
 * @param {string} serialNumber - Device serial number to start streaming
 */
async function startStreamForDevice(serialNumber) {
    currentStreamingSN = null;

    // Verify Eufy client is connected
    if (!isConnected()) {
        utils.log('❌ Eufy client is not connected. Cannot start livestream.', 'error');
        return;
    }

    utils.log(`📲 Starting livestream for device: ${serialNumber}`, 'debug');
    const device = await eufyClient.getDevice(serialNumber);
    const station = await eufyClient.getStation(device.getStationSerial());

    // Check if stream is already active
    if (station.isLiveStreaming(device)) {
        utils.log(`ℹ️ Livestream for device ${device.getName()} (${device.getSerial()}) is already active.`, 'warn');
        currentStreamingSN = serialNumber;
        return;
    }

    station.startLivestream(device);
    currentStreamingSN = serialNumber;
    utils.log(`▶️ Livestream request sent for device: ${device.getName()} (${device.getSerial()})`, 'info');
}

/**
 * Stop Stream for Device
 * Stops active livestream for specified device serial number
 * @param {string} serialNumber - Device serial number to stop streaming
 */
async function stopStreamForDevice(serialNumber) {
    // Verify Eufy client is connected
    if (!isConnected()) {
        utils.log('❌ Eufy client is not connected. Cannot stop livestream.', 'error');
        return;
    }

    utils.log(`📲 Stopping livestream for device: ${serialNumber}`, 'debug');
    const device = await eufyClient.getDevice(serialNumber);
    const station = await eufyClient.getStation(device.getStationSerial());

    // Check if stream is actually active
    if (!station.isLiveStreaming(device)) {
        utils.log(`ℹ️ Livestream for device ${device.getName()} (${device.getSerial()}) is not active, no stop required.`, 'warn');
        return;
    }

    station.stopLivestream(device);
    currentStreamingSN = null;
    utils.log(`⏹️ Livestream stop request sent for device: ${device.getName()} (${device.getSerial()})`, 'info');
}

/**
 * Start Frame Stream for Device (Data Saver)
 * Starts the device livestream but routes the video into the MJPEG frame
 * pipeline instead of the fMP4 stream. Mutually exclusive with normal streaming.
 * @param {string} serialNumber - Device serial number
 */
async function startFrameStreamForDevice(serialNumber) {
    if (!isConnected()) {
        utils.log('❌ Eufy client is not connected. Cannot start frame stream.', 'error');
        return;
    }

    const device = await eufyClient.getDevice(serialNumber);
    const station = await eufyClient.getStation(device.getStationSerial());

    // Switch the transcoder into frame mode before any video arrives
    transcode.currentDevice = serialNumber;
    transcode.startFrameMode();

    if (station.isLiveStreaming(device)) {
        utils.log(`ℹ️ Livestream for ${device.getName()} (${serialNumber}) already active, reusing for frames.`, 'debug');
        currentStreamingSN = serialNumber;
        return;
    }

    station.startLivestream(device);
    currentStreamingSN = serialNumber;
    utils.log(`🖼️ Frame stream request sent for device: ${device.getName()} (${serialNumber})`, 'info');
}

/**
 * Stop Frame Stream (Data Saver)
 * Stops the MJPEG pipeline and the underlying device livestream.
 */
async function stopFrameStream() {
    transcode.stopFrameMode();

    const sn = currentStreamingSN;
    currentStreamingSN = null;
    if (!sn || !isConnected()) return;

    try {
        const device = await eufyClient.getDevice(sn);
        const station = await eufyClient.getStation(device.getStationSerial());
        if (station.isLiveStreaming(device)) {
            station.stopLivestream(device);
            utils.log(`🖼️ Frame stream stopped for device: ${device.getName()} (${sn})`, 'info');
        }
    } catch (e) {
        utils.log(`⚠️ Error stopping frame stream for ${sn}: ${e.message}`, 'warn');
    }
}

/**
 * Capture Snapshot for Device
 * Starts a brief livestream and hands its video to a snapshot grabber
 * (server/snapshot-grabber.js), which writes the first complete frame to
 * data/snapshots/<sn>.jpg; then stops the stream and broadcasts the picture.
 * Doesn't touch the live-view pipeline, so cameras on different stations can
 * be captured at the same time.
 *
 * Gives up early on cameras that can't answer, so one unplugged camera
 * doesn't hold up the refresh:
 *  - its station has no P2P connection and can't get one within
 *    SNAPSHOT_CONNECT_WAIT_MS (e.g. a standalone indoor cam that's unplugged)
 *  - the library drops the stream because no video arrived (it does this ~5s
 *    after starting a camera its HomeBase can't reach)
 *  - no picture within SNAPSHOT_KEYFRAME_TIMEOUT_MS
 * The stream is always stopped afterwards, success or not.
 * @param {string} serialNumber - Device serial number
 * @returns {Promise<{ok: boolean, reason?: string, pictureMs?: number}>}
 */
async function captureSnapshotForDevice(serialNumber) {
    const device = await eufyClient.getDevice(serialNumber);

    // RTSP fast path: if this camera has a local RTSP stream enabled, grab the
    // thumbnail straight off it — no P2P, no station video slot, ~1s. Fall back
    // to the P2P path below if RTSP is off or fails.
    const rtspUrl = rtspUrlForDevice(device);
    if (rtspUrl) {
        const startedAt = Date.now();
        const ok = await rtspStream.rtspSnapshot(serialNumber, rtspUrl);
        if (ok) {
            const pictureMs = Date.now() - startedAt;
            utils.log(`📸 RTSP snapshot saved for ${serialNumber} after ${pictureMs}ms`, 'info');
            broadcastSnapshot(serialNumber);
            return { ok: true, pictureMs, via: 'rtsp' };
        }
        utils.log(`📸 RTSP snapshot failed for ${serialNumber}, falling back to P2P`, 'warn');
    }

    const station = await eufyClient.getStation(device.getStationSerial());

    // Station must be reachable before a stream can start
    if (!station.isConnected()) {
        utils.log(`📸 Snapshot capture: ${station.getName()} not connected, trying to reconnect...`, 'info');
        const connected = await new Promise((resolve) => {
            const onConnect = () => done(true);
            const timer = setTimeout(() => done(false), SNAPSHOT_CONNECT_WAIT_MS);
            function done(result) {
                clearTimeout(timer);
                station.removeListener('connect', onConnect);
                resolve(result);
            }
            station.once('connect', onConnect);
            try { station.connect(); } catch (e) { done(false); }
        });
        if (!connected) return { ok: false, reason: 'offline' };
    }

    const startedAt = Date.now();
    let grabber = null;
    let streamEnded = false;
    // The grabber is created when the stream starts (the codec is known then)
    snapshotGrabbers.set(serialNumber, (videoCodec) => {
        grabber = snapshotGrabber.startGrabber(serialNumber, videoCodec);
        return grabber;
    });
    try {
        station.startLivestream(device);
        utils.log(`📸 Snapshot capture: starting stream for ${device.getName()} (${serialNumber})`, 'info');

        // Wait for the picture, the stream ending without video, or the timeout
        const outcome = await new Promise((resolve) => {
            let settled = false;
            let watching = false;
            // The library gives up on a stream that never sent data without
            // emitting a stop event, so watch the streaming flag drop.
            let wasStreaming = false;
            const check = setInterval(() => {
                let streaming = false;
                try { streaming = station.isLiveStreaming(device); } catch (e) { /* station gone */ }
                if (streaming) wasStreaming = true;
                if (grabber && !watching) {
                    watching = true;
                    grabber.done.then((saved) => finish(saved ? null : 'no picture'));
                }
                if (wasStreaming && !streaming && !grabber) finish('no video');
                else if (Date.now() - startedAt > SNAPSHOT_KEYFRAME_TIMEOUT_MS) finish('timeout');
            }, 250);
            function finish(reason) {
                if (settled) return;
                settled = true;
                clearInterval(check);
                resolve(reason);
            }
        });
        if (outcome) {
            streamEnded = outcome === 'no video';
            return { ok: false, reason: outcome };
        }

        const pictureMs = Date.now() - startedAt;
        utils.log(`📸 Snapshot capture: picture saved for ${serialNumber} after ${pictureMs}ms`, 'info');
        broadcastSnapshot(serialNumber);
        return { ok: true, pictureMs };
    } finally {
        snapshotGrabbers.delete(serialNumber);
        if (grabber) grabber.abort();
        try {
            if (!streamEnded && station.isLiveStreaming(device)) station.stopLivestream(device);
        } catch (e) { /* station gone */ }
        // Let the station settle before its next camera
        await new Promise(r => setTimeout(r, SNAPSHOT_STATION_GAP_MS));
    }
}

/**
 * Register WebSocket Handlers
 * Registers all WebSocket API command handlers for client communication
 * Prevents duplicate registration
 */
function registerWebSocketHandlers() {
    // Prevent duplicate handler registration
    if (wsEvnentHandlersRegistered) {
        return;
    }

    /**
     * start_listening Command
     * Returns current system state with stations and devices
     */
    wsApi.registerMessageHandler('start_listening', (message, ws) => {
        if (!isConnected()) { ws.close(); }

        const { deviceHouseMap, housesData } = buildHouseMaps();

        // Scope to the connected user's allowed cameras (admins see everything).
        const scope = ws && ws._scope;
        const allowSN = (sn) => !scope || auth.isCameraAllowed(scope, sn);

        const deviceSerials = Array.from(devices).map(d => d.getSerial()).filter(allowSN);
        const allowedStationSerials = new Set(
            Array.from(devices).filter(d => allowSN(d.getSerial())).map(d => {
                try { return d.getStationSerial(); } catch (e) { return null; }
            }).filter(Boolean)
        );
        const stationSerials = Array.from(stations)
            .map(s => s.getSerial())
            .filter(sn => !scope || scope.cameras === 'all' || allowedStationSerials.has(sn));

        // Trim the house map / houses to the cameras this user can see.
        const scopedHouseMap = {};
        const visibleHouseIds = new Set();
        for (const sn of deviceSerials) {
            if (deviceHouseMap[sn]) { scopedHouseMap[sn] = deviceHouseMap[sn]; visibleHouseIds.add(deviceHouseMap[sn]); }
        }
        const scopedHouses = {};
        for (const [id, data] of Object.entries(housesData)) {
            if (!scope || scope.cameras === 'all' || visibleHouseIds.has(id)) scopedHouses[id] = data;
        }

        utils.log(`🏠 start_listening for ${scope ? (scope.email || 'admin') : 'local'}: ${deviceSerials.length} device(s)`, 'debug');

        return {
            type: 'result',
            messageId: 'start_listening',
            success: isConnected(),
            result: {
                state: {
                    client: {
                        version: eufyVersion,
                    },
                    stations: stationSerials,
                    devices: deviceSerials,
                    houses: scopedHouses,
                    deviceHouseMap: scopedHouseMap
                }
            }
        };
    });

    /**
     * station.get_properties Command
     * Returns all properties for a specific station
     */
    wsApi.registerMessageHandler('station.get_properties', async (message, ws) => {
        if (!isConnected()) { ws.close(); }

        const station = await eufyClient.getStation(message.serialNumber);
        const properties = station.getProperties();
        return {
            type: 'result',
            messageId: 'station.get_properties',
            success: true,
            result: {
                serialNumber: station.getSerial(),
                properties: properties
            }
        };
    });

    /**
     * station.download_image Command
     * Downloads an image from station (async operation)
     */
    wsApi.registerMessageHandler('station.download_image', async (message, ws) => {
        if (!isConnected()) { ws.close(); }

        const station = await eufyClient.getStation(message.serialNumber);
        station.downloadImage(message.file);
        return {
            type: "result",
            success: true,
            messageId: "station.download_image",
            result: {
                async: true
            }
        };
    });

    /**
     * station.database_query_latest_info Command
     * Queries latest database info from station (async operation)
     */
    wsApi.registerMessageHandler('station.database_query_latest_info', async (message, ws) => {
        if (!isConnected()) { ws.close(); }

        const station = await eufyClient.getStation(message.serialNumber);
        station.databaseQueryLatestInfo();
        return {
            type: "result",
            success: true,
            messageId: "station.database_query_latest_info",
            result: {
                async: true
            }
        };
    });

    /**
     * device.get_properties Command
     * Returns all properties for a specific device
     * Includes special handling for picture property to provide latest snapshot
     */
    wsApi.registerMessageHandler('device.get_properties', async (message, ws) => {
        if (!isConnected()) { ws.close(); }

        const device = await eufyClient.getDevice(message.serialNumber);
        const properties = device.getProperties();

        // Check if a newer snapshot is available for picture property
        properties.picture = checkDevicePictureProperty(device.getSerial(), properties.picture);

        return {
            type: 'result',
            messageId: 'device.get_properties',
            success: true,
            result: {
                serialNumber: device.getSerial(),
                stationSerial: device.getStationSerial(),
                properties: properties
            }
        };
    });

    /**
     * device.get_commands Command
     * Returns all available commands for a specific device
     */
    wsApi.registerMessageHandler('device.get_commands', async (message, ws) => {
        if (!isConnected()) { ws.close(); }

        const device = await eufyClient.getDevice(message.serialNumber);
        const result = device.getCommands();
        return {
            type: 'result',
            messageId: 'device.get_commands',
            success: true,
            result: {
                serialNumber: device.getSerial(),
                commands: result
            }
        };
    });

    /**
     * device.preset_position Command
     * Moves PTZ camera to a preset position
     */
    wsApi.registerMessageHandler('device.preset_position', async (message, ws) => {
        if (!isConnected()) { ws.close(); }

        const device = await eufyClient.getDevice(message.serialNumber);
        const station = await eufyClient.getStation(device.getStationSerial());
        try {
            station.presetPosition(device, message.position)
        }
        catch (error) {
            utils.log(`❌ Error presetting position for device ${device.getName()} (${device.getSerial()}): ${error.message}`, 'error');
            return {
                type: "result",
                success: false,
                messageId: "device.preset_position",
                errorCode: error.message,
                value: message.position
            };
        };
        return {
            type: "result",
            success: true,
            messageId: "device.preset_position",
            result: {
                async: true
            }
        };
    });

    /**
     * device.pan_and_tilt Command
     * Controls PTZ camera movement in specified direction
     */
    wsApi.registerMessageHandler('device.pan_and_tilt', async (message, ws) => {
        if (!isConnected()) { ws.close(); }

        const device = await eufyClient.getDevice(message.serialNumber);
        const station = await eufyClient.getStation(device.getStationSerial());
        station.panAndTilt(device, message.direction);
        return {
            type: "result",
            success: true,
            messageId: "device.pan_and_tilt",
            result: {
                async: true
            }
        };
    });

    /**
     * device.save_preset / device.delete_preset Commands
     * Save the camera's current view as preset slot 0-3, or clear a slot.
     */
    for (const [cmd, method] of [['device.save_preset', 'savePresetPosition'], ['device.delete_preset', 'deletePresetPosition']]) {
        wsApi.registerMessageHandler(cmd, async (message) => {
            const position = Number(message.position);
            if (!(position >= 0 && position <= 3)) return { type: 'result', success: false, messageId: cmd, errorCode: 'Invalid preset' };
            try {
                const device = await eufyClient.getDevice(message.serialNumber);
                const station = await eufyClient.getStation(device.getStationSerial());
                station[method](device, position);
                return { type: 'result', success: true, messageId: cmd, result: { position } };
            } catch (error) {
                utils.log(`❌ ${cmd} failed for ${message.serialNumber}: ${error.message}`, 'error');
                return { type: 'result', success: false, messageId: cmd, errorCode: error.message };
            }
        });
    }

    /**
     * device.calibrate Command
     * Re-home a pan & tilt camera (it sweeps its full range).
     */
    wsApi.registerMessageHandler('device.calibrate', async (message) => {
        try {
            const device = await eufyClient.getDevice(message.serialNumber);
            const station = await eufyClient.getStation(device.getStationSerial());
            station.calibrate(device);
            return { type: 'result', success: true, messageId: 'device.calibrate', result: { async: true } };
        } catch (error) {
            utils.log(`❌ Calibrate failed for ${message.serialNumber}: ${error.message}`, 'error');
            return { type: 'result', success: false, messageId: 'device.calibrate', errorCode: error.message };
        }
    });

    /**
     * device.set_motion_tracking Command
     * Turn the camera's auto-tracking (follow moving people) on or off.
     */
    wsApi.registerMessageHandler('device.set_motion_tracking', async (message) => {
        try {
            await eufyClient.setDeviceProperty(message.serialNumber, 'motionTracking', !!message.value);
            return { type: 'result', success: true, messageId: 'device.set_motion_tracking', result: { value: !!message.value } };
        } catch (error) {
            utils.log(`❌ Motion tracking toggle failed for ${message.serialNumber}: ${error.message}`, 'error');
            return { type: 'result', success: false, messageId: 'device.set_motion_tracking', errorCode: error.message };
        }
    });

    /**
     * device.set_rtsp Command (admin only)
     * Turn the camera's local RTSP stream on or off. When on, the station
     * reports the URL via the 'rtsp url' event → the device's rtspStreamUrl
     * property, which the RTSP fast path (live view + thumbnails) then uses.
     * This is a device-level setting that affects the whole household, and on a
     * battery camera a continuous RTSP stream may drain it — the client warns.
     */
    wsApi.registerMessageHandler('device.set_rtsp', async (message, ws) => {
        const scope = ws && ws._scope;
        if (!scope || !scope.admin) {
            return { type: 'result', success: false, messageId: 'device.set_rtsp', errorCode: 'forbidden' };
        }
        try {
            await eufyClient.setDeviceProperty(message.serialNumber, 'rtspStream', !!message.value);
            // On enable, wait briefly for the station to hand back the URL.
            let url = null;
            if (message.value) {
                for (let i = 0; i < 20 && !url; i++) {
                    await new Promise(r => setTimeout(r, 250));
                    url = await getRtspUrl(message.serialNumber);
                }
            }
            return { type: 'result', success: true, messageId: 'device.set_rtsp', result: { serialNumber: message.serialNumber, value: !!message.value, url } };
        } catch (error) {
            utils.log(`❌ RTSP toggle failed for ${message.serialNumber}: ${error.message}`, 'error');
            return { type: 'result', success: false, messageId: 'device.set_rtsp', errorCode: error.message };
        }
    });

    /**
     * device.get_voices / device.quick_response Commands
     * Doorbell quick replies: list the canned voice messages saved in the Eufy
     * account for this doorbell, and play one through its speaker.
     */
    wsApi.registerMessageHandler('device.get_voices', async (message) => {
        try {
            const voices = await eufyClient.getApi().getVoices(message.serialNumber);
            const list = Object.values(voices || {}).map(v => ({
                id: v.voice_id,
                name: v.desc || v.voice_name || v.name || `Reply ${v.voice_id}`
            }));
            if (list.length) utils.log(`💬 ${list.length} quick replies for ${message.serialNumber}: ${JSON.stringify(Object.values(voices)[0]).slice(0, 300)}`, 'debug');
            return { type: 'result', success: true, messageId: 'device.get_voices', result: { serialNumber: message.serialNumber, voices: list } };
        } catch (error) {
            return { type: 'result', success: false, messageId: 'device.get_voices', errorCode: error.message };
        }
    });

    wsApi.registerMessageHandler('device.quick_response', async (message) => {
        try {
            const device = await eufyClient.getDevice(message.serialNumber);
            const station = await eufyClient.getStation(device.getStationSerial());
            station.quickResponse(device, Number(message.voiceId));
            return { type: 'result', success: true, messageId: 'device.quick_response', result: { voiceId: message.voiceId } };
        } catch (error) {
            utils.log(`❌ Quick response failed for ${message.serialNumber}: ${error.message}`, 'error');
            return { type: 'result', success: false, messageId: 'device.quick_response', errorCode: error.message };
        }
    });

    /**
     * history.list Command
     * Recorded events for one camera (serialNumber) or all visible cameras,
     * one week per page ending at `before` (epoch ms, default now).
     */
    wsApi.registerMessageHandler('history.list', async (message, ws) => {
        const scope = ws && ws._scope;
        if (message.serialNumber && scope && !auth.isCameraAllowed(scope, message.serialNumber)) {
            return { type: 'result', success: false, messageId: 'history.list', errorCode: 'Not authorized for this camera' };
        }
        try {
            const result = await history.listEvents(scope, { serialNumber: message.serialNumber, before: message.before });
            return { type: 'result', success: true, messageId: 'history.list', result: { ...result, append: !!message.before } };
        } catch (error) {
            utils.log(`❌ History list failed: ${error.message}`, 'error');
            return { type: 'result', success: false, messageId: 'history.list', errorCode: error.message };
        }
    });

    /**
     * device.history_play Command
     * Fetch a recorded clip; progress/ready/error arrive as history_* events.
     * (device.* prefix → ws-api enforces camera scope on serialNumber.)
     */
    wsApi.registerMessageHandler('device.history_play', async (message, ws) => {
        if (!history.isValidId(message.id) || history.serialFromId(message.id) !== message.serialNumber) {
            return { type: 'result', success: false, messageId: 'device.history_play', errorCode: 'Invalid clip' };
        }
        try {
            const r = await history.play(message.id, ws);
            return { type: 'result', success: true, messageId: 'device.history_play', result: { id: message.id, ...r } };
        } catch (error) {
            return { type: 'result', success: false, messageId: 'device.history_play', errorCode: error.message, result: { id: message.id } };
        }
    });

    /**
     * device.set_auto_nightvision Command
     * Enables/disables auto night vision on device
     */
    wsApi.registerMessageHandler('device.set_auto_nightvision', async (message, ws) => {
        if (!isConnected()) { ws.close(); }

        const device = await eufyClient.getDevice(message.serialNumber);
        const station = await eufyClient.getStation(device.getStationSerial());
        try {
            station.setAutoNightvision(device, message.value);
        } catch (error) {
            utils.log(`❌ Error setting auto nightvision for ${device.getSerial()}: ${error.message}`, 'error');
            return { type: "result", success: false, messageId: "device.set_auto_nightvision", errorCode: error.message };
        }
        return { type: "result", success: true, messageId: "device.set_auto_nightvision", result: { async: true } };
    });

    /**
     * device.set_nightvision Command
     * Sets night vision mode on device (value: 0=off, 1=on, 2=auto, etc.)
     */
    wsApi.registerMessageHandler('device.set_nightvision', async (message, ws) => {
        if (!isConnected()) { ws.close(); }

        const device = await eufyClient.getDevice(message.serialNumber);
        const station = await eufyClient.getStation(device.getStationSerial());
        try {
            station.setNightVision(device, message.value);
        } catch (error) {
            utils.log(`❌ Error setting nightvision for ${device.getSerial()}: ${error.message}`, 'error');
            return { type: "result", success: false, messageId: "device.set_nightvision", errorCode: error.message };
        }
        return { type: "result", success: true, messageId: "device.set_nightvision", result: { async: true } };
    });

    /**
     * device.switch_light Command
     * Toggles spotlight on/off for device
     */
    wsApi.registerMessageHandler('device.switch_light', async (message, ws) => {
        if (!isConnected()) { ws.close(); }

        const device = await eufyClient.getDevice(message.serialNumber);
        const station = await eufyClient.getStation(device.getStationSerial());
        try {
            station.switchLight(device, message.value);
        } catch (error) {
            utils.log(`❌ Error switching light for ${device.getSerial()}: ${error.message}`, 'error');
            return { type: "result", success: false, messageId: "device.switch_light", errorCode: error.message };
        }
        return { type: "result", success: true, messageId: "device.switch_light", result: { async: true } };
    });

    /**
     * device.trigger_alarm Command
     * Triggers or resets alarm sound on device
     */
    wsApi.registerMessageHandler('device.trigger_alarm', async (message, ws) => {
        if (!isConnected()) { ws.close(); }

        const device = await eufyClient.getDevice(message.serialNumber);
        const station = await eufyClient.getStation(device.getStationSerial());
        try {
            if (message.value) {
                station.triggerDeviceAlarmSound(device, message.seconds || 10);
            } else {
                station.resetDeviceAlarmSound(device);
            }
        } catch (error) {
            utils.log(`❌ Error triggering alarm for ${device.getSerial()}: ${error.message}`, 'error');
            return { type: "result", success: false, messageId: "device.trigger_alarm", errorCode: error.message };
        }
        return { type: "result", success: true, messageId: "device.trigger_alarm", result: { async: true } };
    });

    /**
     * device.start_talkback Command
     * Starts two-way audio talkback for device
     */
    wsApi.registerMessageHandler('device.start_talkback', async (message, ws) => {
        if (!isConnected()) { ws.close(); }

        const device = await eufyClient.getDevice(message.serialNumber);
        const station = await eufyClient.getStation(device.getStationSerial());
        try {
            station.startTalkback(device);
            talkbackDeviceSN = message.serialNumber;
            utils.log(`🎤 Talkback started for device: ${device.getName()} (${device.getSerial()})`, 'info');
        } catch (error) {
            utils.log(`❌ Error starting talkback for ${device.getSerial()}: ${error.message}`, 'error');
            return { type: "result", success: false, messageId: "device.start_talkback", errorCode: error.message };
        }
        return { type: "result", success: true, messageId: "device.start_talkback", result: { async: true } };
    });

    /**
     * device.stop_talkback Command
     * Stops two-way audio talkback for device
     */
    wsApi.registerMessageHandler('device.stop_talkback', async (message, ws) => {
        if (!isConnected()) { ws.close(); }

        const device = await eufyClient.getDevice(message.serialNumber);
        const station = await eufyClient.getStation(device.getStationSerial());
        try {
            station.stopTalkback(device);
            stopTalkbackTranscode();
            talkbackDeviceSN = null;
            utils.log(`🎤 Talkback stopped for device: ${device.getName()} (${device.getSerial()})`, 'info');
        } catch (error) {
            utils.log(`❌ Error stopping talkback for ${device.getSerial()}: ${error.message}`, 'error');
            return { type: "result", success: false, messageId: "device.stop_talkback", errorCode: error.message };
        }
        return { type: "result", success: true, messageId: "device.stop_talkback", result: { async: true } };
    });

    /**
     * snapshot_all Command
     * Sequentially streams each camera briefly to capture a fresh snapshot.
     * Broadcasts progress events as each camera completes.
     */
    wsApi.registerMessageHandler('snapshot_all', async (message, ws) => {
        if (!isConnected()) { ws.close(); return; }
        if (snapshotAllRunning) {
            return { type: 'result', messageId: 'snapshot_all', success: false, errorCode: 'Already refreshing' };
        }

        // Get streamable device serial numbers, skipping offline cameras.
        // "Offline" matches the health dashboard's red dot: the `enabled`
        // property is false. Streaming an offline camera just holds up its
        // station's lane on a doomed connection attempt, so we exclude them.
        const deviceSNs = [];
        let skippedOffline = 0;
        for (const device of devices) {
            try {
                const cmds = device.getCommands();
                if (!cmds.includes('deviceStartLivestream')) continue;
                if (device.getPropertyValue('enabled') === false) {
                    skippedOffline++;
                    continue;
                }
                deviceSNs.push(device.getSerial());
            } catch (e) {}
        }
        if (skippedOffline > 0) {
            utils.log(`📷 snapshot_all: skipping ${skippedOffline} offline camera(s)`, 'info');
        }

        if (deviceSNs.length === 0) {
            return { type: 'result', messageId: 'snapshot_all', success: false, errorCode: 'No streamable cameras found' };
        }

        snapshotAllRunning = true;
        // Broadcast start event
        wsApi.wsBroadcast({
            type: 'event',
            event: { source: 'system', event: 'snapshot_all_start', total: deviceSNs.length }
        });

        // A user's live view would compete for the same station streams
        if (currentStreamingSN) {
            await stopStreamForDevice(currentStreamingSN);
            transcode.stopTranscoding();
        }

        // One lane per station: a station streams one camera at a time, but
        // different stations run side by side.
        const lanes = new Map();
        for (const sn of deviceSNs) {
            let stationSN = sn;
            try { stationSN = (await eufyClient.getDevice(sn)).getStationSerial(); } catch (e) {}
            if (!lanes.has(stationSN)) lanes.set(stationSN, []);
            lanes.get(stationSN).push(sn);
        }

        let completed = 0;
        const failed = [];
        const sweepStart = Date.now();
        const captureOne = async (sn) => {
            const camStart = Date.now();
            let result;
            try {
                result = await captureSnapshotForDevice(sn);
            } catch (err) {
                result = { ok: false, reason: err.message };
            }
            const ms = Date.now() - camStart;
            let name = sn;
            try { name = (await eufyClient.getDevice(sn)).getName(); } catch (e) {}
            if (result.ok) {
                utils.log(`📷 snapshot_all: ${name} ok in ${ms}ms (picture after ${result.pictureMs}ms)`, 'info');
            } else {
                failed.push({ serialNumber: sn, name, reason: result.reason });
                utils.log(`⚠️ snapshot_all: ${name} failed (${result.reason}) after ${ms}ms`, 'warn');
            }
            completed++;
            wsApi.wsBroadcast({
                type: 'event',
                event: { source: 'system', event: 'snapshot_all_progress', completed, total: deviceSNs.length, serialNumber: sn,
                         ok: result.ok, reason: result.reason, ms, pictureMs: result.pictureMs }
            });
        };
        const runLane = async (stationSN, laneSNs) => {
            snapshotStations.add(stationSN);
            try {
                for (const sn of laneSNs) await captureOne(sn);
            } finally {
                snapshotStations.delete(stationSN);
            }
        };
        try {
            await Promise.all([...lanes].map(([stationSN, laneSNs]) => runLane(stationSN, laneSNs)));
        } finally {
            snapshotAllRunning = false;
        }
        utils.log(`📷 snapshot_all: done in ${Date.now() - sweepStart}ms, ${deviceSNs.length - failed.length}/${deviceSNs.length} updated`, 'info');

        // Broadcast completion
        wsApi.wsBroadcast({
            type: 'event',
            event: { source: 'system', event: 'snapshot_all_done', total: deviceSNs.length, failed }
        });

        return { type: 'result', messageId: 'snapshot_all', success: true, result: { count: deviceSNs.length } };
    });

    // Register binary message handler for talkback audio data
    wsApi.registerBinaryHandler((data, ws) => {
        handleTalkbackAudio(data);
    });

    wsEvnentHandlersRegistered = true;
    utils.log('📝 Eufy WebSocket handlers registered', 'debug');
}

/**
 * Check Device Picture Property
 * Determines if a newer snapshot is available and returns updated picture data
 * Uses MD5 checksums and timestamps to detect changes
 * @param {string} deviceSN - Device serial number
 * @param {Object} properties - Current picture properties
 * @returns {Object} Updated picture properties or original if no update available
 */
function checkDevicePictureProperty(deviceSN, properties) {
    try {
        if (properties && properties.data) {
            properties.isSnapshot = false;
            let isPictureRecent = true;

            // Calculate checksum of current picture data
            const checksum = utils.generateChecksum(properties.data);
            let previousChecksum = utils.loadPictureHash(deviceSN);

            // First time seeing this device
            if (!previousChecksum) {
                utils.log(`No previous picture checksum found for device ${deviceSN}, saving current checksum.`, 'debug');
                previousChecksum = utils.savePictureHash(deviceSN, checksum);
            } else if (checksum !== previousChecksum.hash) {
                // Picture data has changed - use current data
                utils.log(`🆕 Picture checksum changed for device ${deviceSN}`, 'debug');
                previousChecksum = utils.savePictureHash(deviceSN, checksum);
            }

            // Check if a newer snapshot file exists
            const snapshotTime = utils.loadSnapshotDatetime(deviceSN);
            if (snapshotTime) {
                utils.log(`Previous snapshot time for device ${deviceSN}: ${snapshotTime}`, 'debug');

                // Snapshot is newer than picture property - use snapshot
                if (new Date(previousChecksum.datetime) < new Date(snapshotTime)) {
                    utils.log(`New snapshot available for device ${deviceSN}, loading from disk.`, 'debug');

                    isPictureRecent = false;
                }

                const snapshot = utils.loadSnapshotFromDisk(deviceSN);
                if (snapshot) {
                    utils.log(`Replacing picture data with snapshot for device ${deviceSN}`, 'debug');
                    // Return snapshot data in expected format
                    return {
                        "data": {
                            "type": "Buffer",
                            "data": Array.from(snapshot)
                        },
                        "type": {
                            "ext": "jpg",
                            "mime": "image/jpeg"
                        },
                        "eventData": {
                            "type": "Buffer",
                            "data": Array.from(properties.data)
                        },
                        "eventType": {
                            "ext": properties.type.ext,
                            "mime": properties.type.mime
                        },
                        "isSnapshot": true,
                        "isRecent": isPictureRecent ? "event" : "snapshot"
                    }
                }
            }
        }
    } catch (error) {
        utils.log(`❌ Error checking picture property for device ${deviceSN}: ${error.message}`, 'error');
    }

    return properties;
}

/**
 * Start Talkback Transcode
 * Spawns FFmpeg to convert incoming browser audio (16kHz mono s16le PCM)
 * to the format expected by the Eufy talkback stream (8kHz mono s16le PCM)
 * @param {TalkbackStream} talkbackStream - Eufy SDK talkback stream to pipe audio into
 */
function startTalkbackTranscode(talkbackStream) {
    stopTalkbackTranscode(); // Clean up any existing

    const { spawn } = require('child_process');
    const ffmpegPath = require('path').join(__dirname, '..', 'ffmpeg', 'ffmpeg.exe');

    talkbackFFmpeg = spawn(ffmpegPath, [
        '-f', 's16le',
        '-ar', '16000',
        '-ac', '1',
        '-i', 'pipe:0',
        '-f', 's16le',
        '-ar', '8000',
        '-ac', '1',
        'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    talkbackFFmpeg.stdout.on('data', (chunk) => {
        try {
            talkbackStream.write(chunk);
        } catch (e) {
            utils.log(`❌ Error writing to talkback stream: ${e.message}`, 'error');
        }
    });

    talkbackFFmpeg.stderr.on('data', (data) => {
        utils.log(`🎤 Talkback FFmpeg: ${data.toString().trim()}`, 'trace');
    });

    talkbackFFmpeg.on('close', (code) => {
        utils.log(`🎤 Talkback FFmpeg exited with code ${code}`, 'debug');
        talkbackFFmpeg = null;
    });

    talkbackFFmpeg.on('error', (err) => {
        utils.log(`❌ Talkback FFmpeg error: ${err.message}`, 'error');
        talkbackFFmpeg = null;
    });

    utils.log('🎤 Talkback FFmpeg transcoder started (16kHz -> 8kHz)', 'info');
}

/**
 * Stop Talkback Transcode
 * Kills the FFmpeg talkback transcoding process
 */
function stopTalkbackTranscode() {
    if (talkbackFFmpeg) {
        try {
            talkbackFFmpeg.stdin.end();
            talkbackFFmpeg.kill('SIGKILL');
        } catch (e) { /* ignore */ }
        talkbackFFmpeg = null;
        utils.log('🎤 Talkback FFmpeg transcoder stopped', 'debug');
    }
}

/**
 * Handle Talkback Audio
 * Receives binary audio data from WebSocket client and writes to FFmpeg stdin
 * @param {Buffer} buffer - Raw PCM audio data from browser
 */
function handleTalkbackAudio(buffer) {
    if (talkbackFFmpeg && talkbackFFmpeg.stdin && !talkbackFFmpeg.stdin.destroyed) {
        try {
            talkbackFFmpeg.stdin.write(buffer);
        } catch (e) {
            utils.log(`❌ Error writing talkback audio: ${e.message}`, 'error');
        }
    }
}

/**
 * Schedule Reconnect
 * Attempts to reconnect to Eufy with exponential backoff
 * Delay: 5s, 10s, 20s, 40s, 60s (capped), up to 10 attempts
 */
function scheduleReconnect() {
    if (reconnectTimer) return; // Already scheduled
    if (!lastEufyConfig) return; // No config to reconnect with
    if (reconnectAttempt >= 10) {
        utils.log('❌ Max reconnect attempts (10) reached. Giving up.', 'error');
        wsApi.wsBroadcast({
            type: 'event',
            event: { source: 'system', event: 'eufy reconnect failed' }
        });
        return;
    }

    const delay = Math.min(5000 * Math.pow(2, reconnectAttempt), 60000);
    reconnectAttempt++;
    utils.log(`🔄 Scheduling Eufy reconnect attempt ${reconnectAttempt}/10 in ${delay / 1000}s...`, 'info');

    wsApi.wsBroadcast({
        type: 'event',
        event: {
            source: 'system',
            event: 'eufy reconnecting',
            attempt: reconnectAttempt,
            delayMs: delay
        }
    });

    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        try {
            // Reset client so connect() doesn't bail on isConnected check
            if (eufyClient) {
                try { await eufyClient.close(); } catch (e) { /* ignore */ }
                eufyClient = null;
            }
            await connect(lastEufyConfig);
        } catch (e) {
            utils.log(`❌ Reconnect attempt ${reconnectAttempt} failed: ${e.message}`, 'error');
            scheduleReconnect();
        }
    }, delay);
}

/**
 * Is Connected
 * Checks if Eufy client is currently connected
 * @returns {boolean} True if connected, false otherwise
 */
function isConnected() {
    return eufyClient ? eufyClient.isConnected() : false;
}

/**
 * Close Connection
 * Gracefully closes connection to Eufy Security system
 * @returns {Promise} Promise that resolves when connection is closed
 */
async function close() {
    // Cancel any pending reconnect
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    reconnectAttempt = 0;
    lastEufyConfig = null;

    if (eufyClient) {
        utils.log('Closing connection to Eufy...', 'info');
        return await eufyClient.close();
    } else {
        utils.log('Eufy client is not initialized.', 'warn');
        return Promise.resolve();
    }
}

/**
 * Module Exports
 * Exposes Eufy client management functions
 */
function getHousesDebug() {
    const result = { eufyClientHouses: null, stationHouseMap: {}, deviceHouseMap: {}, stationDetails: {}, deviceDetails: {} };
    try {
        result.eufyClientHouses = eufyClient?.houses || null;
    } catch (e) {
        result.eufyClientHouses = 'ERROR: ' + e.message;
    }
    for (const station of stations) {
        try {
            const raw = station.getRawStation();
            result.stationDetails[station.getSerial()] = {
                stationName: station.getName(),
                topLevelHouseId: raw?.house_id,
                memberHouseId: raw?.member?.house_id,
            };
            const houseId = raw?.house_id || raw?.member?.house_id;
            if (houseId) result.stationHouseMap[station.getSerial()] = houseId;
        } catch (e) {
            result.stationDetails[station.getSerial()] = 'ERROR: ' + e.message;
        }
    }
    for (const device of devices) {
        try {
            const raw = device.getRawDevice();
            result.deviceDetails[device.getSerial()] = {
                deviceName: device.getName(),
                topLevelHouseId: raw?.house_id,
                memberHouseId: raw?.member?.house_id,
                stationSerial: device.getStationSerial()
            };
            const houseId = raw?.house_id || raw?.member?.house_id;
            if (houseId) result.deviceHouseMap[device.getSerial()] = houseId;
        } catch (e) {
            result.deviceDetails[device.getSerial()] = 'ERROR: ' + e.message;
        }
    }
    return result;
}

/**
 * Build the device→house map and houses lookup from raw SDK data.
 * Shared by start_listening and the admin device catalog.
 */
function buildHouseMaps() {
    const deviceHouseMap = {};
    for (const device of devices) {
        try {
            const raw = device.getRawDevice();
            const houseId = raw?.house_id || raw?.member?.house_id;
            if (houseId) deviceHouseMap[device.getSerial()] = houseId;
        } catch (e) {}
    }
    // Fallback: derive a device's house from its station when missing
    if (Object.keys(deviceHouseMap).length === 0) {
        const stationHouseMap = {};
        for (const station of stations) {
            try {
                const raw = station.getRawStation();
                const houseId = raw?.house_id || raw?.member?.house_id;
                if (houseId) stationHouseMap[station.getSerial()] = houseId;
            } catch (e) {}
        }
        for (const device of devices) {
            try {
                const stationSN = device.getStationSerial();
                if (stationHouseMap[stationSN]) deviceHouseMap[device.getSerial()] = stationHouseMap[stationSN];
            } catch (e) {}
        }
    }

    const housesData = {};
    if (eufyClient?.houses) {
        for (const [id, data] of Object.entries(eufyClient.houses)) {
            housesData[id] = { house_id: id, house_name: data.house_name };
        }
    }
    return { deviceHouseMap, housesData };
}

/**
 * Full catalog of every camera (admin use) for the access-management UI.
 * Returns [{ serialNumber, name, stationSerial, houseId, houseName }].
 */
// The camera's local RTSP URL, but only when RTSP is actually on (the station
// clears rtspStreamUrl to "" when disabled). null otherwise.
function rtspUrlForDevice(device) {
    try {
        const url = device.getPropertyValue('rtspStreamUrl');
        return (typeof url === 'string' && url.startsWith('rtsp')) ? url : null;
    } catch (e) { return null; }
}

// Does this camera support the local RTSP stream at all?
function deviceSupportsRtsp(device) {
    try { return device.getPropertyValue('rtspStream') !== undefined; }
    catch (e) { return false; }
}

async function getRtspUrl(serialNumber) {
    try { return rtspUrlForDevice(await eufyClient.getDevice(serialNumber)); }
    catch (e) { return null; }
}

// --- Auto-managed RTSP sessions ---
// RTSP is enabled on the camera only while something is actively using it (a
// live viewer or a snapshot), then turned back off after a short grace period —
// so the device setting (and any battery cost) is scoped to real use. Reference
// counted, so concurrent viewers and quick camera switches don't thrash it. A
// camera that doesn't answer (e.g. a sleeping battery cam) is put on a short
// cooldown so callers fall back to P2P quickly instead of waiting every time.
const RTSP_OFF_GRACE_MS = 30000;       // keep RTSP on this long after the last user leaves
const RTSP_URL_WAIT_MS = 2500;         // give the station this long to hand back the URL
const RTSP_FAIL_COOLDOWN_MS = 120000;  // after a miss, skip RTSP this long (use P2P meanwhile)
const rtspSessions = new Map();        // serial -> { count, enabledByUs, offTimer, url, coolUntil }

function rtspSession(sn) {
    let s = rtspSessions.get(sn);
    if (!s) { s = { count: 0, enabledByUs: false, offTimer: null, url: null, coolUntil: 0 }; rtspSessions.set(sn, s); }
    return s;
}

// Acquire an RTSP stream URL for a camera, enabling RTSP on demand if needed.
// Returns the rtsp:// URL, or null if the camera can't (then use P2P). Every
// non-null result must be paired with releaseRtspSession().
async function acquireRtspSession(serialNumber) {
    const s = rtspSession(serialNumber);
    if (s.offTimer) { clearTimeout(s.offTimer); s.offTimer = null; }
    if (s.count === 0) {
        if (Date.now() < s.coolUntil) return null;      // recently failed — skip, caller uses P2P
        let device;
        try { device = await eufyClient.getDevice(serialNumber); } catch (e) { return null; }
        if (!deviceSupportsRtsp(device)) return null;
        let url = rtspUrlForDevice(device);
        if (url) {
            s.enabledByUs = false;                       // already on (left on manually) — don't own it
        } else {
            try {
                await eufyClient.setDeviceProperty(serialNumber, 'rtspStream', true);
                s.enabledByUs = true;                    // we flipped it on — we turn it back off
                const deadline = Date.now() + RTSP_URL_WAIT_MS;
                while (!url && Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, 250));
                    url = await getRtspUrl(serialNumber);
                }
            } catch (e) { utils.log(`❌ RTSP enable failed for ${serialNumber}: ${e.message}`, 'warn'); }
        }
        if (!url) {                                      // never came up (asleep?) — cool down and turn back off
            s.coolUntil = Date.now() + RTSP_FAIL_COOLDOWN_MS;
            if (s.enabledByUs) {
                eufyClient.setDeviceProperty(serialNumber, 'rtspStream', false).catch(() => {});
                s.enabledByUs = false;
            }
            s.url = null;
            return null;
        }
        s.url = url;
    }
    s.count++;
    return s.url;
}

// The RTSP URL can be set while the camera is asleep (endpoint exists, no
// video). When a stream comes up empty, mark a cooldown so the next watch goes
// straight to P2P instead of re-enabling RTSP for nothing.
function markRtspMiss(serialNumber) {
    rtspSession(serialNumber).coolUntil = Date.now() + RTSP_FAIL_COOLDOWN_MS;
}

// Release one hold on a camera's RTSP session; turns RTSP back off (if we
// enabled it) once the last user leaves, after a short grace period.
function releaseRtspSession(serialNumber) {
    const s = rtspSessions.get(serialNumber);
    if (!s) return;
    s.count = Math.max(0, s.count - 1);
    if (s.count === 0 && s.enabledByUs && !s.offTimer) {
        s.offTimer = setTimeout(async () => {
            s.offTimer = null;
            if (s.count > 0) return;                     // someone came back during the grace window
            try { await eufyClient.setDeviceProperty(serialNumber, 'rtspStream', false); } catch (e) {}
            s.enabledByUs = false; s.url = null;
            utils.log(`📴 RTSP auto-disabled for ${serialNumber} (idle)`, 'debug');
        }, RTSP_OFF_GRACE_MS);
    }
}

function getDeviceCatalog() {
    const { deviceHouseMap, housesData } = buildHouseMaps();
    return Array.from(devices).map(d => {
        let serialNumber = '', name = '', stationSerial = '';
        try { serialNumber = d.getSerial(); } catch (e) {}
        try { name = d.getName(); } catch (e) {}
        try { stationSerial = d.getStationSerial(); } catch (e) {}
        const houseId = deviceHouseMap[serialNumber] || null;
        return {
            serialNumber,
            name: name || serialNumber,
            stationSerial,
            houseId,
            houseName: houseId && housesData[houseId] ? housesData[houseId].house_name : null
        };
    });
}

module.exports = {
    connect,
    isConnected,
    startStreamForDevice,
    stopStreamForDevice,
    startFrameStreamForDevice,
    stopFrameStream,
    close,
    getHousesDebug,
    getDeviceCatalog,
    getRtspUrl,
    acquireRtspSession,
    releaseRtspSession,
    markRtspMiss
};