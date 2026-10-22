/**
 * EufyView - Mobile-First Client
 *
 * Single-file client handling:
 * - WebSocket connection to server API
 * - Device discovery and camera grid
 * - MSE-based live video streaming
 * - Settings and captcha flows
 */

// ============================================================================
// State
// ============================================================================

let ws = null;
let config = null;
let currentUser = null;     // { email, admin, cameras, authEnabled } from /auth/me
let accessCatalog = [];     // admin view: full camera catalog for assigning access
let accessEditEmail = null; // email being edited on the access page (null = new user)
let accessSelected = new Set(); // working set of selected camera SNs on the access page
let devices = {};           // serialNumber -> { name, model, picture, ... }
let stations = {};          // stationSerial -> { name }
let houses = {};            // houseId -> { house_name }
let deviceHouseMap = {};    // deviceSerial -> houseId
let currentDeviceSN = null; // device being viewed live
let stationSN = null;

// Video streaming state
let mediaSource = null;
let sourceBuffer = null;
let fetchController = null;
let isStreaming = false;

// Talkback state
let talkbackActive = false;
let talkbackAudioCtx = null;
let talkbackMicStream = null;

// Snapshot-all state
let snapshotAllInProgress = false;
let snapshotAllWatchdog = null;

// Live view mode: 'stream' (fMP4/MSE) or 'frame' (Data Saver JPEG polling)
let liveMode = 'stream';

// Camera tapped in the grid, awaiting a mode choice
let pendingModeSN = null;

// Camera to deep-link to from a tapped push notification (set from ?camera= on
// load; opened once devices are discovered). See openCameraFromNotification.
let deepLinkCamera = null;

// Frame view (Data Saver) state
let frameLoopActive = false;
let frameDevice = null;
let frameEtag = null;
let frameCount = 0;
let frameFpsTimer = null;

// Swipe gesture state
let swipeTouchId = null;
let swipeStartX = 0;
let swipeStartY = 0;
let swipeStartTime = 0;

// Wake lock state
let wakeLock = null;

// Timeline state
let timelineEvents = [];
const MAX_TIMELINE_EVENTS = 100;
const EVENT_ICONS = {
    'motion detected': '\u{1F3C3}', 'person detected': '\u{1F9D1}', 'pet detected': '\u{1F43E}',
    'vehicle detected': '\u{1F697}', 'crying detected': '\u{1F476}', 'sound detected': '\u{1F50A}',
    'ring': '\u{1F514}', 'stranger detected': '\u{1F464}', 'dog detected': '\u{1F415}',
    'familiar face': '\u{1F642}', 'activity detected': '\u{1F4F7}',
    'dog lick detected': '\u{1F415}', 'dog poop detected': '\u{1F415}'
};
const EVENT_COLORS = {
    'motion detected': 'var(--warning)', 'person detected': 'var(--primary)', 'pet detected': 'var(--success)',
    'vehicle detected': 'var(--danger)', 'crying detected': '#ff6ec7', 'sound detected': '#b44aff',
    'ring': '#ffdd4a', 'stranger detected': 'var(--danger)', 'dog detected': 'var(--success)',
    'familiar face': 'var(--success)', 'activity detected': 'var(--warning)',
    'dog lick detected': 'var(--success)', 'dog poop detected': 'var(--success)'
};

// Product names for Eufy model codes, from the official app's (v6.1.10) model table.
// The cloud reports only the code (e.g. "T8210"); the official app shows these names.
const MODEL_NAMES = {
    T8001: 'HomeBase', T8002: 'HomeBase', T8010: 'HomeBase 2', T8011: 'AI Station', T8012: 'AI Station',
    T8020: 'Wi-Fi Doorbell Chime', T8021: 'Wi-Fi Bridge & Chime', T8023: 'MiniBase Chime', T8030: 'HomeBase S380',
    T8111: 'eufyCam', T8112: 'eufyCam E', T8113: 'eufyCam 2C', T8142: 'eufyCam 2C', T8144: 'eufyCam E40',
    T8160: 'eufyCam S330', T8161: 'eufyCam S300', T8162: 'eufyCam S3 Pro',
    T8122: 'SoloCam Spotlight', T8123: 'SoloCam Spotlight', T8124: 'SoloCam S230', T8134: 'SoloCam S220',
    T8171: 'SoloCam E30', T8173: 'SoloCam E42', T8B00: 'SoloCam C210',
    T8150: '4G Starlight Camera', T8151: '4G Starlight Camera', T8152: '4G Starlight Camera', T86P2: '4G LTE Cam S330',
    T81A0: 'Wall Light Cam (Battery)', T84A1: 'Wall Light Cam (Wired)',
    T8200: 'Video Doorbell', T8201: 'Video Doorbell', T8202: 'Video Doorbell', T8203: 'Video Doorbell',
    T8210: 'Video Doorbell', T8213: 'Video Doorbell', T8214: 'Video Doorbell', T8220: 'Video Doorbell',
    T8221: 'Video Doorbell', T8222: 'Video Doorbell', T8223: 'Video Doorbell', T8224: 'Video Doorbell',
    T8400: 'Indoor Cam', T8401: 'Indoor Cam', T8410: 'Indoor Cam Pan&Tilt', T8411: 'Indoor Cam Pan&Tilt',
    T8414: 'Indoor Cam Mini', T8416: 'Indoor Cam S350', T8417: 'Indoor Cam E30',
    T8419: 'Indoor Cam Pan&Tilt V2', T8W11: 'Indoor Cam Pan&Tilt V2',
    T8420: 'Floodlight Cam', T8422: 'Floodlight Cam', T8423: 'Floodlight Cam 2 Pro', T8424: 'Floodlight Cam',
    T8425: 'Floodlight Cam E340', T8426: 'Floodlight Cam E30',
    T8440: 'Outdoor Cam', T8441: 'Outdoor Cam', T8442: 'Outdoor Cam',
    T8450: 'Garage Door Sensor', T8452: 'Garage-Control Cam', T8453: 'Garage-Control Cam',
    T8530: 'Video Smart Lock', T8531: 'Video Smart Lock', T853A: 'Video Smart Lock', T85V0: 'Video Smart Lock',
    T8600: '24x7 Professional Cam', T8790: 'SmartDrop', T87A0: 'Smart Display E10',
    T8900: 'Entry Sensor', T8910: 'Motion Sensor', T8960: 'Keypad', T8970: 'Siren'
};

function modelName(code) {
    if (!code) return '';
    return MODEL_NAMES[code] || MODEL_NAMES[code.slice(0, 5)] || code;
}

// Zoom gesture state
let zoomScale = 1;
let zoomPanX = 0;
let zoomPanY = 0;
let pinchStartDist = 0;
let pinchStartScale = 1;
let isPinching = false;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panStartPanX = 0;
let panStartPanY = 0;
let lastTapTime = 0;

// ============================================================================
// Boot
// ============================================================================

// Register service worker for PWA installability
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', async () => {
    // Load config and connect
    try {
        const health = await fetchJSON('/health');
        config = await fetchJSON('/config');
    } catch (e) {
        // Server may still be starting
    }
    try {
        currentUser = await fetchJSON('/auth/me');
    } catch (e) {
        // Auth may be disabled or server starting
    }

    // Deep-link from a tapped push notification → that camera's mode chooser.
    // Fresh launch carries ?camera=<sn>; an already-open app gets a SW message.
    try { deepLinkCamera = new URLSearchParams(location.search).get('camera'); } catch (e) {}
    if (navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'open-camera' && e.data.serialNumber) {
                openCameraFromNotification(e.data.serialNumber);
            }
        });
    }

    // Trap the Android back gesture → in-app navigation (never the OAuth URL).
    initBackTrap();

    wsConnect();

    // Event listeners
    document.getElementById('settings-btn').addEventListener('click', openSettings);
    document.getElementById('settings-close').addEventListener('click', closeSettings);
    document.getElementById('settings-cancel').addEventListener('click', closeSettings);
    document.getElementById('settings-save').addEventListener('click', onSettingsSave);
    document.getElementById('live-back').addEventListener('click', stopLiveView);
    document.getElementById('live-reload').addEventListener('click', reloadLiveView);
    document.getElementById('live-mute-btn').addEventListener('click', toggleMute);
    document.getElementById('live-fullscreen-btn').addEventListener('click', toggleFullscreen);
    document.getElementById('live-pip-btn').addEventListener('click', togglePiP);
    document.getElementById('captcha-submit').addEventListener('click', onCaptchaSubmit);

    // PiP event listeners
    const video = document.getElementById('live-video');
    video.addEventListener('enterpictureinpicture', () => {
        document.getElementById('live-pip-btn').classList.add('active');
    });
    video.addEventListener('leavepictureinpicture', () => {
        document.getElementById('live-pip-btn').classList.remove('active');
    });

    // CRF slider display
    const crfSlider = document.getElementById('cfg-crf');
    crfSlider.addEventListener('input', () => {
        document.getElementById('cfg-crf-val').textContent = crfSlider.value;
    });

    // Frame-quality slider display
    const frameQ = document.getElementById('cfg-frame-quality');
    frameQ.addEventListener('input', () => {
        document.getElementById('cfg-frame-quality-val').textContent = frameQ.value;
    });

    // Timeline button
    document.getElementById('timeline-btn').addEventListener('click', showTimeline);
    document.getElementById('timeline-back').addEventListener('click', () => {
        document.getElementById('timeline-screen').classList.remove('active');
        showScreen('cameras-screen');
    });
    document.getElementById('timeline-clear').addEventListener('click', clearTimeline);

    // Recordings (history)
    document.getElementById('history-btn').addEventListener('click', () => openHistory(''));
    document.getElementById('history-back').addEventListener('click', closeHistory);
    document.getElementById('history-refresh').addEventListener('click', () => loadHistory(false));
    document.getElementById('history-camera').addEventListener('change', (e) => {
        historyCamera = e.target.value;
        loadHistory(false);
    });
    document.getElementById('history-more').addEventListener('click', () => loadHistory(true));
    document.getElementById('history-player-close').addEventListener('click', closeHistoryPlayer);

    // Doorbell quick replies
    document.getElementById('qr-close').addEventListener('click', closeQuickReplies);
    document.getElementById('qr-overlay').addEventListener('click', (e) => {
        if (e.target.id === 'qr-overlay') closeQuickReplies();
    });

    // Snapshot all button
    document.getElementById('snapshot-all-btn').addEventListener('click', startSnapshotAll);

    // Mode chooser (HD stream vs Data Saver)
    document.getElementById('mode-stream').addEventListener('click', () => chooseMode('stream'));
    document.getElementById('mode-frame').addEventListener('click', () => chooseMode('frame'));
    document.getElementById('mode-history').addEventListener('click', () => {
        const sn = pendingModeSN;
        closeModeChooser();
        openHistory(sn || '');
    });
    document.getElementById('mode-rtsp').addEventListener('click', () => toggleRtsp(pendingModeSN));
    document.getElementById('mode-close').addEventListener('click', closeModeChooser);
    document.getElementById('mode-overlay').addEventListener('click', (e) => {
        if (e.target.id === 'mode-overlay') closeModeChooser();
    });

    // Health button
    document.getElementById('health-btn').addEventListener('click', showHealthDashboard);
    document.getElementById('health-back').addEventListener('click', () => {
        document.getElementById('health-screen').classList.remove('active');
        showScreen('cameras-screen');
    });

    // Re-acquire wake lock on visibility change
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && isStreaming) {
            acquireWakeLock();
        }
    });

    // Users & Access (admin only)
    document.getElementById('access-add-btn').addEventListener('click', () => openAccessPage(null));
    document.getElementById('access-back').addEventListener('click', closeAccessPage);
    document.getElementById('access-users').addEventListener('click', onAccessUsersClick);
    document.getElementById('access-cameras').addEventListener('click', onAccessCamClick);
    document.getElementById('access-save-btn').addEventListener('click', submitAccessUser);

    // Background push notifications
    document.getElementById('push-enable-btn').addEventListener('click', togglePush);
    // If push was enabled before, refresh the subscription quietly on load
    refreshPushSubscription();
    initNotifStyleSelect();
    // If it isn't enabled yet, surface Settings so it's easy to turn on
    maybePromptPushSetup();
});

// Open Settings (where the Enable button lives) when background push isn't on
// yet — once per session so it nudges without nagging.
function maybePromptPushSetup() {
    if (!pushSupported()) return;
    if (localStorage.getItem('pushEnabled') === '1') return;       // already enabled
    if (sessionStorage.getItem('pushPromptShown') === '1') return; // already nudged this session
    sessionStorage.setItem('pushPromptShown', '1');
    setTimeout(() => {
        // Don't pop over an active live view
        if (!document.body.classList.contains('live-active')) openSettings();
    }, 1500);
}

// ============================================================================
// Helpers
// ============================================================================

async function fetchJSON(url, opts) {
    const res = await fetch(url, opts);
    return res.json();
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

function setConnectionDot(state) {
    const dot = document.getElementById('connection-dot');
    dot.className = 'dot ' + state;
}

// ============================================================================
// WebSocket Connection
// ============================================================================

function wsConnect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    setConnectionDot('connecting');
    const wsUrl = location.origin.replace(/^http/, 'ws') + '/api';
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        setConnectionDot('connected');
        requestNotificationPermission();
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleWSMessage(data);
        } catch (e) {
            console.error('WS parse error:', e);
        }
    };

    ws.onclose = () => {
        setConnectionDot('disconnected');
        ws = null;
        // Auto-reconnect after 5s
        setTimeout(() => {
            if (!ws) wsConnect();
        }, 5000);
    };

    ws.onerror = () => {
        setConnectionDot('disconnected');
    };
}

function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    }
}

// ============================================================================
// WebSocket Message Handling
// ============================================================================

function handleWSMessage(data) {
    switch (data.type) {
        case 'version':
            // Server connected, start listening
            wsSend({ command: 'start_listening', messageId: 'start_listening' });
            break;

        case 'result':
            handleResult(data);
            break;

        case 'event':
            handleEvent(data);
            break;
    }
}

function handleResult(msg) {
    switch (msg.messageId) {
        case 'start_listening':
            if (msg.success && msg.result?.state) {
                const state = msg.result.state;
                stationSN = state.stations?.[0] || null;

                // Store house and station-to-house mappings
                if (state.houses) houses = state.houses;
                if (state.deviceHouseMap) deviceHouseMap = state.deviceHouseMap;

                // Request properties for each station
                (state.stations || []).forEach(sn => {
                    stations[sn] = stations[sn] || { serialNumber: sn };
                    wsSend({ command: 'station.get_properties', messageId: 'station.get_properties', serialNumber: sn });
                });

                // Request properties for each device
                (state.devices || []).forEach(sn => {
                    devices[sn] = devices[sn] || { serialNumber: sn };
                    wsSend({ command: 'device.get_properties', messageId: 'device.get_properties', serialNumber: sn });
                    wsSend({ command: 'device.get_commands', messageId: 'device.get_commands', serialNumber: sn });
                });

                showScreen('cameras-screen');
                renderCameraGrid();
                document.getElementById('snapshot-all-btn').classList.remove('hidden');
                document.getElementById('timeline-btn').classList.remove('hidden');
                document.getElementById('history-btn').classList.remove('hidden');
                document.getElementById('health-btn').classList.remove('hidden');

                // If launched from a tapped notification, jump to that camera now
                // that devices are known.
                if (deepLinkCamera) openCameraFromNotification(deepLinkCamera);
            } else {
                // Connection failed — show cameras screen with error
                showScreen('cameras-screen');
                const grid = document.getElementById('camera-grid');
                grid.innerHTML = '<p style="color:var(--danger);text-align:center;padding:40px">Failed to connect to Eufy. Check server credentials.</p>';
            }
            break;

        case 'station.get_properties':
            if (msg.result?.properties) {
                const sn = msg.result.serialNumber;
                const props = msg.result.properties;
                stations[sn] = {
                    ...stations[sn],
                    serialNumber: sn,
                    name: props.name || sn
                };
                renderCameraGrid();
            }
            break;

        case 'snapshot_all':
            // Refused. If another viewer's sweep is running, its progress events drive the button.
            if (!msg.success && msg.errorCode !== 'Already refreshing') {
                clearTimeout(snapshotAllWatchdog);
                snapshotAllWatchdog = null;
                snapshotAllInProgress = false;
                updateSnapshotAllButton();
                if (msg.errorCode) flashMessage(msg.errorCode);
            }
            break;

        case 'device.get_properties':
            if (msg.result?.properties) {
                const sn = msg.result.serialNumber;
                const props = msg.result.properties;
                devices[sn] = {
                    ...devices[sn],
                    serialNumber: sn,
                    stationSerial: msg.result.stationSerial || devices[sn]?.stationSerial,
                    name: props.name || sn,
                    model: props.model || '',
                    battery: props.battery,
                    wifiRssi: props.wifiRssi,
                    picture: props.picture,
                    enabled: props.enabled,
                    // Capability flags
                    hasNightvision: props.nightvision !== undefined || props.autoNightvision !== undefined,
                    hasLight: props.light !== undefined || props.lightSettingsBrightnessManual !== undefined,
                    lightOn: !!props.light,
                    nightvisionValue: props.nightvision,
                    hasMotionTracking: props.motionTracking !== undefined,
                    motionTracking: !!props.motionTracking,
                    // RTSP fast path: supported if the camera exposes the property at all
                    rtspSupported: props.rtspStream !== undefined,
                    rtspEnabled: !!props.rtspStream,
                    isBattery: props.battery !== undefined && props.battery !== null
                };
                renderCameraGrid();
                if (currentDeviceSN === sn) updateLiveControls();
                // Camera names arrive after start_listening; if Settings is open,
                // refresh the notification rows so they show names (not serials).
                if (!document.getElementById('settings-overlay').classList.contains('hidden')) {
                    renderNotifToggles();
                }
            }
            break;

        case 'history.list':
            onHistoryList(msg);
            break;

        case 'device.history_play':
            if (msg.result && msg.result.id === historyPlayingId) {
                if (!msg.success) setHistoryStatus(`Couldn't load clip: ${msg.errorCode || 'error'}`);
                else if (msg.result.ready) playHistoryClip(msg.result.url);
                else setHistoryStatus('Downloading from camera…');
            }
            break;

        case 'device.get_voices':
            onVoicesList(msg);
            break;

        case 'device.quick_response':
            flashMessage(msg.success ? 'Reply sent' : `Reply failed: ${msg.errorCode || 'error'}`);
            break;

        case 'device.save_preset':
            flashMessage(msg.success ? `Saved preset P${msg.result.position + 1}` : `Couldn't save preset: ${msg.errorCode || 'error'}`);
            break;

        case 'device.delete_preset':
            flashMessage(msg.success ? `Cleared preset P${msg.result.position + 1}` : `Couldn't clear preset: ${msg.errorCode || 'error'}`);
            break;

        case 'device.calibrate':
            flashMessage(msg.success ? 'Recalibrating… the camera will sweep its full range' : `Calibration failed: ${msg.errorCode || 'error'}`);
            break;

        case 'device.set_motion_tracking':
            if (!msg.success) {
                flashMessage(`Couldn't change auto-tracking: ${msg.errorCode || 'error'}`);
                const dev = devices[currentDeviceSN];
                if (dev) { dev.motionTracking = !dev.motionTracking; updateLiveControls(); }
            }
            break;

        case 'device.get_commands':
            if (msg.result?.commands) {
                const sn = msg.result.serialNumber;
                const cmds = msg.result.commands;
                if (devices[sn]) {
                    devices[sn].canStream = cmds.includes('deviceStartLivestream');
                    devices[sn].canAlarm = cmds.includes('triggerDeviceAlarmSound');
                    devices[sn].canTalkback = cmds.includes('deviceStartTalkback');
                    devices[sn].canPanTilt = cmds.includes('devicePanAndTilt');
                    devices[sn].canPresetPosition = cmds.includes('devicePresetPosition');
                    devices[sn].canSavePreset = cmds.includes('deviceSavePresetPosition');
                    devices[sn].canDeletePreset = cmds.includes('deviceDeletePresetPosition');
                    devices[sn].canCalibrate = cmds.includes('deviceCalibrate');
                    devices[sn].canQuickResponse = cmds.includes('deviceQuickResponse');
                    if (currentDeviceSN === sn) renderLiveControls();
                }
                renderCameraGrid();
            }
            break;
    }
}

function handleEvent(msg) {
    const evt = msg.event;
    if (!evt) return;

    switch (evt.event) {
        case 'property changed':
            if (evt.source === 'device') {
                const dev = devices[evt.serialNumber];
                if (!dev) break;

                if (evt.name === 'picture') {
                    dev.picture = evt.value;
                    renderCameraGrid();
                } else if (evt.name === 'light') {
                    dev.lightOn = !!evt.value;
                    if (currentDeviceSN === evt.serialNumber) updateLiveControls();
                } else if (evt.name === 'nightvision') {
                    dev.nightvisionValue = evt.value;
                    if (currentDeviceSN === evt.serialNumber) updateLiveControls();
                } else if (evt.name === 'motionTracking') {
                    dev.motionTracking = !!evt.value;
                    if (currentDeviceSN === evt.serialNumber) updateLiveControls();
                }
            }
            break;

        case 'eufy connected':
        case 'eufy reconnected':
            // Server reconnected to Eufy — re-request device data
            wsSend({ command: 'start_listening', messageId: 'start_listening' });
            break;

        case 'history_progress':
            if (evt.id === historyPlayingId) setHistoryStatus(`Downloading from camera… ${evt.pct}%`);
            break;

        case 'history_ready':
            if (evt.id === historyPlayingId) playHistoryClip(evt.url);
            markHistoryCached(evt.id);
            break;

        case 'history_error':
            if (evt.id === historyPlayingId) setHistoryStatus(`Couldn't load clip: ${evt.message}`);
            break;

        case 'snapshot_all_start':
            snapshotAllInProgress = true;
            armSnapshotAllWatchdog();
            updateSnapshotAllButton(0, evt.total);
            break;

        case 'snapshot_all_progress':
            snapshotAllInProgress = true;
            armSnapshotAllWatchdog();
            updateSnapshotAllButton(evt.completed, evt.total);
            break;

        case 'snapshot_all_done':
            snapshotAllInProgress = false;
            clearTimeout(snapshotAllWatchdog);
            snapshotAllWatchdog = null;
            updateSnapshotAllButton();
            if (evt.failed?.length) {
                const names = evt.failed.map(f => devices[f.serialNumber]?.name || f.name).join(', ');
                flashMessage(`Updated ${evt.total - evt.failed.length}/${evt.total} — no picture from ${names}`, 6000);
            }
            break;

        case 'eufy reconnecting':
            setConnectionDot('connecting');
            break;

        case 'eufy reconnect failed':
            setConnectionDot('disconnected');
            break;

        case 'motion detected':
        case 'person detected':
        case 'pet detected':
        case 'vehicle detected':
        case 'crying detected':
        case 'sound detected':
        case 'ring':
        case 'stranger detected':
        case 'dog detected':
        case 'dog lick detected':
        case 'dog poop detected':
        case 'familiar face':
        case 'activity detected':
            // Only the server's unified detection broadcast carries a label; the
            // raw per-library-event broadcasts would double up the timeline.
            if (evt.state !== false && evt.label) {
                addTimelineEvent(evt);
                // With background push enabled the service worker already shows
                // this alert — don't show a second one from the page.
                if (localStorage.getItem('pushEnabled') !== '1' &&
                    Notification.permission === 'granted' && isNotificationEnabled(evt.serialNumber, evt.event)) {
                    showAppNotification(evt.label, {
                        body: `Camera: ${devices[evt.serialNumber]?.name || evt.serialNumber}`,
                        tag: `${evt.serialNumber}:${evt.event}`
                    });
                }
            }
            break;
    }
}

// ============================================================================
// Camera Grid
// ============================================================================

function getDeviceHouseId(sn) {
    return deviceHouseMap[sn] || '_ungrouped';
}

function getHouseName(houseId) {
    if (houseId === '_ungrouped') return null;
    return houses[houseId]?.house_name || houseId;
}

let lastGridFingerprint = '';

function renderCameraGrid() {
    const grid = document.getElementById('camera-grid');
    const sns = Object.keys(devices);

    if (sns.length === 0) {
        grid.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px">Discovering devices...</p>';
        lastGridFingerprint = '';
        return;
    }

    // Group devices by house (location)
    const groups = {};
    sns.forEach(sn => {
        const houseId = getDeviceHouseId(sn);
        if (!groups[houseId]) groups[houseId] = [];
        groups[houseId].push(sn);
    });

    const groupKeys = Object.keys(groups);
    const hasMultipleGroups = groupKeys.length > 1 || (groupKeys.length === 1 && groupKeys[0] !== '_ungrouped');

    // Build a fingerprint of house→device mapping to detect when structure changes
    const fingerprint = groupKeys.map(g => g + ':' + groups[g].join(',')).join('|');

    // Rebuild DOM when structure changes
    if (fingerprint !== lastGridFingerprint) {
        lastGridFingerprint = fingerprint;
        grid.innerHTML = '';

        groupKeys.forEach(houseId => {
            // House group label (only when multiple houses)
            if (hasMultipleGroups) {
                const label = document.createElement('div');
                label.className = 'station-label';
                label.dataset.house = houseId;
                label.textContent = getHouseName(houseId) || houseId;
                grid.appendChild(label);
            }

            groups[houseId].forEach(sn => {
                const card = document.createElement('div');
                card.className = 'camera-card';
                card.dataset.sn = sn;
                card.addEventListener('click', () => openModeChooser(sn));
                card.innerHTML = `
                    <div class="camera-thumb"><span class="no-preview">&#128247;</span></div>
                    <div class="camera-info">
                        <div class="camera-name">${devices[sn].name || sn}</div>
                        <div class="camera-status">${modelName(devices[sn].model)}</div>
                    </div>
                `;
                grid.appendChild(card);
            });
        });
    }

    // Update house labels (names may arrive after initial render)
    grid.querySelectorAll('.station-label').forEach(label => {
        const houseId = label.dataset.house;
        const name = getHouseName(houseId);
        if (name) label.textContent = name;
    });

    // Update thumbnails and names
    sns.forEach(sn => {
        const card = grid.querySelector(`[data-sn="${sn}"]`);
        if (!card) return;

        const nameEl = card.querySelector('.camera-name');
        if (nameEl) nameEl.textContent = devices[sn].name || sn;

        const statusEl = card.querySelector('.camera-status');
        if (statusEl) {
            const parts = [];
            if (devices[sn].model) parts.push(modelName(devices[sn].model));
            if (devices[sn].battery != null) parts.push(devices[sn].battery + '%');
            statusEl.textContent = parts.join(' \u00B7 ');
        }

        // Update thumbnail if picture data is available
        const thumb = card.querySelector('.camera-thumb');
        if (devices[sn].picture?.data?.data) {
            try {
                const pic = devices[sn].picture;
                const mime = pic.type?.mime || 'image/jpeg';
                const blob = new Blob([new Uint8Array(pic.data.data)], { type: mime });
                const existingImg = thumb.querySelector('img');
                if (existingImg) {
                    // Revoke old blob URL and update src
                    URL.revokeObjectURL(existingImg.src);
                    existingImg.src = URL.createObjectURL(blob);
                } else {
                    const img = document.createElement('img');
                    img.src = URL.createObjectURL(blob);
                    thumb.innerHTML = '';
                    thumb.appendChild(img);
                }
            } catch (e) { /* keep placeholder */ }
        }
    });
}

// ============================================================================
// Snapshot All
// ============================================================================

function startSnapshotAll() {
    if (snapshotAllInProgress) return;
    if (isStreaming) return; // Don't interrupt an active live view
    snapshotAllInProgress = true;
    armSnapshotAllWatchdog();
    updateSnapshotAllButton(0, 0);
    wsSend({ command: 'snapshot_all', messageId: 'snapshot_all' });
}

// The server reports after every camera (~30s worst case each). If that goes
// quiet — e.g. the phone slept and missed the final event — free the button.
function armSnapshotAllWatchdog() {
    clearTimeout(snapshotAllWatchdog);
    snapshotAllWatchdog = setTimeout(() => {
        snapshotAllWatchdog = null;
        snapshotAllInProgress = false;
        updateSnapshotAllButton();
    }, 45000);
}

function updateSnapshotAllButton(completed, total) {
    const btn = document.getElementById('snapshot-all-btn');
    if (snapshotAllInProgress) {
        btn.classList.add('busy');
        btn.disabled = true;
        btn.innerHTML = total > 0 ? `${completed}/${total}` : '...';
    } else {
        btn.classList.remove('busy');
        btn.disabled = false;
        btn.innerHTML = '&#128247;';
    }
}

// ============================================================================
// Live Video
// ============================================================================

// ============================================================================
// Mode Chooser (HD Stream vs Data Saver)
// ============================================================================

function openModeChooser(serialNumber) {
    pendingModeSN = serialNumber;
    const dev = devices[serialNumber] || {};
    document.getElementById('mode-title').textContent = dev.name || serialNumber;
    // Fast local stream (RTSP) preference: admin-only, for cameras that support it.
    // The server enables RTSP on the camera only while you're watching and turns
    // it back off shortly after you leave — this toggle just picks whether this
    // camera uses it.
    const rtspBtn = document.getElementById('mode-rtsp');
    if (currentUser?.admin && dev.rtspSupported) {
        rtspBtn.classList.remove('hidden');
        const on = rtspPref(serialNumber);
        document.getElementById('mode-rtsp-label').textContent =
            on ? 'Fast local stream: On' : 'Fast local stream: Off';
        document.getElementById('mode-rtsp-note').textContent = on
            ? 'HD Stream uses the faster LAN feed while watching, then turns off automatically.'
            : 'Tap to use the faster LAN feed for this camera (falls back to P2P when asleep).';
    } else {
        rtspBtn.classList.add('hidden');
    }
    document.getElementById('mode-overlay').classList.remove('hidden');
}

// Per-camera preference: should HD Stream use the RTSP fast path for this
// camera? Default on for capable cameras. The camera's RTSP is enabled only
// while watching (server-managed) so there's no lasting battery cost.
function rtspPref(sn) {
    try { return localStorage.getItem('rtsp:' + sn) !== '0'; } catch (e) { return true; }
}
function toggleRtsp(sn) {
    if (!sn) return;
    const on = !rtspPref(sn);
    try { localStorage.setItem('rtsp:' + sn, on ? '1' : '0'); } catch (e) {}
    flashMessage(on ? 'Fast local stream on for this camera' : 'Fast local stream off for this camera', 2500);
    if (pendingModeSN === sn && !document.getElementById('mode-overlay').classList.contains('hidden')) {
        openModeChooser(sn);  // refresh label
    }
}

function closeModeChooser() {
    document.getElementById('mode-overlay').classList.add('hidden');
    pendingModeSN = null;
}

// ----------------------------------------------------------------------------
// Android-style back handling
// The app is one page inside Chrome, so the hardware/swipe back gesture walks
// browser history — and the entry before the camera grid is the OAuth redirect,
// which is why back from a live view dumped you at the login prompt. Instead we
// trap back and do in-app navigation (close the topmost overlay → leave the live
// view → return to the grid), and keep re-arming a sentinel history entry so a
// back press can never pop off the page to the login URL. Exit the app with the
// system home gesture, like a native app.
function appBack() {
    const isOpen = (id) => { const el = document.getElementById(id); return el && !el.classList.contains('hidden'); };
    const isActive = (id) => { const el = document.getElementById(id); return el && el.classList.contains('active'); };
    if (isOpen('captcha-overlay')) { document.getElementById('captcha-overlay').classList.add('hidden'); return; }
    if (isOpen('mode-overlay')) { closeModeChooser(); return; }
    if (isOpen('qr-overlay')) { closeQuickReplies(); return; }
    if (isOpen('settings-overlay')) { closeSettings(); return; }
    if (document.body.classList.contains('live-active')) { stopLiveView(); return; }
    if (isActive('access-screen')) { closeAccessPage(); return; }
    if (isActive('timeline-screen')) { showScreen('cameras-screen'); return; }
    if (isActive('history-screen')) {
        if (historyPlayingId) closeHistoryPlayer(); else closeHistory();
        return;
    }
    if (isActive('health-screen')) { showScreen('cameras-screen'); return; }
    // Already at the camera grid — nothing to go back to; stay put.
}

function initBackTrap() {
    try { history.pushState({ ev: 'sentinel' }, ''); } catch (e) {}
    window.addEventListener('popstate', () => {
        appBack();
        try { history.pushState({ ev: 'sentinel' }, ''); } catch (e) {}  // re-arm
    });
}

// Open a camera's mode chooser in response to a tapped push notification.
function openCameraFromNotification(sn) {
    deepLinkCamera = null;
    if (!sn) return;
    // Leave any live view / other screen and present the chooser on the grid.
    if (typeof stopLiveView === 'function' && currentDeviceSN) { try { stopLiveView(); } catch (e) {} }
    showScreen('cameras-screen');
    openModeChooser(sn);
}

function chooseMode(mode) {
    const sn = pendingModeSN;
    closeModeChooser();
    if (sn) startLiveView(sn, mode);
}

// Reload the current live stream (handy if it comes up black). Same camera+mode.
function reloadLiveView() {
    if (!currentDeviceSN) return;
    const sn = currentDeviceSN, mode = liveMode;
    if (typeof stopVideoStream === 'function') stopVideoStream();
    if (typeof stopFrameView === 'function') stopFrameView();
    startLiveView(sn, mode);
}

function startLiveView(serialNumber, mode = 'stream') {
    currentDeviceSN = serialNumber;
    liveMode = mode;
    const dev = devices[serialNumber];

    document.getElementById('live-title').textContent = dev?.name || serialNumber;
    document.getElementById('live-error').classList.add('hidden');
    document.getElementById('live-loading').classList.remove('hidden');
    document.getElementById('live-buffer').textContent = '';

    const video = document.getElementById('live-video');
    const frameImg = document.getElementById('live-frame');
    const muteBtn = document.getElementById('live-mute-btn');
    const pipBtn = document.getElementById('live-pip-btn');

    showScreen('live-screen');

    if (mode === 'frame') {
        // Data Saver: refreshing still image, no audio/video element
        video.classList.add('hidden');
        frameImg.classList.remove('hidden');
        muteBtn.classList.add('hidden');   // audio-only buttons don't apply
        pipBtn.classList.add('hidden');
        startFrameView(serialNumber);
    } else {
        // Full fMP4 live stream via MSE
        frameImg.classList.add('hidden');
        video.classList.remove('hidden');
        muteBtn.classList.remove('hidden');
        startVideoStream(serialNumber);
        // Show PiP button if supported
        if (document.pictureInPictureEnabled) {
            pipBtn.classList.remove('hidden');
        }
    }

    renderLiveControls();
    setupSwipeGestures();
    setupZoomGestures();
    acquireWakeLock();
    document.body.classList.add('live-active');
}

function stopLiveView() {
    stopVideoStream();
    stopFrameView();
    stopTalkback();
    cleanupSwipeGestures();
    cleanupZoomGestures();
    resetZoom();
    cleanupLiveControls();
    releaseWakeLock();
    document.body.classList.remove('live-active');

    // Exit PiP if active
    if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
    }
    document.getElementById('live-pip-btn').classList.add('hidden');

    currentDeviceSN = null;
    showScreen('cameras-screen');
}

function startVideoStream(serialNumber) {
    const video = document.getElementById('live-video');
    if (isStreaming) stopVideoStream();

    isStreaming = true;
    mediaSource = new MediaSource();
    video.src = URL.createObjectURL(mediaSource);

    mediaSource.addEventListener('sourceopen', async () => {
        try {
            sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.64001f, mp4a.40.2"');
            sourceBuffer.mode = 'sequence';
            fetchStream(serialNumber);
        } catch (e) {
            showLiveError('SourceBuffer error: ' + e.message);
            stopVideoStream();
        }
    });
}

async function fetchStream(serialNumber, forcePath) {
    fetchController = new AbortController();
    const video = document.getElementById('live-video');
    const bufferEl = document.getElementById('live-buffer');

    // RTSP fast path: when this camera has its local RTSP stream enabled, pull
    // from it (lower latency, no P2P slot) instead of the P2P pipeline.
    const useRtsp = forcePath ? forcePath.startsWith('/rtsp/') : (!!devices[serialNumber]?.rtspSupported && rtspPref(serialNumber));
    const streamPath = forcePath || (useRtsp ? `/rtsp/${serialNumber}.mp4` : `/${serialNumber}.mp4`);
    let received = 0;
    // A battery camera's RTSP stream is only up while it's awake (404 when
    // asleep), so if RTSP yields nothing, quietly fall back to P2P.
    const fallbackToP2P = () => {
        if (useRtsp && received < 2048 && isStreaming) {
            fetchStream(serialNumber, `/${serialNumber}.mp4`);
            return true;
        }
        return false;
    };
    try {
        const response = await fetch(streamPath, {
            signal: fetchController.signal
        });

        if (!response.ok) {
            if (fallbackToP2P()) return;
            if (response.status === 409) {
                const err = await response.json();
                throw new Error(`Another camera is streaming: ${err.currentDevice}`);
            }
            throw new Error(`Stream unavailable (HTTP ${response.status})`);
        }

        document.getElementById('live-loading').classList.add('hidden');
        const reader = response.body.getReader();

        while (isStreaming) {
            const { done, value } = await reader.read();
            if (done) {
                if (fallbackToP2P()) return;
                showLiveError('Stream ended by server');
                stopVideoStream();
                break;
            }
            received += value.length;

            if (sourceBuffer && !sourceBuffer.updating) {
                try {
                    sourceBuffer.appendBuffer(value);

                    if (video.paused && video.readyState >= 2) {
                        video.play().catch(() => {});
                    }

                    // Buffer management
                    if (video.buffered.length > 0) {
                        const buffered = video.buffered.end(0) - video.currentTime;
                        bufferEl.textContent = buffered.toFixed(1) + 's';

                        // Keep near live edge
                        if (buffered > 3) {
                            video.currentTime = video.buffered.end(0) - 0.5;
                        }
                    }
                } catch (e) {
                    if (e.name === 'QuotaExceededError' && sourceBuffer.buffered.length > 0) {
                        const removeEnd = sourceBuffer.buffered.end(0) - 10;
                        if (removeEnd > 0) sourceBuffer.remove(0, removeEnd);
                    }
                }
            }

            // Wait for buffer update
            await new Promise(resolve => {
                if (!sourceBuffer || !sourceBuffer.updating) resolve();
                else sourceBuffer.addEventListener('updateend', resolve, { once: true });
            });
        }
    } catch (e) {
        if (e.name !== 'AbortError') {
            if (fallbackToP2P()) return;
            showLiveError(e.message);
            stopVideoStream();
        }
    }
}

function stopVideoStream() {
    isStreaming = false;

    if (fetchController) {
        fetchController.abort();
        fetchController = null;
    }

    if (mediaSource && mediaSource.readyState === 'open') {
        try { mediaSource.endOfStream(); } catch (e) {}
    }

    const video = document.getElementById('live-video');
    if (video) {
        if (video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
        video.src = '';
        video.pause();
    }

    sourceBuffer = null;
    mediaSource = null;
}

function showLiveError(msg) {
    const el = document.getElementById('live-error');
    el.textContent = msg;
    el.classList.remove('hidden');
    document.getElementById('live-loading').classList.add('hidden');
}

// ============================================================================
// Frame View (Data Saver) — low-bandwidth JPEG polling
// ============================================================================

function startFrameView(serialNumber) {
    frameDevice = serialNumber;
    frameLoopActive = true;
    frameEtag = null;
    frameCount = 0;

    const img = document.getElementById('live-frame');
    if (img.dataset.url) { URL.revokeObjectURL(img.dataset.url); delete img.dataset.url; }
    img.src = '';

    // Show a live fps counter (reuses the buffer indicator slot)
    const bufferEl = document.getElementById('live-buffer');
    if (frameFpsTimer) clearInterval(frameFpsTimer);
    frameFpsTimer = setInterval(() => {
        if (!frameLoopActive) return;
        bufferEl.textContent = frameCount + ' fps';
        frameCount = 0;
    }, 1000);

    loadNextFrame();
}

async function loadNextFrame() {
    if (!frameLoopActive) return;

    const targetFps = parseInt(config?.FRAME_FPS, 10) || 2;
    const minInterval = 1000 / targetFps;
    const start = Date.now();

    try {
        const headers = {};
        if (frameEtag) headers['If-None-Match'] = frameEtag;

        const res = await fetch(`/frame/${frameDevice}.jpg`, { headers, cache: 'no-store' });

        if (!frameLoopActive) return;

        if (res.status === 200) {
            frameEtag = res.headers.get('ETag');
            const blob = await res.blob();
            if (!frameLoopActive) return;
            const url = URL.createObjectURL(blob);
            const img = document.getElementById('live-frame');
            if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
            img.src = url;
            img.dataset.url = url;
            document.getElementById('live-loading').classList.add('hidden');
            frameCount++;
        }
        // 304 (no new frame) and 503 (not ready) just fall through to reschedule
    } catch (e) {
        // Network hiccup — keep trying
    }

    if (!frameLoopActive) return;
    const elapsed = Date.now() - start;
    setTimeout(loadNextFrame, Math.max(50, minInterval - elapsed));
}

function stopFrameView() {
    if (!frameLoopActive && !frameDevice) return;
    frameLoopActive = false;

    if (frameFpsTimer) { clearInterval(frameFpsTimer); frameFpsTimer = null; }

    // Tell the server to stop the camera immediately (don't wait for its watchdog)
    if (frameDevice) {
        fetch('/frame/stop').catch(() => {});
    }
    frameDevice = null;
    frameEtag = null;

    const img = document.getElementById('live-frame');
    if (img) {
        if (img.dataset.url) { URL.revokeObjectURL(img.dataset.url); delete img.dataset.url; }
        img.src = '';
    }
}

function toggleMute() {
    const video = document.getElementById('live-video');
    const btn = document.getElementById('live-mute-btn');
    video.muted = !video.muted;
    btn.innerHTML = video.muted ? '&#128263;' : '&#128266;';
}

function toggleFullscreen() {
    const container = document.getElementById('live-container');
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
        container.requestFullscreen().catch(() => {});
    }
}

// ============================================================================
// Settings
// ============================================================================

function openSettings() {
    config = config || {};
    document.getElementById('cfg-scale').value = config.VIDEO_SCALE || '';
    document.getElementById('cfg-crf').value = config.TRANSCODING_CRF || '23';
    document.getElementById('cfg-crf-val').textContent = config.TRANSCODING_CRF || '23';

    document.getElementById('cfg-frame-fps').value = config.FRAME_FPS || '2';
    document.getElementById('cfg-frame-scale').value = config.FRAME_SCALE || '640:-2';
    document.getElementById('cfg-frame-quality').value = config.FRAME_QUALITY || '7';
    document.getElementById('cfg-frame-quality-val').textContent = config.FRAME_QUALITY || '7';

    renderPushButton(localStorage.getItem('pushEnabled') === '1');
    renderNotifToggles();
    renderAccessSection();
    startNotifStatusTimer();
    document.getElementById('settings-overlay').classList.remove('hidden');
}

function closeSettings() {
    stopNotifStatusTimer();
    document.getElementById('settings-overlay').classList.add('hidden');
}

async function onSettingsSave() {
    const newConfig = {
        VIDEO_SCALE: document.getElementById('cfg-scale').value,
        TRANSCODING_CRF: document.getElementById('cfg-crf').value,
        FRAME_FPS: document.getElementById('cfg-frame-fps').value,
        FRAME_SCALE: document.getElementById('cfg-frame-scale').value,
        FRAME_QUALITY: document.getElementById('cfg-frame-quality').value
    };

    try {
        const result = await fetchJSON('/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newConfig)
        });

        if (result.success) {
            config = result.config;
            closeSettings();
        }
    } catch (e) {
        console.error('Settings save error:', e);
    }
}

// ============================================================================
// Dynamic Live Controls (Night Vision, Spotlight, Siren, Talkback)
// ============================================================================

function renderLiveControls() {
    const dev = devices[currentDeviceSN];
    if (!dev) return;

    // Remove any previously rendered dynamic controls
    cleanupLiveControls();

    const controls = document.getElementById('live-controls');

    // Night vision toggle
    if (dev.hasNightvision) {
        const btn = document.createElement('button');
        btn.className = 'btn-icon dynamic-ctrl';
        btn.id = 'ctrl-nightvision';
        btn.title = 'Night Vision';
        btn.innerHTML = '&#127769;'; // moon
        if (dev.nightvisionValue) btn.classList.add('active');
        btn.addEventListener('click', toggleNightvision);
        controls.appendChild(btn);
    }

    // Spotlight toggle
    if (dev.hasLight) {
        const btn = document.createElement('button');
        btn.className = 'btn-icon dynamic-ctrl';
        btn.id = 'ctrl-light';
        btn.title = 'Spotlight';
        btn.innerHTML = '&#128161;'; // light bulb
        if (dev.lightOn) btn.classList.add('active');
        btn.addEventListener('click', toggleLight);
        controls.appendChild(btn);
    }

    // Siren toggle
    if (dev.canAlarm) {
        const btn = document.createElement('button');
        btn.className = 'btn-icon dynamic-ctrl siren-btn';
        btn.id = 'ctrl-siren';
        btn.title = 'Siren';
        btn.innerHTML = '&#128680;'; // rotating light
        btn.addEventListener('click', toggleSiren);
        controls.appendChild(btn);
    }

    // Push-to-talk button
    if (dev.canTalkback) {
        const btn = document.createElement('button');
        btn.className = 'btn-icon dynamic-ctrl talk-btn';
        btn.id = 'ctrl-talk';
        btn.title = 'Push to Talk';
        btn.innerHTML = '&#127908;'; // microphone
        btn.addEventListener('mousedown', () => startTalkback());
        btn.addEventListener('mouseup', () => stopTalkback());
        btn.addEventListener('mouseleave', () => { if (talkbackActive) stopTalkback(); });
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); startTalkback(); });
        btn.addEventListener('touchend', (e) => { e.preventDefault(); stopTalkback(); });
        btn.addEventListener('touchcancel', () => stopTalkback());
        controls.appendChild(btn);
    }

    // Doorbell quick replies
    if (dev.canQuickResponse) {
        const btn = document.createElement('button');
        btn.className = 'btn-icon dynamic-ctrl';
        btn.id = 'ctrl-quick-reply';
        btn.title = 'Quick reply';
        btn.innerHTML = '&#128172;'; // speech balloon
        btn.addEventListener('click', openQuickReplies);
        controls.appendChild(btn);
    }

    // Auto-tracking (camera follows moving people)
    if (dev.hasMotionTracking) {
        const btn = document.createElement('button');
        btn.className = 'btn-icon dynamic-ctrl';
        btn.id = 'ctrl-tracking';
        btn.title = 'Auto-tracking';
        btn.innerHTML = '&#127919;'; // direct hit
        if (dev.motionTracking) btn.classList.add('active');
        btn.addEventListener('click', toggleMotionTracking);
        controls.appendChild(btn);
    }

    // Recalibrate pan & tilt
    if (dev.canCalibrate) {
        const btn = document.createElement('button');
        btn.className = 'btn-icon dynamic-ctrl';
        btn.id = 'ctrl-calibrate';
        btn.title = 'Recalibrate pan & tilt';
        btn.innerHTML = '&#10226;'; // anticlockwise open circle arrow
        btn.addEventListener('click', () => {
            if (confirm('Recalibrate this camera? It will sweep its full pan and tilt range, then return.')) {
                wsSend({ command: 'device.calibrate', serialNumber: currentDeviceSN });
            }
        });
        controls.appendChild(btn);
    }

    // Preset position pills
    renderPresetPills();

    // Pan/tilt D-pad
    renderPanTiltPad();
}

function cleanupLiveControls() {
    document.querySelectorAll('.dynamic-ctrl').forEach(el => el.remove());
    const pills = document.querySelector('.preset-pills');
    if (pills) pills.remove();
    const editBar = document.querySelector('.preset-edit-bar');
    if (editBar) editBar.remove();
    presetEditing = false;
    const dpad = document.querySelector('.ptz-dpad');
    if (dpad) dpad.remove();
}

function updateLiveControls() {
    const dev = devices[currentDeviceSN];
    if (!dev) return;

    const nvBtn = document.getElementById('ctrl-nightvision');
    if (nvBtn) nvBtn.classList.toggle('active', !!dev.nightvisionValue);

    const lightBtn = document.getElementById('ctrl-light');
    if (lightBtn) lightBtn.classList.toggle('active', !!dev.lightOn);

    const trackBtn = document.getElementById('ctrl-tracking');
    if (trackBtn) trackBtn.classList.toggle('active', !!dev.motionTracking);
}

function toggleMotionTracking() {
    const dev = devices[currentDeviceSN];
    if (!dev) return;
    dev.motionTracking = !dev.motionTracking;
    wsSend({ command: 'device.set_motion_tracking', serialNumber: currentDeviceSN, value: dev.motionTracking });
    updateLiveControls();
    flashMessage(dev.motionTracking ? 'Auto-tracking on' : 'Auto-tracking off');
}

function toggleNightvision() {
    const dev = devices[currentDeviceSN];
    if (!dev) return;
    const newVal = dev.nightvisionValue ? 0 : 1;
    wsSend({ command: 'device.set_nightvision', serialNumber: currentDeviceSN, value: newVal });
    dev.nightvisionValue = newVal;
    updateLiveControls();
}

function toggleLight() {
    const dev = devices[currentDeviceSN];
    if (!dev) return;
    const newVal = !dev.lightOn;
    wsSend({ command: 'device.switch_light', serialNumber: currentDeviceSN, value: newVal });
    dev.lightOn = newVal;
    updateLiveControls();
}

let sirenActive = false;
function toggleSiren() {
    sirenActive = !sirenActive;
    wsSend({ command: 'device.trigger_alarm', serialNumber: currentDeviceSN, value: sirenActive, seconds: 10 });
    const btn = document.getElementById('ctrl-siren');
    if (btn) btn.classList.toggle('active', sirenActive);
}

// ============================================================================
// Picture-in-Picture
// ============================================================================

function togglePiP() {
    const video = document.getElementById('live-video');
    if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
    } else if (document.pictureInPictureEnabled) {
        video.requestPictureInPicture().catch(() => {});
    }
}

// ============================================================================
// PTZ Swipe Gestures
// ============================================================================

function setupSwipeGestures() {
    const container = document.getElementById('live-container');
    container.addEventListener('touchstart', onSwipeTouchStart, { passive: true });
    container.addEventListener('touchend', onSwipeTouchEnd, { passive: true });
}

function cleanupSwipeGestures() {
    const container = document.getElementById('live-container');
    container.removeEventListener('touchstart', onSwipeTouchStart);
    container.removeEventListener('touchend', onSwipeTouchEnd);
}

function onSwipeTouchStart(e) {
    if (e.touches.length !== 1 || zoomScale > 1) return;
    // Don't interfere with back button or other UI controls
    if (isTargetBackButton(e.target) || e.target.closest('#live-header') || e.target.closest('#live-controls')) {
        return;
    }
    const touch = e.touches[0];
    swipeTouchId = touch.identifier;
    swipeStartX = touch.clientX;
    swipeStartY = touch.clientY;
    swipeStartTime = Date.now();
}

function onSwipeTouchEnd(e) {
    if (zoomScale > 1) return;
    const touch = Array.from(e.changedTouches).find(t => t.identifier === swipeTouchId);
    if (!touch) return;
    swipeTouchId = null;

    const dx = touch.clientX - swipeStartX;
    const dy = touch.clientY - swipeStartY;
    const elapsed = Date.now() - swipeStartTime;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Require >50px distance in <500ms
    if (dist < 50 || elapsed > 500) return;

    const isHorizontal = Math.abs(dx) > Math.abs(dy);

    // Swipe right (finger moves right) = go back to camera grid
    if (isHorizontal && dx > 0) {
        stopLiveView();
        return;
    }

    // PTZ swipe gestures (only for PTZ cameras)
    const dev = devices[currentDeviceSN];
    if (!dev?.canPanTilt) return;

    let direction;
    let arrow;
    if (isHorizontal) {
        // dx < 0 here (swipe left) = pan right
        direction = 2;
        arrow = '\u2192';
    } else {
        direction = dy > 0 ? 4 : 3; // swipe down = tilt down, swipe up = tilt up
        arrow = dy > 0 ? '\u2193' : '\u2191';
    }

    wsSend({ command: 'device.pan_and_tilt', serialNumber: currentDeviceSN, direction });
    showSwipeIndicator(arrow);
}

function showSwipeIndicator(arrow) {
    const container = document.getElementById('live-container');
    // Remove existing indicator
    const old = container.querySelector('.swipe-indicator');
    if (old) old.remove();

    const el = document.createElement('div');
    el.className = 'swipe-indicator';
    el.textContent = arrow;
    container.appendChild(el);

    setTimeout(() => el.remove(), 600);
}

// Preset editing: the pencil pill toggles edit mode; in edit mode tapping
// P1-P4 offers "Save current view here" / "Clear" instead of moving the camera.
let presetEditing = false;

function renderPresetPills() {
    const dev = devices[currentDeviceSN];
    if (!dev?.canPresetPosition && !dev?.canSavePreset) return;

    const container = document.getElementById('live-container');
    const pills = document.createElement('div');
    pills.className = 'preset-pills';

    for (let i = 0; i < 4; i++) {
        const btn = document.createElement('button');
        btn.className = 'preset-pill';
        btn.textContent = 'P' + (i + 1);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (presetEditing) showPresetEditBar(i);
            else wsSend({ command: 'device.preset_position', serialNumber: currentDeviceSN, position: i });
        });
        pills.appendChild(btn);
    }

    if (dev.canSavePreset) {
        const edit = document.createElement('button');
        edit.className = 'preset-pill edit';
        edit.title = 'Edit presets';
        edit.innerHTML = '&#9998;'; // pencil
        edit.addEventListener('click', (e) => {
            e.stopPropagation();
            presetEditing = !presetEditing;
            pills.classList.toggle('editing', presetEditing);
            edit.textContent = presetEditing ? 'Done' : '✎';
            const bar = document.querySelector('.preset-edit-bar');
            if (bar) bar.remove();
            if (presetEditing) flashMessage('Aim the camera, then tap a preset to save it there');
        });
        pills.appendChild(edit);
    }

    container.appendChild(pills);
}

function showPresetEditBar(position) {
    const dev = devices[currentDeviceSN];
    const old = document.querySelector('.preset-edit-bar');
    if (old) old.remove();
    const bar = document.createElement('div');
    bar.className = 'preset-edit-bar';
    const save = document.createElement('button');
    save.className = 'preset-pill';
    save.textContent = `Save view as P${position + 1}`;
    save.addEventListener('click', (e) => {
        e.stopPropagation();
        wsSend({ command: 'device.save_preset', serialNumber: currentDeviceSN, position });
        bar.remove();
    });
    bar.appendChild(save);
    if (dev?.canDeletePreset) {
        const clear = document.createElement('button');
        clear.className = 'preset-pill';
        clear.textContent = 'Clear';
        clear.addEventListener('click', (e) => {
            e.stopPropagation();
            wsSend({ command: 'device.delete_preset', serialNumber: currentDeviceSN, position });
            bar.remove();
        });
        bar.appendChild(clear);
    }
    document.getElementById('live-container').appendChild(bar);
}

function renderPanTiltPad() {
    const dev = devices[currentDeviceSN];
    if (!dev?.canPanTilt) return;

    const container = document.getElementById('live-container');
    const pad = document.createElement('div');
    pad.className = 'ptz-dpad';

    // Directions: 1=LEFT, 2=RIGHT, 3=UP, 4=DOWN
    const dirs = [
        { dir: 3, label: '\u25B2', cls: 'dpad-up' },
        { dir: 1, label: '\u25C0', cls: 'dpad-left' },
        { dir: 2, label: '\u25B6', cls: 'dpad-right' },
        { dir: 4, label: '\u25BC', cls: 'dpad-down' },
    ];

    dirs.forEach(({ dir, label, cls }) => {
        const btn = document.createElement('button');
        btn.className = 'dpad-btn ' + cls;
        btn.textContent = label;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            wsSend({ command: 'device.pan_and_tilt', serialNumber: currentDeviceSN, direction: dir });
        });
        pad.appendChild(btn);
    });

    container.appendChild(pad);
}

// ============================================================================
// Two-Way Audio (Push-to-Talk)
// ============================================================================

async function startTalkback() {
    if (talkbackActive || !currentDeviceSN) return;
    talkbackActive = true;

    const btn = document.getElementById('ctrl-talk');
    if (btn) btn.classList.add('active');

    // Request talkback start from server
    wsSend({ command: 'device.start_talkback', serialNumber: currentDeviceSN });

    try {
        // Get microphone access
        talkbackMicStream = await navigator.mediaDevices.getUserMedia({
            audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
        });

        talkbackAudioCtx = new AudioContext({ sampleRate: 16000 });
        const source = talkbackAudioCtx.createMediaStreamSource(talkbackMicStream);
        const processor = talkbackAudioCtx.createScriptProcessor(4096, 1, 1);

        processor.onaudioprocess = (e) => {
            if (!talkbackActive || !ws || ws.readyState !== WebSocket.OPEN) return;
            const float32 = e.inputBuffer.getChannelData(0);
            // Convert Float32 to Int16 PCM
            const int16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
                const s = Math.max(-1, Math.min(1, float32[i]));
                int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            // Send binary data over WebSocket
            ws.send(int16.buffer);
        };

        source.connect(processor);
        processor.connect(talkbackAudioCtx.destination);
    } catch (e) {
        console.error('Talkback mic error:', e);
        stopTalkback();
    }
}

function stopTalkback() {
    if (!talkbackActive) return;
    talkbackActive = false;

    const btn = document.getElementById('ctrl-talk');
    if (btn) btn.classList.remove('active');

    // Stop mic
    if (talkbackMicStream) {
        talkbackMicStream.getTracks().forEach(t => t.stop());
        talkbackMicStream = null;
    }

    // Close audio context
    if (talkbackAudioCtx) {
        talkbackAudioCtx.close().catch(() => {});
        talkbackAudioCtx = null;
    }

    // Tell server to stop talkback
    if (currentDeviceSN) {
        wsSend({ command: 'device.stop_talkback', serialNumber: currentDeviceSN });
    }
}

// ============================================================================
// Screen Wake Lock
// ============================================================================

async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
        // Wake lock request failed (e.g., low battery)
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
    }
}

// ============================================================================
// Notification Preferences
// ============================================================================

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

function getNotificationPrefs() {
    try {
        return JSON.parse(localStorage.getItem('notifPrefs') || '{}');
    } catch {
        return {};
    }
}

function setNotificationPref(sn, enabled) {
    const prefs = getNotificationPrefs();
    prefs[sn] = enabled;
    localStorage.setItem('notifPrefs', JSON.stringify(prefs));
    // Keep the server's copy in sync so background push respects the toggle
    updatePushPrefs();
}

// ---- Per-camera alert types (this person only) ----
// Categories match the server (push.js EVENT_CATEGORIES).
const ALERT_TYPES = [
    { key: 'ring', label: 'Ring' },
    { key: 'person', label: 'Person' },
    { key: 'pet', label: 'Pet' },
    { key: 'vehicle', label: 'Vehicle' },
    { key: 'package', label: 'Package' },
    { key: 'sound', label: 'Sound' },
    { key: 'motion', label: 'Motion' }
];
const EVENT_CATEGORIES = {
    'ring': 'ring', 'person detected': 'person', 'stranger detected': 'person',
    'familiar face': 'person', 'someone loitering': 'person',
    'pet detected': 'pet', 'dog detected': 'pet', 'dog lick detected': 'pet', 'dog poop detected': 'pet',
    'vehicle detected': 'vehicle', 'crying detected': 'sound', 'sound detected': 'sound',
    'package delivered': 'package', 'package taken': 'package'
};

function categoryOf(event) {
    return EVENT_CATEGORIES[event] || 'motion';
}

// Which alert types a camera can produce, by model family
function alertTypesFor(sn) {
    const model = (devices[sn] && devices[sn].model) || '';
    const isDoorbell = model.startsWith('T82');
    const isIndoor = /^T84[01]/.test(model) || model.startsWith('T8W1');
    return ALERT_TYPES.filter(t => {
        if (t.key === 'ring') return isDoorbell;
        if (t.key === 'package') return ['T8213', 'T8214'].includes(model.slice(0, 5));
        if (t.key === 'sound') return isIndoor;
        if (t.key === 'vehicle') return !isIndoor;
        return true;
    });
}

function getNotificationTypes() {
    try { return JSON.parse(localStorage.getItem('notifTypes') || '{}'); }
    catch { return {}; }
}

function isAlertTypeEnabled(sn, category) {
    const types = getNotificationTypes();
    return !(types[sn] && types[sn][category] === false);
}

function setAlertType(sn, category, enabled) {
    const types = getNotificationTypes();
    if (!types[sn]) types[sn] = {};
    types[sn][category] = enabled;
    localStorage.setItem('notifTypes', JSON.stringify(types));
    updatePushPrefs();
}

function getNotificationStyle() {
    const s = localStorage.getItem('notifStyle');
    return ['full', 'thumb', 'text'].includes(s) ? s : 'full';
}

// Everything the server needs to filter this person's alerts
function pushSettingsBody() {
    return {
        prefs: getNotificationPrefs(),
        mutes: getActiveMutes(),
        types: getNotificationTypes(),
        style: getNotificationStyle()
    };
}

// ---- Temporary per-camera mute ----

function getNotificationMutes() {
    try { return JSON.parse(localStorage.getItem('notifMutes') || '{}'); }
    catch { return {}; }
}

function setNotificationMutes(mutes) {
    localStorage.setItem('notifMutes', JSON.stringify(mutes));
}

// Returns the current mutes with any expired entries pruned
function getActiveMutes() {
    const mutes = getNotificationMutes();
    const now = Date.now();
    let changed = false;
    for (const sn of Object.keys(mutes)) {
        if (!mutes[sn] || mutes[sn] <= now) { delete mutes[sn]; changed = true; }
    }
    if (changed) setNotificationMutes(mutes);
    return mutes;
}

function isCameraMuted(sn) {
    const mutes = getNotificationMutes();
    return !!(mutes[sn] && Date.now() < mutes[sn]);
}

function muteCamera(sn, minutes) {
    // Muting implies notifications are on, so they resume when the mute expires
    const prefs = getNotificationPrefs();
    if (prefs[sn] === false) { prefs[sn] = true; localStorage.setItem('notifPrefs', JSON.stringify(prefs)); }
    const mutes = getNotificationMutes();
    mutes[sn] = Date.now() + minutes * 60000;
    setNotificationMutes(mutes);
    updatePushPrefs();
}

function unmuteCamera(sn) {
    const mutes = getNotificationMutes();
    delete mutes[sn];
    setNotificationMutes(mutes);
    updatePushPrefs();
}

// Current notification status for a camera: { text, cls }
function getCameraNotifStatus(sn) {
    const prefs = getNotificationPrefs();
    if (prefs[sn] === false) return { text: 'Off', cls: 'off' };
    const mutes = getNotificationMutes();
    if (mutes[sn] && Date.now() < mutes[sn]) {
        const msLeft = mutes[sn] - Date.now();
        const minsLeft = Math.ceil(msLeft / 60000);
        return { text: `Muted · ${minsLeft}m`, cls: 'muted' };
    }
    return { text: 'On', cls: 'on' };
}

// Show a notification via the service worker (works in installed PWAs, incl.
// Android, where the Notification constructor is not allowed) with a fallback.
async function showAppNotification(title, opts) {
    try {
        if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.ready;
            await reg.showNotification(title, { icon: '/icon-192.png', badge: '/icon-192.png', renotify: true, ...opts });
            return;
        }
    } catch (e) { /* fall through */ }
    try { new Notification(title, opts); } catch (e) { /* unsupported */ }
}

// ============================================================================
// Background Push (Web Push)
// ============================================================================

function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
}

async function togglePush() {
    if (!pushSupported()) {
        setPushStatus('Background notifications are not supported on this device/browser.');
        return;
    }
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing && localStorage.getItem('pushEnabled') === '1') {
        await disablePush();
    } else {
        await enablePush();
    }
}

async function enablePush() {
    try {
        setPushStatus('Requesting permission…');
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
            setPushStatus('Permission denied. Enable notifications for this app in your browser/OS settings.');
            return;
        }

        const reg = await navigator.serviceWorker.ready;
        const { publicKey } = await fetchJSON('/push/key');
        if (!publicKey) { setPushStatus('Server has no push key.'); return; }

        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey)
            });
        }

        await fetch('/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub, ...pushSettingsBody() })
        });

        localStorage.setItem('pushEnabled', '1');
        renderPushButton(true);
        setPushStatus('Background notifications are ON. Alerts arrive even when the app is closed.');
    } catch (e) {
        console.error('enablePush error:', e);
        setPushStatus('Could not enable background notifications: ' + e.message);
    }
}

async function disablePush() {
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
            await fetch('/push/unsubscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: sub.endpoint })
            });
            await sub.unsubscribe();
        }
        localStorage.setItem('pushEnabled', '0');
        renderPushButton(false);
        setPushStatus('Background notifications are off.');
    } catch (e) {
        console.error('disablePush error:', e);
    }
}

// On load: if push was enabled, re-sync the subscription (it can rotate/expire)
async function refreshPushSubscription() {
    if (!pushSupported()) { renderPushButton(false); return; }
    if (localStorage.getItem('pushEnabled') !== '1' || Notification.permission !== 'granted') {
        renderPushButton(false);
        return;
    }
    try {
        const reg = await navigator.serviceWorker.ready;
        const { publicKey } = await fetchJSON('/push/key');
        if (!publicKey) return;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey)
            });
        }
        await fetch('/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub, ...pushSettingsBody() })
        });
        renderPushButton(true);
    } catch (e) {
        console.error('refreshPushSubscription error:', e);
    }
}

// Push the current per-camera prefs to the server for the active subscription
async function updatePushPrefs() {
    if (!pushSupported() || localStorage.getItem('pushEnabled') !== '1') return;
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) return;
        await fetch('/push/prefs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint, ...pushSettingsBody() })
        });
    } catch (e) { /* best effort */ }
}

function renderPushButton(enabled) {
    const btn = document.getElementById('push-enable-btn');
    if (!btn) return;
    btn.textContent = enabled ? 'Disable background notifications' : 'Enable background notifications';
    btn.classList.toggle('active', enabled);
}

function setPushStatus(msg) {
    const el = document.getElementById('push-status');
    if (el) el.textContent = msg;
}

function isNotificationEnabled(sn, event) {
    const prefs = getNotificationPrefs();
    if (prefs[sn] === false) return false;  // permanently off
    if (isCameraMuted(sn)) return false;    // temporarily muted
    if (event && !isAlertTypeEnabled(sn, categoryOf(event))) return false;
    return true;
}

function renderNotifToggles() {
    const container = document.getElementById('notif-toggles');
    if (!container) return;
    const sns = Object.keys(devices);
    if (sns.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No cameras discovered yet</p>';
        return;
    }

    // Group by house
    const groups = {};
    sns.forEach(sn => {
        const houseId = getDeviceHouseId(sn);
        if (!groups[houseId]) groups[houseId] = [];
        groups[houseId].push(sn);
    });
    const groupKeys = Object.keys(groups);
    const hasMultipleGroups = groupKeys.length > 1 || (groupKeys.length === 1 && groupKeys[0] !== '_ungrouped');

    let rows = '';
    groupKeys.forEach(houseId => {
        if (hasMultipleGroups) {
            rows += `<div class="notif-group-label">${getHouseName(houseId) || houseId}</div>`;
        }
        rows += groups[houseId].map(sn => {
            const dev = devices[sn];
            const st = getCameraNotifStatus(sn);
            const chips = alertTypesFor(sn).map(t => {
                const on = isAlertTypeEnabled(sn, t.key);
                return `<button type="button" class="notif-type${on ? ' on' : ''}" data-sn="${sn}" data-type="${t.key}" aria-pressed="${on}">${t.label}</button>`;
            }).join('');
            return `<div class="notif-row${st.cls === 'off' ? ' disabled' : ''}" data-sn="${sn}">
                <span class="notif-name">${dev.name || sn}</span>
                <div class="notif-types" title="Tap a type to turn its alerts on/off for you">${chips}</div>
                <div class="notif-controls">
                    <span class="notif-status ${st.cls}" data-sn="${sn}">${st.text}</span>
                    <select class="notif-action" data-sn="${sn}" title="Notification settings">
                        <option value="" selected>&#9881; Options</option>
                        <option value="on">Notify: On</option>
                        <option value="m5">Mute 5 min</option>
                        <option value="m15">Mute 15 min</option>
                        <option value="m30">Mute 30 min</option>
                        <option value="m60">Mute 60 min</option>
                        <option value="off">Notify: Off</option>
                    </select>
                </div>
            </div>`;
        }).join('');
    });

    const count = sns.length;
    container.innerHTML = `
        <button type="button" class="notif-accordion-toggle" aria-expanded="false">
            <span>Per-camera alerts</span>
            <span class="notif-accordion-meta">
                <span>${count} camera${count === 1 ? '' : 's'}</span>
                <span class="notif-chevron">&#9662;</span>
            </span>
        </button>
        <div class="notif-accordion-body">
            <div class="notif-accordion-inner">${rows}</div>
        </div>`;

    // Tap the header to expand/collapse the camera list
    const toggle = container.querySelector('.notif-accordion-toggle');
    const body = container.querySelector('.notif-accordion-body');
    toggle.addEventListener('click', () => {
        const open = !body.classList.contains('open');
        body.classList.toggle('open', open);
        toggle.classList.toggle('open', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    container.querySelectorAll('.notif-action').forEach(sel => {
        sel.addEventListener('change', () => {
            onNotifAction(sel.dataset.sn, sel.value);
            sel.value = ''; // reset back to the gear placeholder
        });
    });

    container.querySelectorAll('.notif-type').forEach(chip => {
        chip.addEventListener('click', () => {
            const on = !chip.classList.contains('on');
            setAlertType(chip.dataset.sn, chip.dataset.type, on);
            chip.classList.toggle('on', on);
            chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    });
}

function initNotifStyleSelect() {
    const sel = document.getElementById('notif-style');
    if (!sel) return;
    sel.value = getNotificationStyle();
    sel.addEventListener('change', () => {
        localStorage.setItem('notifStyle', sel.value);
        updatePushPrefs();
    });
}

// Handle a per-camera notification action (on / off / mute N)
function onNotifAction(sn, action) {
    if (!action) return;
    if (action === 'on') {
        unmuteCamera(sn);
        setNotificationPref(sn, true);
    } else if (action === 'off') {
        unmuteCamera(sn);
        setNotificationPref(sn, false);
    } else if (action.startsWith('m')) {
        muteCamera(sn, parseInt(action.slice(1), 10));
    }
    updateNotifStatuses();
}

// Refresh the status label of each camera row (live mute countdown)
function updateNotifStatuses() {
    document.querySelectorAll('.notif-status').forEach(el => {
        const st = getCameraNotifStatus(el.dataset.sn);
        el.textContent = st.text;
        el.className = 'notif-status ' + st.cls;
        const row = el.closest('.notif-row');
        if (row) row.classList.toggle('disabled', st.cls === 'off');
    });
}

let notifStatusTimer = null;
function startNotifStatusTimer() {
    if (notifStatusTimer) clearInterval(notifStatusTimer);
    notifStatusTimer = setInterval(updateNotifStatuses, 1000);
}
function stopNotifStatusTimer() {
    if (notifStatusTimer) { clearInterval(notifStatusTimer); notifStatusTimer = null; }
}

// ============================================================================
// Users & Access (admin only) — add people by Google email and scope cameras
// ============================================================================

// Show + populate the access section if the signed-in user is an admin.
function renderAccessSection() {
    const sec = document.getElementById('access-section');
    if (!sec) return;
    if (!currentUser || !currentUser.admin) { sec.classList.add('hidden'); return; }
    sec.classList.remove('hidden');
    loadAccessData();
}

// Fetch the camera catalog + current users and render the user list.
async function loadAccessData() {
    try {
        const [cams, access] = await Promise.all([
            fetchJSON('/admin/cameras'),
            fetchJSON('/admin/users')
        ]);
        accessCatalog = (cams && cams.cameras) || [];
        renderAccessUsers(access);
    } catch (e) {
        const list = document.getElementById('access-users');
        if (list) list.innerHTML = '<p class="settings-hint">Could not load users.</p>';
    }
}

// ---- Full-screen camera-assignment page ----

// Open the access page for a new user (email = null) or to edit an existing one.
function openAccessPage(email, cameras) {
    accessEditEmail = email || null;
    accessSelected = new Set(cameras || []);
    const emailEl = document.getElementById('access-email');
    emailEl.value = email || '';
    emailEl.readOnly = !!email;            // can't rename an existing person
    document.getElementById('access-title').textContent = email || 'Add user';
    const btn = document.getElementById('access-save-btn');
    btn.textContent = email ? 'Save changes' : 'Create user';
    btn.disabled = false;
    setAccessMsg('');
    renderAccessCamBoxes();
    closeSettings();
    showScreen('access-screen');
    if (!email) { try { emailEl.focus(); } catch (e) {} }
}

// Leave the access page (without saving) and return to Settings.
function closeAccessPage() {
    document.getElementById('access-screen').classList.remove('active');
    showScreen('cameras-screen');
    openSettings();
}

// Render the grid of padded, tappable camera boxes (green = included).
function renderAccessCamBoxes() {
    const box = document.getElementById('access-cameras');
    if (!box) return;
    if (!accessCatalog.length) {
        box.innerHTML = '<p class="settings-hint">No cameras discovered yet.</p>';
        return;
    }
    box.innerHTML = accessCatalog.map(c => {
        const on = accessSelected.has(c.serialNumber) ? ' selected' : '';
        const house = c.houseName ? `<span class="access-cam-house">${c.houseName}</span>` : '';
        return `<div class="access-cam-box${on}" data-sn="${c.serialNumber}">
            <span class="access-cam-name">${c.name || c.serialNumber}</span>
            ${house}
        </div>`;
    }).join('');
}

// Tap a camera box → toggle green (included) / grey (excluded). Local only;
// nothing is saved until the Create user / Save changes button is tapped.
function onAccessCamClick(e) {
    const cell = e.target.closest('.access-cam-box');
    if (!cell) return;
    const sn = cell.dataset.sn;
    if (accessSelected.has(sn)) { accessSelected.delete(sn); cell.classList.remove('selected'); }
    else { accessSelected.add(sn); cell.classList.add('selected'); }
}

// Create user / Save changes → persist, then return to Settings.
async function submitAccessUser() {
    const emailEl = document.getElementById('access-email');
    const email = (emailEl ? emailEl.value : '').trim();
    if (!email || email.indexOf('@') === -1) { setAccessMsg('Enter a valid email address.'); return; }
    const btn = document.getElementById('access-save-btn');
    btn.disabled = true;
    setAccessMsg('Saving…');
    try {
        const r = await fetchJSON('/admin/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, cameras: Array.from(accessSelected) })
        });
        if (r.success) {
            closeAccessPage();
        } else {
            setAccessMsg(r.error || 'Save failed.');
            btn.disabled = false;
        }
    } catch (e) {
        setAccessMsg('Save failed.');
        btn.disabled = false;
    }
}

// Render the existing users list (with admins shown for context).
function renderAccessUsers(access) {
    const list = document.getElementById('access-users');
    if (!list) return;
    const users = (access && access.users) || [];
    const admins = (access && access.admins) || [];
    list._users = users;

    let html = '';
    if (admins.length) {
        html += `<div class="access-admins">Admins (all cameras): ${admins.join(', ')}</div>`;
    }
    if (!users.length) {
        html += '<p class="settings-hint">No additional users yet.</p>';
    } else {
        html += users.map(u => {
            const n = u.cameras === 'all' ? null : (u.cameras || []).length;
            const camLabel = u.cameras === 'all' ? 'All cameras' : `${n} camera${n === 1 ? '' : 's'}`;
            return `<div class="access-user" data-email="${u.email}">
                <span class="access-user-email">${u.email}</span>
                <span class="access-user-cams">${camLabel}</span>
                <button class="access-edit" data-email="${u.email}">Edit</button>
                <button class="access-remove" data-email="${u.email}">Remove</button>
            </div>`;
        }).join('');
    }
    list.innerHTML = html;
}

// Edit/Remove buttons inside the user list (event-delegated).
function onAccessUsersClick(e) {
    const editBtn = e.target.closest('.access-edit');
    const rmBtn = e.target.closest('.access-remove');
    const list = document.getElementById('access-users');
    if (editBtn) {
        const email = editBtn.dataset.email;
        const u = (list._users || []).find(x => x.email === email);
        const cams = u && u.cameras === 'all' ? accessCatalog.map(c => c.serialNumber) : (u ? (u.cameras || []) : []);
        openAccessPage(email, cams);
    } else if (rmBtn) {
        const email = rmBtn.dataset.email;
        if (confirm(`Remove ${email}? They will lose access at next sign-in.`)) removeAccessUser(email);
    }
}

async function removeAccessUser(email) {
    try {
        const r = await fetchJSON('/admin/users', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        if (r.success) loadAccessData();
    } catch (e) {}
}

function setAccessMsg(m) {
    const el = document.getElementById('access-msg');
    if (el) el.textContent = m || '';
}

// ============================================================================
// Event Timeline
// ============================================================================

function addTimelineEvent(evt) {
    timelineEvents.unshift({
        event: evt.event,
        label: evt.label || evt.event,
        serialNumber: evt.serialNumber,
        cameraName: devices[evt.serialNumber]?.name || evt.serialNumber,
        time: new Date()
    });
    if (timelineEvents.length > MAX_TIMELINE_EVENTS) {
        timelineEvents.length = MAX_TIMELINE_EVENTS;
    }
    // Update badge
    const btn = document.getElementById('timeline-btn');
    if (btn && !document.getElementById('timeline-screen').classList.contains('active')) {
        btn.dataset.count = (parseInt(btn.dataset.count || '0') + 1).toString();
        btn.classList.add('has-badge');
    }
    // Re-render if visible
    if (document.getElementById('timeline-screen').classList.contains('active')) {
        renderTimeline();
    }
}

function renderTimeline() {
    const list = document.getElementById('timeline-list');
    const empty = document.getElementById('timeline-empty');
    if (timelineEvents.length === 0) {
        list.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');
    list.innerHTML = timelineEvents.map(evt => {
        const icon = EVENT_ICONS[evt.event] || '\u{1F4F7}';
        const color = EVENT_COLORS[evt.event] || 'var(--text-muted)';
        const timeStr = evt.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `<div class="timeline-entry">
            <div class="timeline-icon" style="background:${color}">${icon}</div>
            <div class="timeline-info">
                <div class="timeline-event">${evt.label}</div>
                <div class="timeline-camera">${evt.cameraName}</div>
            </div>
            <div class="timeline-time">${timeStr}</div>
        </div>`;
    }).join('');
}

function showTimeline() {
    const btn = document.getElementById('timeline-btn');
    btn.dataset.count = '0';
    btn.classList.remove('has-badge');
    showScreen('timeline-screen');
    renderTimeline();
}

function clearTimeline() {
    timelineEvents = [];
    renderTimeline();
}

// ============================================================================
// Camera Health Dashboard
// ============================================================================

function showHealthDashboard() {
    showScreen('health-screen');
    renderHealthDashboard();
}

function renderHealthDashboard() {
    const list = document.getElementById('health-list');
    const sns = Object.keys(devices);
    if (sns.length === 0) {
        list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px">No cameras discovered</p>';
        return;
    }

    // Group by house
    const groups = {};
    sns.forEach(sn => {
        const houseId = getDeviceHouseId(sn);
        if (!groups[houseId]) groups[houseId] = [];
        groups[houseId].push(sn);
    });
    const groupKeys = Object.keys(groups);
    const hasMultipleGroups = groupKeys.length > 1 || (groupKeys.length === 1 && groupKeys[0] !== '_ungrouped');

    let html = '';
    groupKeys.forEach(houseId => {
        if (hasMultipleGroups) {
            html += `<div class="health-station-label">${getHouseName(houseId) || houseId}</div>`;
        }
        html += groups[houseId].map(sn => renderHealthCard(sn)).join('');
    });
    list.innerHTML = html;
}

function renderHealthCard(sn) {
    const dev = devices[sn];
    const battery = dev.battery;
    const rssi = dev.wifiRssi;
    const online = dev.enabled !== false;

    // Battery bar
    let batteryHTML = '';
    if (battery != null) {
        const bColor = battery > 50 ? 'var(--success)' : battery > 20 ? 'var(--warning)' : 'var(--danger)';
        batteryHTML = `<div class="health-stat">
            <span>\u{1F50B} ${battery}%</span>
            <div class="health-battery-bar"><div class="health-battery-fill" style="width:${battery}%;background:${bColor}"></div></div>
        </div>`;
    }

    // WiFi bars
    let wifiHTML = '';
    if (rssi != null) {
        const bars = rssi > -50 ? 4 : rssi > -60 ? 3 : rssi > -70 ? 2 : 1;
        const wifiBars = [1,2,3,4].map(i =>
            `<div class="wifi-bar ${i <= bars ? 'active' : ''}" style="height:${i * 5 + 3}px"></div>`
        ).join('');
        wifiHTML = `<div class="health-stat">
            <span>\u{1F4F6} ${rssi} dBm</span>
            <div class="health-wifi-bars">${wifiBars}</div>
        </div>`;
    }

    const statusDot = online ? '\u{1F7E2}' : '\u{1F534}';
    return `<div class="health-card">
        <div class="health-name">${statusDot} ${dev.name || sn}</div>
        <div class="health-model">${dev.model ? `${modelName(dev.model)} (${dev.model})` : 'Unknown model'}</div>
        <div class="health-stats">
            ${batteryHTML}
            ${wifiHTML}
        </div>
    </div>`;
}

// ============================================================================
// Pinch-to-Zoom on Live View
// ============================================================================

function setupZoomGestures() {
    const container = document.getElementById('live-container');
    container.addEventListener('touchstart', onZoomTouchStart, { passive: false });
    container.addEventListener('touchmove', onZoomTouchMove, { passive: false });
    container.addEventListener('touchend', onZoomTouchEnd, { passive: false });
}

function isTargetBackButton(target) {
    // Check if the touch/click target is the back button or its children
    const backBtn = document.getElementById('live-back');
    return backBtn && (target === backBtn || backBtn.contains(target));
}

function cleanupZoomGestures() {
    const container = document.getElementById('live-container');
    container.removeEventListener('touchstart', onZoomTouchStart);
    container.removeEventListener('touchmove', onZoomTouchMove);
    container.removeEventListener('touchend', onZoomTouchEnd);
}

function onZoomTouchStart(e) {
    // Don't interfere with back button or other UI controls
    if (isTargetBackButton(e.target) || e.target.closest('#live-header') || e.target.closest('#live-controls')) {
        return;
    }
    if (e.touches.length === 2) {
        // Pinch start
        isPinching = true;
        isPanning = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDist = Math.sqrt(dx * dx + dy * dy);
        pinchStartScale = zoomScale;
        e.preventDefault();
    } else if (e.touches.length === 1 && zoomScale > 1) {
        // Pan start (only when zoomed)
        isPanning = true;
        panStartX = e.touches[0].clientX;
        panStartY = e.touches[0].clientY;
        panStartPanX = zoomPanX;
        panStartPanY = zoomPanY;
        e.preventDefault();
    }

    // Double-tap detection (reset zoom when zoomed)
    if (e.touches.length === 1) {
        const now = Date.now();
        if (now - lastTapTime < 300 && zoomScale > 1) {
            resetZoom();
            e.preventDefault();
        }
        lastTapTime = now;
    }
}

function onZoomTouchMove(e) {
    if (isPinching && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        zoomScale = Math.min(4, Math.max(1, pinchStartScale * (dist / pinchStartDist)));
        if (zoomScale <= 1) { zoomPanX = 0; zoomPanY = 0; }
        constrainPan();
        applyZoomTransform();
        e.preventDefault();
    } else if (isPanning && e.touches.length === 1 && zoomScale > 1) {
        zoomPanX = panStartPanX + (e.touches[0].clientX - panStartX);
        zoomPanY = panStartPanY + (e.touches[0].clientY - panStartY);
        constrainPan();
        applyZoomTransform();
        e.preventDefault();
    }
}

function onZoomTouchEnd(e) {
    if (isPinching && e.touches.length < 2) {
        isPinching = false;
        // Snap to 1x if close
        if (zoomScale < 1.1) {
            zoomScale = 1;
            zoomPanX = 0;
            zoomPanY = 0;
            applyZoomTransform();
        }
    }
    if (e.touches.length === 0) {
        isPanning = false;
    }
}

function applyZoomTransform() {
    const el = liveMode === 'frame'
        ? document.getElementById('live-frame')
        : document.getElementById('live-video');
    if (el) el.style.transform = `translate(${zoomPanX}px, ${zoomPanY}px) scale(${zoomScale})`;
}

function resetZoom() {
    zoomScale = 1;
    zoomPanX = 0;
    zoomPanY = 0;
    const video = document.getElementById('live-video');
    if (video) video.style.transform = '';
    const frame = document.getElementById('live-frame');
    if (frame) frame.style.transform = '';
}

function constrainPan() {
    const container = document.getElementById('live-container');
    const rect = container.getBoundingClientRect();
    const maxPanX = (rect.width * (zoomScale - 1)) / 2;
    const maxPanY = (rect.height * (zoomScale - 1)) / 2;
    zoomPanX = Math.min(maxPanX, Math.max(-maxPanX, zoomPanX));
    zoomPanY = Math.min(maxPanY, Math.max(-maxPanY, zoomPanY));
}

// ============================================================================
// Captcha (placeholder - needs server-side event forwarding)
// ============================================================================

function showCaptcha(imageBase64) {
    document.getElementById('captcha-img').src = 'data:image/png;base64,' + imageBase64;
    document.getElementById('captcha-input').value = '';
    document.getElementById('captcha-overlay').classList.remove('hidden');
}

function onCaptchaSubmit() {
    const text = document.getElementById('captcha-input').value.trim();
    if (!text) return;
    // TODO: Send captcha response back to server
    document.getElementById('captcha-overlay').classList.add('hidden');
}

// ============================================================================
// Recordings (event history + clip player)
// ============================================================================

let historyCamera = '';         // '' = all cameras
let historyEvents = [];
let historyAfter = null;        // oldest boundary loaded (epoch ms) → "Load older"
let historyPlayingId = null;
let historyLoading = false;
let historySilent = [];       // cameras whose hub didn't answer the last query
let historyHb3 = [];          // cameras on a HomeBase S380 (detections only, no clip list)

function openHistory(sn) {
    historyCamera = sn || '';
    const sel = document.getElementById('history-camera');
    sel.innerHTML = '<option value="">All cameras</option>' + Object.keys(devices)
        .map(d => `<option value="${d}">${escapeText(devices[d].name || d)}</option>`).join('');
    sel.value = historyCamera;
    closeHistoryPlayer();
    showScreen('history-screen');
    loadHistory(false);
}

function closeHistory() {
    closeHistoryPlayer();
    showScreen('cameras-screen');
}

function loadHistory(append) {
    if (historyLoading) return;
    historyLoading = true;
    if (!append) {
        historyEvents = [];
        historyAfter = null;
        document.getElementById('history-list').innerHTML = '<p class="settings-hint" style="padding:16px 0">Loading recordings…</p>';
        document.getElementById('history-empty').classList.add('hidden');
    }
    document.getElementById('history-more').classList.add('hidden');
    wsSend({
        command: 'history.list',
        serialNumber: historyCamera || undefined,
        before: append ? historyAfter : undefined
    });
}

function onHistoryList(msg) {
    historyLoading = false;
    if (!msg.success) {
        document.getElementById('history-list').innerHTML =
            `<p class="settings-hint" style="padding:16px 0">Couldn't load recordings: ${escapeText(msg.errorCode || 'error')}</p>`;
        return;
    }
    const r = msg.result;
    historyEvents = r.append ? historyEvents.concat(r.events) : r.events;
    historyAfter = r.after;
    historySilent = (r.sources || []).filter(x => x.timeouts || x.error).map(x => (x.cameras || [x.station]).join(', '));
    historyHb3 = (r.sources || []).filter(x => x.hb3).map(x => (x.cameras || []).join(', '));
    renderHistory();
    const more = document.getElementById('history-more');
    more.textContent = `Load older (before ${new Date(r.after).toLocaleDateString()})`;
    more.classList.remove('hidden');
}

function renderHistory() {
    const list = document.getElementById('history-list');
    document.getElementById('history-empty').classList.toggle('hidden', historyEvents.length > 0);
    let html = '';
    if (historyHb3.length) {
        html += `<p class="settings-hint" style="padding:8px 0 0">${escapeText(historyHb3.join(', '))}: HomeBase S380 recordings can't be listed yet — showing detections EufyView has seen, with snapshots.</p>`;
    }
    if (historySilent.length) {
        html += `<p class="settings-hint" style="padding:8px 0 0">Not responding, so recordings not listed: ${escapeText(historySilent.join('; '))}</p>`;
    }
    let lastDay = '';
    for (const ev of historyEvents) {
        const start = new Date(ev.start * 1000);
        const day = start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        if (day !== lastDay) { html += `<div class="history-day">${day}</div>`; lastDay = day; }
        const secs = ev.end > ev.start ? ev.end - ev.start : 0;
        const time = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const name = devices[ev.serialNumber]?.name || ev.deviceName;
        const thumbUrl = ev.snap || (ev.hasThumb ? `/history/thumb/${ev.id}.jpg` : null);
        const thumb = thumbUrl ? `<img src="${thumbUrl}" loading="lazy" alt="">` : '';
        html += `<button class="history-entry${ev.id === historyPlayingId ? ' playing' : ''}" data-id="${ev.id}"${ev.canPlay || ev.snap ? '' : ' disabled'}>
            <div class="history-thumb">${thumb || '&#127902;'}</div>
            <div class="history-info">
                <div class="history-label">${escapeText(ev.label)}</div>
                <div class="history-sub">${escapeText(name)} · ${time}${secs ? ` · ${secs}s` : ''}</div>
            </div>
            ${ev.cached ? '<span class="history-saved">Saved</span>' : (ev.canPlay ? '<span class="history-saved">&#9654;</span>' : '')}
        </button>`;
    }
    list.innerHTML = html;
    // A thumbnail that fails to load falls back to the film icon
    list.querySelectorAll('.history-thumb img').forEach(img => {
        img.addEventListener('error', () => { img.parentElement.innerHTML = '&#127902;'; });
    });
    list.querySelectorAll('.history-entry').forEach(btn => {
        btn.addEventListener('click', () => openHistoryClip(btn.dataset.id));
    });
}

function openHistoryClip(id) {
    const ev = historyEvents.find(e => e.id === id);
    if (!ev) return;
    historyPlayingId = id;
    const video = document.getElementById('history-video');
    video.pause();
    video.removeAttribute('src');
    video.load();
    const name = devices[ev.serialNumber]?.name || ev.deviceName;
    document.getElementById('history-player-title').textContent =
        `${ev.label} · ${name} · ${new Date(ev.start * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    document.getElementById('history-player').classList.remove('hidden');
    document.querySelectorAll('.history-entry').forEach(b => b.classList.toggle('playing', b.dataset.id === id));
    const img = document.getElementById('history-image');
    // Detection-only entry: show its snapshot (no recorded clip to fetch)
    if (!ev.canPlay) {
        video.classList.add('hidden');
        img.src = ev.snap;
        img.classList.remove('hidden');
        setHistoryStatus('Snapshot — no recorded clip available for this event');
        return;
    }
    img.classList.add('hidden');
    img.removeAttribute('src');
    video.classList.remove('hidden');
    setHistoryStatus(ev.cached ? '' : 'Requesting clip from camera…');
    wsSend({ command: 'device.history_play', serialNumber: ev.serialNumber, id });
}

function playHistoryClip(url) {
    setHistoryStatus('');
    const video = document.getElementById('history-video');
    video.src = url;
    video.play().catch(() => { /* autoplay may be blocked; controls are visible */ });
}

function closeHistoryPlayer() {
    historyPlayingId = null;
    const video = document.getElementById('history-video');
    video.pause();
    video.removeAttribute('src');
    video.load();
    const img = document.getElementById('history-image');
    img.classList.add('hidden');
    img.removeAttribute('src');
    video.classList.remove('hidden');
    document.getElementById('history-player').classList.add('hidden');
    document.querySelectorAll('.history-entry.playing').forEach(b => b.classList.remove('playing'));
}

function setHistoryStatus(text) {
    document.getElementById('history-status').textContent = text;
}

function markHistoryCached(id) {
    const ev = historyEvents.find(e => e.id === id);
    if (ev && !ev.cached) { ev.cached = true; renderHistory(); }
}

// ============================================================================
// Doorbell Quick Replies
// ============================================================================

const voiceCache = {};          // serial -> [{ id, name }]

function openQuickReplies() {
    const sn = currentDeviceSN;
    if (!sn) return;
    document.getElementById('qr-overlay').classList.remove('hidden');
    if (voiceCache[sn]) {
        renderQuickReplies(sn);
    } else {
        document.getElementById('qr-list').innerHTML = '<p class="settings-hint">Loading…</p>';
        wsSend({ command: 'device.get_voices', serialNumber: sn });
    }
}

function closeQuickReplies() {
    document.getElementById('qr-overlay').classList.add('hidden');
}

function onVoicesList(msg) {
    if (!msg.success) {
        document.getElementById('qr-list').innerHTML =
            `<p class="settings-hint">Couldn't load quick replies: ${escapeText(msg.errorCode || 'error')}</p>`;
        return;
    }
    voiceCache[msg.result.serialNumber] = msg.result.voices;
    if (msg.result.serialNumber === currentDeviceSN) renderQuickReplies(currentDeviceSN);
}

function renderQuickReplies(sn) {
    const list = document.getElementById('qr-list');
    const voices = voiceCache[sn] || [];
    if (!voices.length) {
        list.innerHTML = '<p class="settings-hint">No quick replies are saved for this doorbell. Add them in the official Eufy app.</p>';
        return;
    }
    list.innerHTML = voices.map(v =>
        `<button class="qr-option" data-id="${v.id}">${escapeText(v.name)}</button>`).join('');
    list.querySelectorAll('.qr-option').forEach(btn => {
        btn.addEventListener('click', () => {
            wsSend({ command: 'device.quick_response', serialNumber: sn, voiceId: Number(btn.dataset.id) });
            closeQuickReplies();
        });
    });
}

// ============================================================================
// Small helpers
// ============================================================================

function escapeText(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Brief message at the bottom of the screen
let flashTimer = null;
function flashMessage(text, durationMs = 2500) {
    let el = document.getElementById('flash-message');
    if (!el) {
        el = document.createElement('div');
        el.id = 'flash-message';
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('show'), durationMs);
}
