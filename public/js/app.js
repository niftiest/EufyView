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
    'ring': '\u{1F514}', 'stranger detected': '\u{1F464}', 'dog detected': '\u{1F415}'
};
const EVENT_COLORS = {
    'motion detected': 'var(--warning)', 'person detected': 'var(--primary)', 'pet detected': 'var(--success)',
    'vehicle detected': 'var(--danger)', 'crying detected': '#ff6ec7', 'sound detected': '#b44aff',
    'ring': '#ffdd4a', 'stranger detected': 'var(--danger)', 'dog detected': 'var(--success)'
};

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
    wsConnect();

    // Event listeners
    document.getElementById('settings-btn').addEventListener('click', openSettings);
    document.getElementById('settings-close').addEventListener('click', closeSettings);
    document.getElementById('settings-cancel').addEventListener('click', closeSettings);
    document.getElementById('settings-save').addEventListener('click', onSettingsSave);
    document.getElementById('live-back').addEventListener('click', stopLiveView);
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

    // Timeline button
    document.getElementById('timeline-btn').addEventListener('click', showTimeline);
    document.getElementById('timeline-back').addEventListener('click', () => {
        document.getElementById('timeline-screen').classList.remove('active');
        showScreen('cameras-screen');
    });
    document.getElementById('timeline-clear').addEventListener('click', clearTimeline);

    // Snapshot all button
    document.getElementById('snapshot-all-btn').addEventListener('click', startSnapshotAll);

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
});

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
                document.getElementById('health-btn').classList.remove('hidden');
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
                    nightvisionValue: props.nightvision
                };
                renderCameraGrid();
                if (currentDeviceSN === sn) updateLiveControls();
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
                }
            }
            break;

        case 'eufy connected':
        case 'eufy reconnected':
            // Server reconnected to Eufy — re-request device data
            wsSend({ command: 'start_listening', messageId: 'start_listening' });
            break;

        case 'snapshot_all_start':
            snapshotAllInProgress = true;
            updateSnapshotAllButton(0, evt.total);
            break;

        case 'snapshot_all_progress':
            updateSnapshotAllButton(evt.completed, evt.total);
            break;

        case 'snapshot_all_done':
            snapshotAllInProgress = false;
            updateSnapshotAllButton();
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
            if (evt.state !== false) {
                addTimelineEvent(evt);
                if (Notification.permission === 'granted' && isNotificationEnabled(evt.serialNumber)) {
                    new Notification(`${evt.event}`, {
                        body: `Camera: ${devices[evt.serialNumber]?.name || evt.serialNumber}`
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
                card.addEventListener('click', () => startLiveView(sn));
                card.innerHTML = `
                    <div class="camera-thumb"><span class="no-preview">&#128247;</span></div>
                    <div class="camera-info">
                        <div class="camera-name">${devices[sn].name || sn}</div>
                        <div class="camera-status">${devices[sn].model || ''}</div>
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
            if (devices[sn].model) parts.push(devices[sn].model);
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
    updateSnapshotAllButton(0, 0);
    wsSend({ command: 'snapshot_all', messageId: 'snapshot_all' });
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

function startLiveView(serialNumber) {
    currentDeviceSN = serialNumber;
    const dev = devices[serialNumber];

    document.getElementById('live-title').textContent = dev?.name || serialNumber;
    document.getElementById('live-error').classList.add('hidden');
    document.getElementById('live-loading').classList.remove('hidden');
    document.getElementById('live-buffer').textContent = '';

    showScreen('live-screen');
    startVideoStream(serialNumber);
    renderLiveControls();
    setupSwipeGestures();
    setupZoomGestures();
    acquireWakeLock();
    document.body.classList.add('live-active');

    // Show PiP button if supported
    const pipBtn = document.getElementById('live-pip-btn');
    if (document.pictureInPictureEnabled) {
        pipBtn.classList.remove('hidden');
    }
}

function stopLiveView() {
    stopVideoStream();
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

async function fetchStream(serialNumber) {
    fetchController = new AbortController();
    const video = document.getElementById('live-video');
    const bufferEl = document.getElementById('live-buffer');

    try {
        const response = await fetch(`/${serialNumber}.mp4`, {
            signal: fetchController.signal
        });

        if (!response.ok) {
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
                showLiveError('Stream ended by server');
                stopVideoStream();
                break;
            }

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
    if (!config) return;
    document.getElementById('cfg-scale').value = config.VIDEO_SCALE || '';
    document.getElementById('cfg-crf').value = config.TRANSCODING_CRF || '23';
    document.getElementById('cfg-crf-val').textContent = config.TRANSCODING_CRF || '23';

    renderNotifToggles();
    document.getElementById('settings-overlay').classList.remove('hidden');
}

function closeSettings() {
    document.getElementById('settings-overlay').classList.add('hidden');
}

async function onSettingsSave() {
    const newConfig = {
        VIDEO_SCALE: document.getElementById('cfg-scale').value,
        TRANSCODING_CRF: document.getElementById('cfg-crf').value
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

    // Preset position pills
    renderPresetPills();

    // Pan/tilt D-pad
    renderPanTiltPad();
}

function cleanupLiveControls() {
    document.querySelectorAll('.dynamic-ctrl').forEach(el => el.remove());
    const pills = document.querySelector('.preset-pills');
    if (pills) pills.remove();
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

function renderPresetPills() {
    const dev = devices[currentDeviceSN];
    if (!dev?.canPresetPosition) return;

    const container = document.getElementById('live-container');
    const pills = document.createElement('div');
    pills.className = 'preset-pills';

    for (let i = 0; i < 4; i++) {
        const btn = document.createElement('button');
        btn.className = 'preset-pill';
        btn.textContent = 'P' + (i + 1);
        btn.addEventListener('click', () => {
            wsSend({ command: 'device.preset_position', serialNumber: currentDeviceSN, position: i });
        });
        pills.appendChild(btn);
    }

    container.appendChild(pills);
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
}

function isNotificationEnabled(sn) {
    const prefs = getNotificationPrefs();
    return prefs[sn] !== false; // default to enabled
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

    let html = '';
    groupKeys.forEach(houseId => {
        if (hasMultipleGroups) {
            html += `<div class="notif-group-label">${getHouseName(houseId) || houseId}</div>`;
        }
        html += '<div class="notif-grid">';
        html += groups[houseId].map(sn => {
            const dev = devices[sn];
            const checked = isNotificationEnabled(sn) ? 'checked' : '';
            return `<label class="notif-toggle">
                <span>${dev.name || sn}</span>
                <input type="checkbox" ${checked} data-sn="${sn}">
            </label>`;
        }).join('');
        html += '</div>';
    });
    container.innerHTML = html;
    container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => setNotificationPref(cb.dataset.sn, cb.checked));
    });
}

// ============================================================================
// Event Timeline
// ============================================================================

function addTimelineEvent(evt) {
    timelineEvents.unshift({
        event: evt.event,
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
                <div class="timeline-event">${evt.event}</div>
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
        <div class="health-model">${dev.model || 'Unknown model'}</div>
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
    const video = document.getElementById('live-video');
    video.style.transform = `translate(${zoomPanX}px, ${zoomPanY}px) scale(${zoomScale})`;
}

function resetZoom() {
    zoomScale = 1;
    zoomPanX = 0;
    zoomPanY = 0;
    const video = document.getElementById('live-video');
    if (video) video.style.transform = '';
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
