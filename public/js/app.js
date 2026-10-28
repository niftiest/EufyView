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
let accessAll = false;      // "all cameras (incl. future)" toggle on the access page
let accessUsers = [];       // admin view: last-loaded user list
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

// Deep-links from a tapped push notification (set from the URL on load; opened
// once devices are discovered). deepLinkCamera → camera; deepLinkEvent {sn,time}
// → the matching recording. See openCameraFromNotification / openEventFromNotification.
let deepLinkCamera = null;
let deepLinkEvent = null;
// A pending "jump to this event" waiting for the recordings list to arrive.
let pendingDeepLinkEvent = null;

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
    // Known-specific where confirmed; the rest stay the correct-but-generic
    // "Video Doorbell" (and the code itself is always shown on the Health page).
    T8200: 'Video Doorbell 2K (Wired)', T8201: 'Video Doorbell', T8202: 'Video Doorbell', T8203: 'Video Doorbell',
    T8210: 'Video Doorbell 2K (Battery)', T8213: 'Video Doorbell Dual (Battery)', T8214: 'Video Doorbell', T8220: 'Video Doorbell',
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

// Homepage model label: drop the power-source qualifier ("(Battery)" / "(Wired)")
// - it's redundant on the grid, which now shows the battery % beside the name.
function shortModelName(code) {
    return modelName(code).replace(/\s*\((?:Battery|Wired)\)\s*$/i, '');
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

// Register the service worker (PWA installability) and wire the update flow:
// when a new version ships (CACHE_NAME bump in sw.js), the new worker installs
// and WAITS; we surface an "Update available" banner and, on tap, activate it
// and reload onto the fresh HTML + versioned assets. No manual cache-clearing.
let swReloading = false;
function reloadForUpdate() {
    if (swReloading) return;
    swReloading = true;
    location.reload();
}

// Promote the waiting worker and reload *after* it actually takes over.
// Previously we reloaded on a blind 1.5s timer, which often fired before the new
// worker had activated - so the reloaded page was still run by the OLD worker
// with the new one still "waiting", and the update popup appeared a second time.
// Now the reload is driven by the activation signal (controllerchange, or the
// worker's statechange→activated as an iOS backup); the timer is only a last
// resort. If a reload still lands on the old worker, we retry silently a bounded
// number of times instead of re-prompting (prevents the "update twice" symptom
// without risking an endless silent reload loop).
function swTryCount() { try { return Number(sessionStorage.getItem('sw-update-try')) || 0; } catch (e) { return 0; } }
function setSwTryCount(n) { try { if (n) sessionStorage.setItem('sw-update-try', String(n)); else sessionStorage.removeItem('sw-update-try'); } catch (e) {} }

function promoteWaitingWorker(reg) {
    const w = reg.waiting;
    if (!w) { reloadForUpdate(); return; }
    setSwTryCount(swTryCount() + 1);
    w.addEventListener('statechange', () => { if (w.state === 'activated') reloadForUpdate(); });
    w.postMessage({ type: 'SKIP_WAITING' });
    setTimeout(reloadForUpdate, 8000);   // genuine last resort if no event fires
}

if ('serviceWorker' in navigator) {
    // Whether a worker already controls this page at load. On the very first
    // visit there's none, so the first activation's controllerchange must NOT
    // trigger a reload; only a genuine update (controller already present) does.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController) reloadForUpdate();
    });

    navigator.serviceWorker.register('/sw.js').then((reg) => {
        // A new worker finished installing while this page was already open.
        if (reg.waiting && navigator.serviceWorker.controller) {
            // If we just reloaded mid-update but control hasn't swapped yet,
            // continue silently (bounded) rather than prompting again. Prompt
            // fresh (try 0), or again only if the silent retries didn't take.
            const tries = swTryCount();
            if (tries === 0 || tries >= 3) showUpdateBanner(reg);
            else promoteWaitingWorker(reg);
        } else {
            setSwTryCount(0);   // no update pending → clear any stale retry counter
        }

        reg.addEventListener('updatefound', () => {
            const sw = reg.installing;
            if (!sw) return;
            sw.addEventListener('statechange', () => {
                if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                    showUpdateBanner(reg);
                }
            });
        });

        // Poll for a new version when the app regains focus and every 30 min, so
        // an installed PWA that's left open still notices releases.
        const check = () => reg.update().catch(() => {});
        document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
        setInterval(check, 30 * 60 * 1000);
    }).catch(() => {});
}

// Mandatory "Update available" popup, shown centered over everything. There is
// no dismiss - the user must update to keep using the app (a stale client can
// drift out of sync with the server/protocol). Reload activates the waiting
// worker; its 'activate' prunes old caches, then the page reloads onto fresh
// assets.
let updateBannerShown = false;
function showUpdateBanner(reg) {
    if (updateBannerShown) return;
    updateBannerShown = true;
    // The client-reload prompt supersedes the server-release prompt: you must
    // reload onto fresh code first. Remove the server-update modal if it beat us
    // onto the screen so the two never stack.
    const srv = document.getElementById('server-update-modal');
    if (srv) srv.remove();
    const overlay = document.createElement('div');
    overlay.id = 'update-modal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML =
        '<div class="modal-card">' +
        '<h3>Update available</h3>' +
        '<p>A new version of EufyView is available.</p>' +
        '<button type="button" class="btn-primary" id="update-reload">Reload now</button>' +
        '</div>';
    const reloadBtn = overlay.querySelector('#update-reload');
    reloadBtn.addEventListener('click', () => {
        reloadBtn.disabled = true;
        reloadBtn.textContent = 'Updating…';
        // Activate the waiting worker and reload once it has actually taken
        // control (see promoteWaitingWorker) - not on a fixed timer, which could
        // reload before the swap and re-show this popup.
        promoteWaitingWorker(reg);
    });
    document.body.appendChild(overlay);
}

// Drive the app height from JS instead of CSS viewport units. On this phone's
// installed PWA, `100vh`/`100dvh` resolve to the *ideal* viewport (briefly 916px
// during load) and don't reliably recompute when the Android system bars appear, so
// the screen stayed too tall and clipped the bottom camera. visualViewport.height is
// the actually-visible height; publish it as --app-h and the screens size to it.
function setAppHeight() {
    const h = Math.round((window.visualViewport && window.visualViewport.height) || window.innerHeight);
    if (h > 0) document.documentElement.style.setProperty('--app-h', h + 'px');
}
setAppHeight();
window.addEventListener('resize', setAppHeight);
window.addEventListener('orientationchange', () => { setAppHeight(); setTimeout(setAppHeight, 300); });
if (window.visualViewport) window.visualViewport.addEventListener('resize', setAppHeight);
// Catch the post-load settle when the system bars appear after first paint.
[0, 150, 400, 1000].forEach(ms => setTimeout(setAppHeight, ms));

// ---- Theme (light default, dark opt-in, remembered per device) ----
// The saved choice is applied in index.html's <head> before first paint; these
// just handle toggling and keeping the status-bar color in sync.
function toggleTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const next = isDark ? 'light' : 'dark';
    if (next === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('eufyview-theme', next); } catch (e) {}
    updateThemeColorMeta();
}

function updateThemeColorMeta() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#17191d' : '#ffffff');
}

document.addEventListener('DOMContentLoaded', async () => {
    setAppHeight();
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

    // Deep-link from a tapped push notification. A fresh launch carries the target
    // in the URL (?event=<sn>@<ms> to jump to the clip, or ?camera=<sn>); an
    // already-open app gets an equivalent SW message. Consumed once devices load.
    try {
        const qs = new URLSearchParams(location.search);
        deepLinkCamera = qs.get('camera');
        const ev = qs.get('event');
        if (ev) {
            const at = ev.lastIndexOf('@');
            if (at > 0) deepLinkEvent = { sn: ev.slice(0, at), time: Number(ev.slice(at + 1)) };
        }
    } catch (e) {}
    if (navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener('message', (e) => {
            if (!e.data) return;
            if (e.data.type === 'open-event' && e.data.serialNumber) {
                openEventFromNotification(e.data.serialNumber, e.data.time);
            } else if (e.data.type === 'open-camera' && e.data.serialNumber) {
                openCameraFromNotification(e.data.serialNumber);
            }
        });
    }

    // Trap the Android back gesture → in-app navigation (never the sign-in URL).
    initBackTrap();

    // First run: if the server isn't signed in to Eufy yet, show the setup wizard.
    checkSetup();

    wsConnect();

    // Event listeners
    document.getElementById('settings-btn').addEventListener('click', openSettings);
    document.getElementById('theme-btn').addEventListener('click', toggleTheme);
    updateThemeColorMeta();
    document.getElementById('settings-close').addEventListener('click', closeSettings);
    document.getElementById('settings-cancel').addEventListener('click', closeSettings);
    document.getElementById('settings-save').addEventListener('click', onSettingsSave);
    document.getElementById('pair-tv-btn').addEventListener('click', requestPairCode);
    document.getElementById('smart-scan-btn').addEventListener('click', scanSmartDevices);
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
    // Tap an event row -> open that camera's recordings and jump to the clip
    // nearest the detection time (same path as a tapped push notification).
    const timelineList = document.getElementById('timeline-list');
    if (timelineList) {
        const openTimelineEntry = (entry) => {
            const sn = entry.dataset.sn;
            const time = Number(entry.dataset.time);
            if (sn) openEventFromNotification(sn, time);
        };
        timelineList.addEventListener('click', (e) => {
            const entry = e.target.closest('.timeline-entry');
            if (entry) openTimelineEntry(entry);
        });
        timelineList.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const entry = e.target.closest('.timeline-entry');
            if (entry) { e.preventDefault(); openTimelineEntry(entry); }
        });
    }

    // Recordings (history)
    document.getElementById('history-btn').addEventListener('click', () => openHistory(''));
    document.getElementById('history-back').addEventListener('click', closeHistory);
    document.getElementById('history-refresh').addEventListener('click', () => loadHistory(false));
    document.getElementById('history-camera').addEventListener('change', (e) => {
        historyCamera = e.target.value;
        historyCoverage = null;   // per-camera event-day/label set
        loadHistory(false);
    });
    document.getElementById('history-more').addEventListener('click', () => loadHistory(true));
    document.getElementById('history-calendar').addEventListener('click', toggleCalendar);
    document.getElementById('history-cal-prev').addEventListener('click', () => calShiftMonth(-1));
    document.getElementById('history-cal-next').addEventListener('click', () => calShiftMonth(1));
    document.getElementById('history-player-close').addEventListener('click', closeHistoryPlayer);
    document.getElementById('history-download').addEventListener('click', downloadHistoryClip);
    document.getElementById('history-ds').addEventListener('click', toggleHistoryDataSaver);
    document.getElementById('history-frame-play').addEventListener('click', toggleFramePlayback);
    document.getElementById('history-frame-scrub').addEventListener('input', (e) => frameSeek(Number(e.target.value)));
    initHistoryDataSaver();

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
    document.getElementById('mode-refresh').addEventListener('click', refreshModeDevice);
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

    // Settings menu navigation + admin/access controls (all inside the dialog now)
    document.getElementById('settings-back').addEventListener('click', settingsBack);
    document.querySelectorAll('#settings-menu .settings-menu-item').forEach(item => {
        item.addEventListener('click', () => { if (item.dataset.pane) openSettingsPane(item.dataset.pane); });
    });
    document.getElementById('admin-users').addEventListener('click', onAdminUsersClick);
    document.getElementById('admin-add-user').addEventListener('click', () => openAccessPage(null));
    document.getElementById('aa-save').addEventListener('click', saveAdminAccount);
    document.getElementById('access-cameras').addEventListener('click', onAccessCamClick);
    document.getElementById('access-save-btn').addEventListener('click', submitAccessUser);
    document.getElementById('claim-copy').addEventListener('click', () => { const c = document.getElementById('claim-modal')._code; if (c) { try { navigator.clipboard.writeText(c); flashMessage('Code copied'); } catch (e) {} } });
    document.getElementById('claim-done').addEventListener('click', hideClaimCode);

    // About & Updates
    document.getElementById('about-check-btn').addEventListener('click', () => checkForUpdates(true));
    document.getElementById('about-update-btn').addEventListener('click', applyUpdate);
    // Quiet background check on load → sets the header/menu "update available" dot.
    refreshUpdateBadge();

    // Background push notifications
    document.getElementById('push-enable-btn').addEventListener('click', togglePush);
    // If push was enabled before, refresh the subscription quietly on load
    refreshPushSubscription();
    initNotifStyleSelect();
    // Browser visitors → offer to install the PWA; installed users → offer to
    // turn on notifications. (beforeinstallprompt may also trigger this later.)
    maybePromptInstallOrPush();
});

function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOS() {
    return /iP(hone|ad|od)/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS reports as Mac
}

// Ask up front to turn on background notifications when they aren't enabled yet,
// so users don't have to discover the toggle buried in Settings (and then wonder
// why alerts never arrive). Once per session; a "Not now" remembers the decline.
function maybePromptPushSetup() {
    // Reached only when installed/standalone (browser visitors get the install
    // prompt instead, which covers the iOS "add to Home Screen first" case).
    if (!pushSupported()) return;
    if (localStorage.getItem('pushEnabled') === '1') return;          // already on
    if (Notification.permission === 'denied') return;                 // can't re-ask; Settings only
    if (localStorage.getItem('pushPromptDismissed') === '1') return;  // user declined before
    if (sessionStorage.getItem('pushPromptShown') === '1') return;    // already asked this session
    setTimeout(() => {
        // Don't pop over an active live view, the first-run Eufy setup wizard, or
        // the mandatory update gate.
        const setupOverlay = document.getElementById('setup-overlay');
        const setupOpen = setupOverlay && !setupOverlay.classList.contains('hidden');
        if (document.body.classList.contains('live-active') || setupOpen) return;
        if (document.getElementById('update-modal')) return;
        sessionStorage.setItem('pushPromptShown', '1');
        showPushPrompt();
    }, 1500);
}

// Centered ask-dialog. "Enable notifications" runs the real enable flow (the tap
// is the user gesture the OS permission prompt requires); "Not now" remembers the
// decline so we don't nag - they can still turn it on later in Settings.
function showPushPrompt() {
    if (document.getElementById('push-prompt-modal')) return;
    const overlay = document.createElement('div');
    overlay.id = 'push-prompt-modal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML =
        '<div class="modal-card">' +
        '<h3>Turn on notifications</h3>' +
        '<p>Get alerts when your cameras detect motion, a person, or a doorbell ring - even when the app is closed.</p>' +
        '<button type="button" class="btn-primary" id="push-prompt-enable">Enable notifications</button>' +
        '<button type="button" class="btn-secondary" id="push-prompt-later">Not now</button>' +
        '</div>';
    const enableBtn = overlay.querySelector('#push-prompt-enable');
    enableBtn.addEventListener('click', async () => {
        enableBtn.disabled = true;
        enableBtn.textContent = 'Enabling…';
        try { await enablePush(); } catch (e) {}
        overlay.remove();
        if (Notification.permission === 'granted') flashMessage('Notifications enabled');
        else if (Notification.permission === 'denied') flashMessage('Notifications are blocked - enable them in your device Settings', 5000);
    });
    overlay.querySelector('#push-prompt-later').addEventListener('click', () => {
        try { localStorage.setItem('pushPromptDismissed', '1'); } catch (e) {}
        overlay.remove();
    });
    document.body.appendChild(overlay);
}

// ---- Install-to-Home-Screen prompt (PWA) ----
// Offer every browser visitor the installed app (the intended experience) on
// each visit, until they opt out with "Don't ask again". Android/desktop
// Chromium fire beforeinstallprompt, which we defer and replay on the user's
// tap; iOS has no such API, so we show the manual Add-to-Home-Screen steps.
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();            // suppress the mini-infobar; present our own
    deferredInstallPrompt = e;
    maybePromptInstallOrPush();     // native install is now available - offer it
});
window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    try { localStorage.setItem('pwaInstalled', '1'); } catch (e) {}
});

// Route the on-load ask: installed users get the notifications prompt; browser
// visitors get the install prompt.
function maybePromptInstallOrPush() {
    if (isStandalone()) { maybePromptPushSetup(); return; }
    maybePromptInstall();
}

function maybePromptInstall() {
    if (localStorage.getItem('installPromptDismissed') === '1') return;  // "Don't ask again"
    if (sessionStorage.getItem('installPromptShown') === '1') return;    // once per open/session
    // Only offer where install is actually possible: a captured native prompt
    // (Android/desktop Chromium) or iOS Safari's manual Add-to-Home-Screen.
    if (!deferredInstallPrompt && !isIOS()) return;
    setTimeout(() => {
        const setupOverlay = document.getElementById('setup-overlay');
        const setupOpen = setupOverlay && !setupOverlay.classList.contains('hidden');
        if (document.body.classList.contains('live-active') || setupOpen) return;
        if (document.getElementById('update-modal')) return;  // update gate first
        sessionStorage.setItem('installPromptShown', '1');
        showInstallPrompt(!!deferredInstallPrompt);
    }, 1500);
}

function showInstallPrompt(canNative) {
    if (document.getElementById('install-modal')) return;
    let body, action;
    if (canNative) {
        body = 'Install EufyView for a full-screen app, a Home Screen icon, and background notifications.';
        action = '<button type="button" class="btn-primary" id="install-go">Install app</button>';
    } else { // iOS Safari - no install API, so show the manual steps
        const share =
            '<svg class="ios-share-ic" viewBox="0 0 24 24" width="17" height="17" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
            'aria-hidden="true"><path d="M8 7l4-4 4 4"/><path d="M12 3v12"/>' +
            '<path d="M6 11H5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-1"/></svg>';
        body = 'Install EufyView for a Home Screen icon and notifications. In Safari, tap the Share button ' +
            share + ', then choose <b>Add to Home Screen</b>.';
        action = '';
    }
    const overlay = document.createElement('div');
    overlay.id = 'install-modal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML =
        '<div class="modal-card">' +
        '<h3>Install EufyView</h3>' +
        '<p>' + body + '</p>' +
        action +
        '<button type="button" class="btn-secondary" id="install-later">Not now</button>' +
        '<button type="button" id="install-never" class="modal-textlink">Don’t ask again</button>' +
        '</div>';
    if (canNative) {
        overlay.querySelector('#install-go').addEventListener('click', async () => {
            overlay.remove();
            const p = deferredInstallPrompt;
            deferredInstallPrompt = null;   // a prompt can only be used once
            try {
                p.prompt();
                const res = await p.userChoice;
                if (res && res.outcome === 'accepted') { try { localStorage.setItem('pwaInstalled', '1'); } catch (e) {} }
            } catch (e) {}
        });
    }
    overlay.querySelector('#install-later').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#install-never').addEventListener('click', () => {
        try { localStorage.setItem('installPromptDismissed', '1'); } catch (e) {}
        overlay.remove();
    });
    document.body.appendChild(overlay);
}

// ============================================================================
// Helpers
// ============================================================================

async function fetchJSON(url, opts) {
    const res = await fetch(url, opts);
    return res.json();
}

function showScreen(id) {
    const leaving = document.querySelector('.screen.active');
    // Leaving Recordings → drop the server-side clip cache. Clips are cached only
    // so you can jump around and re-watch quickly while browsing; a permanent copy
    // is the explicit per-clip Download. This catches every exit (back, nav, etc.).
    if (leaving && leaving.id === 'history-screen' && id !== 'history-screen') {
        try { wsSend({ command: 'history.clear_cache' }); } catch (e) {}
    }
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

                // If launched from a tapped notification, jump to it now that
                // devices are known - the specific event if we have one, else the camera.
                if (deepLinkEvent) { openEventFromNotification(deepLinkEvent.sn, deepLinkEvent.time); deepLinkEvent = null; }
                else if (deepLinkCamera) openCameraFromNotification(deepLinkCamera);
            } else {
                // Connection failed - show cameras screen with error
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
                    // Eufy DeviceState: 0 Offline, 1 Online, 2 Manually disabled,
                    // 3 Offline (low battery), 4/5 re-add. Drives offline UI.
                    state: props.state,
                    // Whether the camera's HomeBase is reachable right now. A camera
                    // on a down hub reports no `state` at all, so this is the signal
                    // that actually catches it.
                    stationConnected: msg.result.stationConnected,
                    // Capability flags
                    hasNightvision: props.nightvision !== undefined || props.autoNightvision !== undefined,
                    hasLight: props.light !== undefined || props.lightSettingsBrightnessManual !== undefined,
                    lightOn: !!props.light,
                    nightvisionValue: props.nightvision,
                    hasMotionTracking: props.motionTracking !== undefined,
                    motionTracking: !!props.motionTracking,
                    // RTSP fast path: supported if the camera exposes the property at all
                    rtspSupported: props.rtspStream !== undefined
                };
                renderCameraGrid();
                if (currentDeviceSN === sn) updateLiveControls();
                // If the mode chooser is open for this camera (e.g. after a
                // Refresh tap), re-evaluate its online/offline availability.
                if (pendingModeSN === sn && !document.getElementById('mode-overlay').classList.contains('hidden')) {
                    modeRefreshing = false;
                    updateModeChooserAvailability();
                }
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

        case 'history.coverage':
            onHistoryCoverage(msg);
            break;

        case 'history_updated': {
            // The server pulled a freshly-recorded clip into its cache (detection
            // -driven or the safety poll). If the user is on the Recordings list,
            // parked on the newest page (not paged older) and not mid-playback,
            // refresh quietly from cache (instant) so the new clip shows up.
            const scr = document.getElementById('history-screen');
            if (!scr || !scr.classList.contains('active')) break;
            if (historyLoading || historyPlayingId || historyPagedOlder) break;
            const relevant = !msg.serialNumber || !historyCamera || historyCamera === msg.serialNumber;
            if (relevant) loadHistory(false);
            break;
        }

        case 'device.history_play':
            if (msg.result && msg.result.id === historyPlayingId) {
                if (!msg.success) setHistoryStatus(`Couldn't load clip: ${msg.errorCode || 'error'}`);
                else if (historyPlayMode === 'frames') {
                    // Data Saver: frames need the whole clip. If it's cached, extract
                    // now; otherwise wait for history_ready (no fMP4 streamed to us).
                    if (msg.result.ready) startFramePlayback(msg.result.id);
                    else setHistoryStatus('Downloading clip for Data Saver…');
                }
                else if (msg.result.ready) playHistoryClip(msg.result.url);
                else if (msg.result.streaming) {
                    // Start playing while the clip is still downloading - the server
                    // streams fragmented MP4, so playback begins at the first keyframe.
                    historyStreaming = true;
                    playHistoryClip(msg.result.url);
                    setHistoryStatus('Streaming from camera…');
                } else setHistoryStatus('Downloading from camera…');
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
            // Server reconnected to Eufy - re-request device data
            wsSend({ command: 'start_listening', messageId: 'start_listening' });
            break;

        case 'history_progress':
            if (evt.id === historyPlayingId) setHistoryStatus(`Downloading from camera… ${evt.pct}%`);
            break;

        case 'history_ready':
            // When we were already streaming the clip live, the <video> has the whole
            // thing buffered - reloading would needlessly restart it. Just flip "Saved".
            if (evt.id === historyPlayingId) {
                if (historyPlayMode === 'frames') startFramePlayback(evt.id);
                else if (!historyStreaming) playHistoryClip(evt.url);
            }
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
                flashMessage(`Updated ${evt.total - evt.failed.length}/${evt.total} - no picture from ${names}`, 6000);
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
                // this alert - don't show a second one from the page.
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
                        <div class="camera-name"><span class="cam-name-text">${escapeText(devices[sn].name || sn)}</span><span class="cam-batt hidden"></span></div>
                        <div class="camera-status">${escapeText(shortModelName(devices[sn].model))}</div>
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

        const nameEl = card.querySelector('.cam-name-text');
        if (nameEl) nameEl.textContent = devices[sn].name || sn;

        // Battery sits beside the name with a \uD83D\uDD0B icon (matching the health view),
        // tinted amber/red as it drops.
        const battEl = card.querySelector('.cam-batt');
        if (battEl) {
            const b = devices[sn].battery;
            if (b != null) {
                battEl.textContent = '\u{1F50B} ' + b + '%';
                battEl.classList.remove('hidden');
                battEl.classList.toggle('cam-batt-low', b <= 20);
                battEl.classList.toggle('cam-batt-mid', b > 20 && b <= 50);
            } else {
                battEl.classList.add('hidden');
                battEl.textContent = '';
            }
        }

        // Status line is the model, plus an offline label when the camera is
        // unreachable (so the grid itself flags it before you even tap in).
        const statusEl = card.querySelector('.camera-status');
        if (statusEl) {
            const offLabel = deviceStateLabel(devices[sn]);
            const model = devices[sn].model ? shortModelName(devices[sn].model) : '';
            statusEl.textContent = offLabel ? (model ? model + ' \u00B7 ' + offLabel : offLabel) : model;
            card.classList.toggle('cam-offline', !!offLabel);
        }

        // Thumbnail: show the live picture when present (and cache it), otherwise
        // fall back to the last cached one so it appears instantly on reopen.
        // These only change on live-view or Snapshot-all, so caching is safe.
        const thumb = card.querySelector('.camera-thumb');
        let thumbUrl = null;
        if (devices[sn].picture?.data?.data) {
            thumbUrl = picDataUrl(devices[sn].picture);
            if (thumbUrl) { try { localStorage.setItem('thumb:' + sn, thumbUrl); } catch (e) { /* quota - skip */ } }
        } else {
            try { thumbUrl = localStorage.getItem('thumb:' + sn); } catch (e) {}
        }
        if (thumbUrl) {
            // If the thumbnail fails to decode (e.g. a stale/corrupt cached entry,
            // or a camera whose picture bytes came back encrypted/partial), fall
            // back to the camera placeholder and drop the bad cache - never leave a
            // broken-image icon on the tile.
            const onThumbError = () => {
                thumb.innerHTML = '<span class="no-preview">&#128247;</span>';
                try { localStorage.removeItem('thumb:' + sn); } catch (e) {}
            };
            const existingImg = thumb.querySelector('img');
            if (existingImg) {
                if (existingImg.src !== thumbUrl) { existingImg.onerror = onThumbError; existingImg.src = thumbUrl; }
            } else {
                const img = document.createElement('img');
                img.onerror = onThumbError;
                img.src = thumbUrl;
                thumb.innerHTML = '';
                thumb.appendChild(img);
            }
        }
    });
}

// Encode a camera's picture property (Uint8Array) as a data: URL - persistent
// (unlike a blob: URL) so it can be cached in localStorage and shown on reopen.
function picDataUrl(pic) {
    try {
        const bytes = new Uint8Array(pic.data.data);
        // Only encode if these are real image bytes. Some cameras (e.g. a doorbell
        // on a flaky HomeBase whose thumbnail comes back encrypted/partial) deliver
        // bytes that aren't a decodable JPEG/PNG; base64-ing those gives a broken
        // <img>, so treat them as "no thumbnail" instead.
        const isJpeg = bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
        const isPng  = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
        if (!isJpeg && !isPng) return null;
        const mime = pic.type?.mime || 'image/jpeg';
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return `data:${mime};base64,${btoa(bin)}`;
    } catch (e) {
        return null;
    }
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
// quiet - e.g. the phone slept and missed the final event - free the button.
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

// A short "why you can't use this" label, or null when the camera is reachable.
// Eufy's own DeviceState (0 Offline, 1 Online, 2 Manually disabled, 3 Offline low
// battery, 4/5 re-add) only loads over P2P, so a camera on a DOWN HomeBase reports
// no state at all - in that case the station's connection is the real signal.
function deviceStateLabel(dev) {
    if (!dev) return null;
    // A reachable camera always reports Eufy's DeviceState === 1 (Online). The hub
    // reports state=1 for every camera it can reach and NOTHING for one it can't -
    // so a camera that's off while its hub is up simply has no state. (Battery/wifi
    // can be stale, so they're not reliable; state is.) States: 1 Online, 2 Manually
    // disabled, 3 Offline low-battery, 0 Offline.
    if (dev.state === 1) return null;
    if (dev.state === 3) return 'Offline (low battery)';
    if (dev.state === 2) return 'Camera turned off';
    // Offline or no state at all. Only trust this once the camera's properties have
    // actually loaded (stationConnected ships in that same payload) so we don't flash
    // "offline" before the first fetch.
    if (dev.stationConnected === undefined) return null;
    return 'Offline';
}
function isDeviceReachable(dev) { return deviceStateLabel(dev) === null; }

let modeRefreshing = false;

function openModeChooser(serialNumber) {
    pendingModeSN = serialNumber;
    modeRefreshing = false;
    const dev = devices[serialNumber] || {};
    document.getElementById('mode-title').textContent = dev.name || serialNumber;
    updateModeChooserAvailability();
    document.getElementById('mode-overlay').classList.remove('hidden');
}

// When a camera is offline its recordings and live view can't be reached (only a
// HomeBase could serve clips, and the disconnected ones here are the HomeBases),
// so we disable every action and leave only Refresh to re-check connectivity.
function updateModeChooserAvailability() {
    const dev = devices[pendingModeSN] || {};
    const offLabel = deviceStateLabel(dev);
    const offline = !!offLabel;

    ['mode-stream', 'mode-frame', 'mode-history'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.disabled = offline;
        btn.classList.toggle('disabled', offline);
    });

    const note = document.getElementById('mode-offline-note');
    if (note) {
        note.textContent = offline
            ? offLabel + ' - live view and recordings are unavailable until it reconnects.'
            : '';
        note.classList.toggle('hidden', !offline);
    }

    const refreshBtn = document.getElementById('mode-refresh');
    if (refreshBtn) {
        refreshBtn.classList.toggle('hidden', !offline);
        refreshBtn.disabled = modeRefreshing;
        refreshBtn.classList.toggle('disabled', modeRefreshing);
        const lbl = refreshBtn.querySelector('.mode-rf-label');
        if (lbl) lbl.textContent = modeRefreshing ? 'Checking…' : 'Refresh';
    }
}

// Re-query the camera's properties (including its online state). The
// device.get_properties result handler re-runs updateModeChooserAvailability();
// the timeout is a fallback so the button never stays stuck on "Checking…".
function refreshModeDevice() {
    const sn = pendingModeSN;
    if (!sn || modeRefreshing) return;
    modeRefreshing = true;
    updateModeChooserAvailability();
    wsSend({ command: 'device.get_properties', serialNumber: sn });
    clearTimeout(refreshModeDevice._t);
    refreshModeDevice._t = setTimeout(() => {
        modeRefreshing = false;
        if (pendingModeSN === sn) updateModeChooserAvailability();
    }, 4000);
}

function closeModeChooser() {
    document.getElementById('mode-overlay').classList.add('hidden');
    pendingModeSN = null;
    modeRefreshing = false;
    clearTimeout(refreshModeDevice._t);
}

// ----------------------------------------------------------------------------
// Android-style back handling
// The app is one page inside Chrome, so the hardware/swipe back gesture walks
// browser history - and the entry before the camera grid is the sign-in page,
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
    if (isOpen('settings-overlay')) { settingsBack(); return; }
    if (document.body.classList.contains('live-active')) { stopLiveView(); return; }
    if (isActive('timeline-screen')) { showScreen('cameras-screen'); return; }
    if (isActive('history-screen')) {
        if (historyPlayingId) closeHistoryPlayer(); else closeHistory();
        return;
    }
    if (isActive('health-screen')) { showScreen('cameras-screen'); return; }
    // Already at the camera grid - nothing to go back to; stay put.
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

// Tapped a detection notification → open that camera's recordings and jump to the
// clip nearest the detection time. The list loads over the WS, so stash the target
// and resolve it in onHistoryList() once the events arrive.
function openEventFromNotification(sn, time) {
    deepLinkCamera = null;
    if (!sn) return;
    pendingDeepLinkEvent = { sn, time: Number(time) || Date.now() };
    if (typeof stopLiveView === 'function' && currentDeviceSN) { try { stopLiveView(); } catch (e) {} }
    openHistory(sn);
}

// Once a recordings list is in, reveal (and play, if a clip exists) the event a
// notification pointed at: the nearest recording for that camera to the detection
// time. If the clip isn't ready yet, we still land on its row + snapshot on-target.
function resolveDeepLinkEvent() {
    const want = pendingDeepLinkEvent;
    if (!want) return;
    if (historyCamera && historyCamera !== want.sn) return;   // list is for another camera
    pendingDeepLinkEvent = null;                               // one-shot - no surprise autoplay later
    const WINDOW_MS = 180000;                                  // ±3 min of the detection
    let best = null, bestDiff = Infinity;
    for (const ev of historyEvents) {
        if (ev.serialNumber !== want.sn) continue;
        const diff = Math.abs(ev.start * 1000 - want.time);
        if (diff < bestDiff) { bestDiff = diff; best = ev; }
    }
    if (!best || bestDiff > WINDOW_MS) return;                 // nothing close - leave them on the list
    // Expand the event's (possibly collapsed) day, then reveal + highlight its row.
    const day = new Date(best.start * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    historyCollapsedDays.delete(day);
    renderHistory();
    const el = document.querySelector('.history-entry[data-id="' + (window.CSS && CSS.escape ? CSS.escape(best.id) : best.id) + '"]');
    if (el) {
        el.scrollIntoView({ block: 'center' });
        el.classList.add('deep-link');
        setTimeout(() => el.classList.remove('deep-link'), 4000);
    }
    if (best.canPlay) openHistoryClip(best.id);               // ready → play it straight away
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

    // Keep the "loading" indicator up until there's an actual picture (not just
    // when the connection opens) - the camera may still be waking up. Covers the
    // RTSP→P2P fallback too, since the listener outlives the retry.
    video.addEventListener('loadeddata', () => {
        document.getElementById('live-loading').classList.add('hidden');
    }, { once: true });

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

    // RTSP fast path: automatically used for any camera that supports it (the
    // server enables RTSP only while watching, then turns it off). Falls back to
    // the P2P pipeline below if RTSP yields nothing (e.g. a battery cam asleep).
    const useRtsp = forcePath ? forcePath.startsWith('/rtsp/') : !!devices[serialNumber]?.rtspSupported;
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

        // NB: loading stays visible until the video's 'loadeddata' (first frame),
        // wired up in startVideoStream - not here, where the stream has merely
        // connected but no picture has decoded yet.
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
// Frame View (Data Saver) - low-bandwidth JPEG polling
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
        // Network hiccup - keep trying
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

// ============================================================================
// First-run setup wizard - Eufy account login, incl. captcha / 2FA
// ============================================================================
let setupPollTimer = null;
let lastSetupSig = null;   // last rendered setup state; avoids re-rendering (and stomping the user's typing) when nothing changed

// On load, check whether the server is signed in to Eufy. If not (fresh install),
// show the wizard. If /setup/status is auth-gated (401) we leave it to the normal
// sign-in flow. Safe no-op once connected.
async function checkSetup() {
    try {
        const r = await fetch('/setup/status');
        if (!r.ok) return;                 // auth-gated or error → normal flow
        const s = await r.json();
        if (s.connected) return;           // already set up
        showSetup(s);
    } catch (e) { /* offline → normal flow handles it */ }
}

function showSetup(s) {
    document.getElementById('setup-overlay').classList.remove('hidden');
    lastSetupSig = null;   // force an initial render
    renderSetup(s);
    clearInterval(setupPollTimer);
    setupPollTimer = setInterval(pollSetup, 2000);
}

async function pollSetup() {
    try {
        const s = await (await fetch('/setup/status')).json();
        if (s.connected) {
            clearInterval(setupPollTimer);
            location.reload();             // reconnect everything now that Eufy is up
            return;
        }
        renderSetup(s);
    } catch (e) {}
}

function renderSetup(s) {
    // The wizard polls /setup/status every 2s. Only rebuild the DOM when the
    // visible state actually changes - otherwise a poll mid-typing would wipe
    // the email/password fields and steal focus.
    const sig = JSON.stringify([s.phase || '', s.captchaImage || '', s.message || '']);
    if (sig === lastSetupSig) return;
    lastSetupSig = sig;

    const body = document.getElementById('setup-body');
    const err = s.message ? `<p class="setup-err">${escapeText(s.message)}</p>` : '';

    if (s.phase === 'connecting') {
        body.innerHTML = '<p class="settings-hint">Connecting to Eufy…</p>';
        return;
    }
    if (s.phase === 'captcha' && s.captchaImage) {
        body.innerHTML = `
            <form id="setup-captcha-form">
            <p class="settings-hint">Enter the characters shown in the image:</p>
            <img class="setup-captcha" src="${s.captchaImage}" alt="captcha">
            <input id="setup-captcha-input" type="text" autocomplete="off" placeholder="Captcha" autofocus>
            <button id="setup-captcha-submit" type="submit" class="btn-primary">Submit</button>${err}
            </form>`;
        document.getElementById('setup-captcha-form').onsubmit = (e) => {
            e.preventDefault();
            submitSetupVerify({ captchaCode: document.getElementById('setup-captcha-input').value });
        };
        return;
    }
    if (s.phase === 'tfa') {
        body.innerHTML = `
            <form id="setup-tfa-form">
            <p class="settings-hint">Enter the verification code Eufy just sent to your email or phone:</p>
            <input id="setup-tfa-input" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="Verification code" autofocus>
            <button id="setup-tfa-submit" type="submit" class="btn-primary">Submit</button>${err}
            </form>`;
        document.getElementById('setup-tfa-form').onsubmit = (e) => {
            e.preventDefault();
            submitSetupVerify({ verifyCode: document.getElementById('setup-tfa-input').value });
        };
        return;
    }
    // idle / error / not configured → login form
    body.innerHTML = `
        <form id="setup-login-form">
        <p class="settings-hint">Sign in with your Eufy Security account to connect your cameras. Your credentials are stored only on this server.</p>
        <label>Email<input id="setup-email" type="email" autocomplete="username" autofocus></label>
        <label>Password<input id="setup-pass" type="password" autocomplete="current-password"></label>
        <div class="setup-row">
            <label>Country<input id="setup-country" type="text" maxlength="2" value="US"></label>
            <label>Language<input id="setup-lang" type="text" maxlength="2" value="en"></label>
        </div>
        <button id="setup-login-btn" type="submit" class="btn-primary">Connect</button>${err}
        </form>`;
    document.getElementById('setup-login-form').onsubmit = (e) => {
        e.preventDefault();
        submitSetupLogin();
    };
}

async function submitSetupLogin() {
    const username = document.getElementById('setup-email').value.trim();
    const password = document.getElementById('setup-pass').value;
    const country = (document.getElementById('setup-country').value || 'US').trim();
    const language = (document.getElementById('setup-lang').value || 'en').trim();
    if (!username || !password) { flashMessage('Email and password are required'); return; }
    document.getElementById('setup-body').innerHTML = '<p class="settings-hint">Connecting to Eufy…</p>';
    try {
        await fetch('/setup/eufy-login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, country, language })
        });
    } catch (e) {}
}

async function submitSetupVerify(payload) {
    document.getElementById('setup-body').innerHTML = '<p class="settings-hint">Verifying…</p>';
    try {
        await fetch('/setup/eufy-verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (e) {}
}

// "Pair a TV": ask the server for a short-lived code to show, which the TV app
// redeems for a device token. Counts down so the user knows when it expires.
let pairCodeTimer = null;
async function requestPairCode() {
    const out = document.getElementById('pair-tv-result');
    out.classList.remove('hidden');
    out.textContent = 'Generating…';
    clearInterval(pairCodeTimer);
    try {
        const r = await fetch('/auth/pair-code/new', { method: 'POST' });
        if (!r.ok) { out.textContent = 'Could not create a code (are you still signed in?).'; return; }
        const { code, expiresInSec } = await r.json();
        let left = expiresInSec || 300;
        const render = () => {
            const m = Math.floor(left / 60), s = String(left % 60).padStart(2, '0');
            out.innerHTML = `<div class="pair-code">${escapeText(String(code))}</div>` +
                `<p class="settings-hint">On the TV, enter this code to pair. Expires in ${m}:${s}.</p>`;
        };
        render();
        pairCodeTimer = setInterval(() => {
            left--;
            if (left <= 0) {
                clearInterval(pairCodeTimer);
                out.innerHTML = '<p class="settings-hint">Code expired - tap “Pair a TV” for a new one.</p>';
            } else render();
        }, 1000);
    } catch (e) {
        out.textContent = 'Error creating a code.';
    }
}

// ---- Install to Smart Devices (scan the LAN for TVs, ADB-install the TV app) ----
let smartPollTimer = null;
let smartApkVersion = null;   // version of the bundled TV APK (from the last scan)

// Flip a scan row to its "installed" state in place (Reinstall + Uninstall + badge).
function markRowInstalled(row, versionName) {
    const ip = row.dataset.ip;
    const actions = row.querySelector('.smart-actions');
    if (actions) {
        actions.innerHTML =
            `<button class="btn-secondary smart-install" data-ip="${ip}">Reinstall</button>` +
            `<button class="btn-secondary smart-uninstall" data-ip="${ip}">Uninstall</button>`;
        actions.querySelector('.smart-install').addEventListener('click', () => installSmartDevice(ip));
        actions.querySelector('.smart-uninstall').addEventListener('click', () => uninstallSmartDevice(ip));
    }
    let badge = row.querySelector('.smart-installed');
    if (!badge) { badge = document.createElement('span'); badge.className = 'smart-installed'; row.appendChild(badge); }
    const ver = versionName ? 'v' + versionName : 'installed';
    badge.classList.remove('smart-update');
    badge.textContent = '✓ Installed · ' + ver + ' · ' + new Date().toLocaleDateString();
}

// Flip a scan row back to its "not installed" state (single Install button).
function markRowUninstalled(row) {
    const ip = row.dataset.ip;
    const actions = row.querySelector('.smart-actions');
    if (actions) {
        actions.innerHTML = `<button class="btn-secondary smart-install" data-ip="${ip}">Install</button>`;
        actions.querySelector('.smart-install').addEventListener('click', () => installSmartDevice(ip));
    }
    const badge = row.querySelector('.smart-installed'); if (badge) badge.remove();
}

function deviceLabelFromRow(row) {
    const el = row.querySelector('.smart-name');
    return el ? el.textContent.trim() : '';
}

async function scanSmartDevices() {
    const out = document.getElementById('smart-devices');
    out.innerHTML = '<p class="settings-hint">Scanning your network…</p>';
    try {
        const r = await fetch('/devices/scan');
        if (!r.ok) { out.innerHTML = '<p class="settings-hint">Couldn’t scan (admin only).</p>'; return; }
        renderSmartDevices(await r.json());
    } catch (e) { out.innerHTML = '<p class="settings-hint">Scan error.</p>'; }
}

function renderSmartDevices(data) {
    const out = document.getElementById('smart-devices');
    smartApkVersion = (data.apkVersion && data.apkVersion.versionName) || null;
    if (!data.apk) { out.innerHTML = '<p class="settings-hint">The TV app isn’t bundled on this server, so auto-install is unavailable.</p>'; return; }
    if (!data.devices || !data.devices.length) {
        out.innerHTML = '<p class="settings-hint">No TVs found with ADB enabled. Turn on ADB debugging in the TV’s Developer Options, then Scan again.</p>';
        return;
    }
    out.innerHTML = data.devices.map(d => {
        const btnLabel = d.updateAvailable ? 'Update' : (d.installed ? 'Reinstall' : 'Install');
        const btnClass = d.updateAvailable ? 'btn-primary' : 'btn-secondary';
        let badge = '';
        if (d.installed) {
            const when = d.installedAt ? new Date(d.installedAt).toLocaleDateString() : '';
            const ver = d.installedVersion ? 'v' + escapeText(d.installedVersion) : 'installed';
            if (d.updateAvailable) {
                const to = data.apkVersion && data.apkVersion.versionName ? ' &rarr; v' + escapeText(data.apkVersion.versionName) : '';
                badge = `<span class="smart-installed smart-update">&#9650; Update available · ${ver}${to}</span>`;
            } else {
                badge = `<span class="smart-installed">&#10003; Installed · ${ver}${when ? ' · ' + escapeText(when) : ''}</span>`;
            }
        }
        const uninstallBtn = d.installed
            ? `<button class="btn-secondary smart-uninstall" data-ip="${escapeText(d.ip)}">Uninstall</button>`
            : '';
        return `
        <div class="smart-row" data-ip="${escapeText(d.ip)}">
            <span class="smart-ip">${escapeText(d.ip)}</span>
            <span class="smart-name">${escapeText(d.label || d.hostname || d.vendor || 'Android / Fire TV')}${d.needsAuth ? ' <span class="smart-auth">· allow on TV</span>' : ''}</span>
            <span class="smart-status"></span>
            <div class="smart-actions">
                <button class="${btnClass} smart-install" data-ip="${escapeText(d.ip)}">${btnLabel}</button>
                ${uninstallBtn}
            </div>
            ${badge}
        </div>`;
    }).join('');
    out.querySelectorAll('.smart-install').forEach(b =>
        b.addEventListener('click', () => installSmartDevice(b.dataset.ip)));
    out.querySelectorAll('.smart-uninstall').forEach(b =>
        b.addEventListener('click', () => uninstallSmartDevice(b.dataset.ip)));
}

async function installSmartDevice(ip) {
    const row = document.querySelector(`.smart-row[data-ip="${CSS.escape(ip)}"]`);
    if (row) {
        row.dataset.lastPhase = '';            // reset transition tracking for a fresh run
        row.querySelector('.smart-status').textContent = 'Starting…';
        row.querySelector('.smart-install').disabled = true;
    }
    try {
        await fetch('/devices/install', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip })
        });
    } catch (e) {}
    startSmartPolling();
}

async function uninstallSmartDevice(ip) {
    const row = document.querySelector(`.smart-row[data-ip="${CSS.escape(ip)}"]`);
    if (row && !confirm('Remove the EufyView TV app from this device?')) return;
    if (row) {
        row.dataset.lastPhase = '';            // reset transition tracking for a fresh run
        row.querySelector('.smart-status').textContent = 'Starting…';
        row.querySelectorAll('button').forEach(b => b.disabled = true);
    }
    try {
        await fetch('/devices/uninstall', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip })
        });
    } catch (e) {}
    startSmartPolling();
}

function startSmartPolling() {
    clearInterval(smartPollTimer);
    smartPollTimer = setInterval(async () => {
        let anyActive = false;
        try {
            const s = await (await fetch('/devices/status')).json();
            document.querySelectorAll('.smart-row').forEach(row => {
                const j = s[row.dataset.ip];
                if (!j) return;
                const changed = row.dataset.lastPhase !== j.phase;   // only act on transitions
                row.dataset.lastPhase = j.phase;
                const statusEl = row.querySelector('.smart-status');
                const btn = row.querySelector('.smart-install');
                const unbtn = row.querySelector('.smart-uninstall');
                if (['connecting', 'waiting-auth', 'installing', 'pairing', 'uninstalling'].includes(j.phase)) {
                    anyActive = true;
                    if (statusEl) statusEl.textContent = j.message || j.phase;
                    if (btn) btn.disabled = true;
                    if (unbtn) unbtn.disabled = true;
                } else if (j.phase === 'done') {
                    if (statusEl) statusEl.textContent = '';
                    if (changed) {
                        flashMessage('✓ EufyView installed on ' + (deviceLabelFromRow(row) || 'the TV'));
                        markRowInstalled(row, smartApkVersion);   // show Reinstall + Uninstall + badge
                    }
                } else if (j.phase === 'removed') {
                    if (statusEl) statusEl.textContent = '';
                    if (changed) {
                        flashMessage('EufyView removed from ' + (deviceLabelFromRow(row) || 'the TV'));
                        markRowUninstalled(row);
                    }
                } else if (j.phase === 'error') {
                    if (statusEl) statusEl.textContent = j.message || 'error';
                    if (btn) btn.disabled = false;
                    if (unbtn) unbtn.disabled = false;
                }
            });
        } catch (e) {}
        if (!anyActive) clearInterval(smartPollTimer);
    }, 1500);
}

function openSettings() {
    config = config || {};
    document.getElementById('cfg-scale').value = config.VIDEO_SCALE || '';
    document.getElementById('cfg-crf').value = config.TRANSCODING_CRF || '23';
    document.getElementById('cfg-crf-val').textContent = config.TRANSCODING_CRF || '23';

    document.getElementById('cfg-frame-fps').value = config.FRAME_FPS || '2';
    document.getElementById('cfg-frame-scale').value = config.FRAME_SCALE || '640:-2';
    document.getElementById('cfg-frame-quality').value = config.FRAME_QUALITY || '7';
    document.getElementById('cfg-frame-quality-val').textContent = config.FRAME_QUALITY || '7';

    syncPushButton();
    renderNotifToggles();
    gateSettingsMenu();
    startNotifStatusTimer();
    showSettingsMenu();            // always open on the menu, not a stale pane
    document.getElementById('settings-overlay').classList.remove('hidden');
}

const SETTINGS_PANE_TITLES = {
    notifications: 'Notifications',
    video: 'Video & Data Saver',
    pair: 'Pair a TV',
    installtv: 'Install to TV',
    users: 'Manage Users',
    server: 'Server Settings',
    access: 'Add user',
    about: 'About & Updates',
};

// Show the top-level menu (hide every pane + the Save/Cancel footer).
function showSettingsMenu() {
    document.getElementById('settings-menu').classList.remove('hidden');
    document.querySelectorAll('.settings-pane').forEach(p => p.classList.add('hidden'));
    document.getElementById('settings-back').classList.add('hidden');
    document.getElementById('settings-title').textContent = 'Settings';
    document.getElementById('settings-footer').classList.add('hidden');
}

// Drill into one area's pane.
function openSettingsPane(pane) {
    document.getElementById('settings-menu').classList.add('hidden');
    document.querySelectorAll('.settings-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== pane));
    document.getElementById('settings-back').classList.remove('hidden');
    document.getElementById('settings-title').textContent = SETTINGS_PANE_TITLES[pane] || 'Settings';
    // Save/Cancel only applies to Video & Data Saver; other panes save on action.
    document.getElementById('settings-footer').classList.toggle('hidden', pane !== 'video');
    // Admin areas load their data on open.
    if (pane === 'users' || pane === 'server') loadAdminData();
    if (pane === 'about') checkForUpdates(false);
}

// Back arrow: from Add/Edit user -> the user list; from any pane -> the menu;
// from the menu -> close. Used by the header back button and the Android back trap.
function settingsBack() {
    const accessOpen = !document.querySelector('.settings-pane[data-pane="access"]').classList.contains('hidden');
    const menuOpen = !document.getElementById('settings-menu').classList.contains('hidden');
    if (accessOpen) openSettingsPane('users');
    else if (!menuOpen) showSettingsMenu();
    else closeSettings();
}

// Show/hide the admin-only menu items (and the LAN-only "Install to TV" item).
async function gateSettingsMenu() {
    const isAdmin = !!(currentUser && currentUser.admin);
    document.querySelectorAll('#settings-menu .admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin));
    if (!isAdmin) return;
    if (!tvEnv) { try { tvEnv = await fetchJSON('/devices/env'); } catch (e) { tvEnv = {}; } }
    const lanCapable = !!(tvEnv && tvEnv.lanCapable);
    document.querySelectorAll('#settings-menu .admin-lan').forEach(el => el.classList.toggle('hidden', !lanCapable));
}

function closeSettings() {
    stopNotifStatusTimer();
    document.getElementById('settings-overlay').classList.add('hidden');
}

// ============================================================================
// About & Updates - check GitHub for a newer release and (on self-updating
// installs) download + launch the installer in place.
// ============================================================================

let lastUpdateInfo = null;
let applyPollTimer = null;

// Light-touch background check used on load: updates the "update available"
// dot without touching the (possibly closed) About pane.
async function refreshUpdateBadge() {
    try {
        const info = await fetchJSON('/updates/check');
        lastUpdateInfo = info;
        setUpdateBadge(info);
        maybeShowServerUpdateModal(info);
    } catch (e) { /* offline / server starting - try again next load */ }
}

function setUpdateBadge(info) {
    const show = !!(info && info.updateAvailable);
    const dot = document.getElementById('about-menu-dot');
    if (dot) dot.classList.toggle('hidden', !show);
    const gear = document.getElementById('settings-btn');
    if (gear) gear.classList.toggle('has-update', show);
}

// When a release update is detected on load, bring it to the foreground instead
// of only a Settings badge - one tap to update. Only for admins (a scoped user
// can't update the server, so they keep just the badge). Shown once per session
// per version so it doesn't nag after "Later".
function maybeShowServerUpdateModal(info) {
    if (!info || !info.updateAvailable || !info.latest) return;
    if (!(currentUser && currentUser.admin)) return;
    if (document.getElementById('update-modal')) return;         // SW reload modal wins
    if (document.getElementById('server-update-modal')) return;  // already showing
    let dismissed = null;
    try { dismissed = sessionStorage.getItem('srvUpdDismissed'); } catch (e) {}
    if (dismissed === info.latest.version) return;
    showServerUpdateModal(info);
}

function showServerUpdateModal(info) {
    const canSelf = !!info.canSelfUpdate;
    const overlay = document.createElement('div');
    overlay.id = 'server-update-modal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML =
        '<div class="modal-card">' +
        '<h3>Update available</h3>' +
        '<p>EufyView <b>v' + escapeText(info.latest.version) + '</b> is ready.</p>' +
        '<div id="su-status" class="about-progress hidden"></div>' +
        '<button type="button" class="btn-primary" id="su-primary">' +
        (canSelf ? 'Update now' : 'See what’s new') + '</button>' +
        '<button type="button" class="btn-secondary" id="su-later">Later</button>' +
        '</div>';
    const dismiss = () => {
        try { sessionStorage.setItem('srvUpdDismissed', info.latest.version); } catch (e) {}
        overlay.remove();
    };
    overlay.querySelector('#su-later').addEventListener('click', dismiss);
    const primary = overlay.querySelector('#su-primary');
    const status = overlay.querySelector('#su-status');
    primary.addEventListener('click', () => {
        if (!canSelf) {
            // Docker / manual install (or nothing to self-install) → show the
            // details + guidance in the About pane.
            overlay.remove();
            openSettings();
            openSettingsPane('about');
            return;
        }
        primary.disabled = true;
        primary.textContent = 'Updating…';
        status.classList.remove('hidden');
        status.textContent = 'Downloading update…';
        fetchJSON('/updates/apply', { method: 'POST' }).then(r => {
            if (r.ok && (r.launched || r.alreadyRunning)) {
                status.textContent = 'Installing… the app will reload when the server is back.';
                waitForServerRestart();
            } else if (r.reason === 'notify-only') {
                status.textContent = r.hint || 'Update this server manually, then restart it.';
                primary.classList.add('hidden');
            } else {
                status.textContent = 'Update failed: ' + (r.error || r.reason || 'unknown error');
                primary.disabled = false; primary.textContent = 'Try again';
            }
        }).catch(e => {
            status.textContent = 'Update failed: ' + e.message;
            primary.disabled = false; primary.textContent = 'Try again';
        });
    });
    document.body.appendChild(overlay);
}

// Fetch the current status and paint the About pane. `force` bypasses the
// server's cache (an explicit "Check for updates" tap).
async function checkForUpdates(force) {
    const statusEl = document.getElementById('about-update-status');
    const curEl = document.getElementById('about-current-version');
    if (statusEl) statusEl.textContent = 'Checking for updates…';
    const btn = document.getElementById('about-check-btn');
    if (btn) btn.disabled = true;
    try {
        const info = await fetchJSON('/updates/check' + (force ? '?force=1' : ''));
        lastUpdateInfo = info;
        setUpdateBadge(info);
        renderAboutPane(info);
    } catch (e) {
        if (curEl && lastUpdateInfo) curEl.textContent = 'v' + lastUpdateInfo.current;
        if (statusEl) statusEl.textContent = 'Couldn’t reach the update server.';
    } finally {
        if (btn) btn.disabled = false;
    }
}

function renderAboutPane(info) {
    const curEl = document.getElementById('about-current-version');
    const statusEl = document.getElementById('about-update-status');
    const notesEl = document.getElementById('about-update-notes');
    const btn = document.getElementById('about-update-btn');
    const hint = document.getElementById('about-update-hint');
    const progress = document.getElementById('about-update-progress');
    if (!curEl) return;

    curEl.textContent = 'v' + info.current;
    notesEl.classList.add('hidden');
    btn.classList.add('hidden');
    hint.classList.add('hidden');
    progress.classList.add('hidden');

    const isAdmin = !!(currentUser && currentUser.admin);

    if (info.updateAvailable && info.latest) {
        statusEl.textContent = 'Update available - v' + info.latest.version;
        statusEl.className = 'about-status about-status-update';
        if (info.latest.notes) {
            notesEl.textContent = info.latest.notes;
            notesEl.classList.remove('hidden');
        }
        if (info.canSelfUpdate && isAdmin) {
            // Self-updating install (Windows) + admin → offer the in-app button.
            btn.textContent = 'Download & install v' + info.latest.version;
            btn.disabled = false;
            btn.classList.remove('hidden');
        } else if (!isAdmin) {
            hint.textContent = 'Ask the administrator to install the update.';
            hint.classList.remove('hidden');
        } else {
            // Admin, but this install type can't self-update (docker / manual).
            hint.textContent = info.installType === 'docker'
                ? 'This server runs in Docker. Update it with: docker compose pull && docker compose up -d'
                : 'Update this server in place (git pull or re-download), then restart it.';
            hint.classList.remove('hidden');
        }
    } else if (info.error) {
        statusEl.textContent = 'Couldn’t check for updates right now.';
        statusEl.className = 'about-status';
    } else {
        statusEl.textContent = 'You’re on the latest version.';
        statusEl.className = 'about-status';
    }
}

async function applyUpdate() {
    const info = lastUpdateInfo;
    if (!info || !info.canSelfUpdate) return;
    const btn = document.getElementById('about-update-btn');
    const progress = document.getElementById('about-update-progress');
    const statusEl = document.getElementById('about-update-status');
    if (!confirm('Install v' + info.latest.version + ' now? The server will briefly restart and this page will reconnect automatically.')) return;

    btn.disabled = true;
    btn.textContent = 'Starting…';
    progress.classList.remove('hidden');
    progress.textContent = 'Downloading update…';
    try {
        const r = await fetchJSON('/updates/apply', { method: 'POST' });
        if (r.ok && (r.launched || r.alreadyRunning)) {
            progress.textContent = 'Installing… the server is restarting. This page will reload when it’s back.';
            statusEl.textContent = 'Updating to v' + (r.version || info.latest.version) + '…';
            waitForServerRestart();
        } else if (r.reason === 'notify-only') {
            progress.classList.add('hidden');
            btn.classList.add('hidden');
            const hint = document.getElementById('about-update-hint');
            hint.textContent = r.hint || 'Update this server manually, then restart it.';
            hint.classList.remove('hidden');
        } else if (r.reason === 'up-to-date') {
            progress.classList.add('hidden');
            checkForUpdates(true);
        } else {
            progress.textContent = 'Update failed: ' + (r.error || r.reason || 'unknown error');
            btn.disabled = false;
            btn.textContent = 'Try again';
        }
    } catch (e) {
        progress.textContent = 'Update failed: ' + e.message;
        btn.disabled = false;
        btn.textContent = 'Try again';
    }
}

// After the installer launches it stops the running server, swaps files, and
// relaunches it. Poll /health until it answers again, then reload the page so
// the browser (and service worker) pick up the new version.
function waitForServerRestart() {
    if (applyPollTimer) return;
    let sawDown = false;
    let tries = 0;
    applyPollTimer = setInterval(async () => {
        tries++;
        try {
            const res = await fetch('/health', { cache: 'no-store' });
            if (res.ok) {
                // Only reload once we've seen it actually go down and come back,
                // so we don't reload before the installer has swapped anything.
                if (sawDown) { clearInterval(applyPollTimer); location.reload(); }
            }
        } catch (e) {
            sawDown = true;   // server is down → installer is doing its work
        }
        // Give up visual polling after ~4 min; the SW update banner still covers it.
        if (tries > 80) { clearInterval(applyPollTimer); applyPollTimer = null; }
    }, 3000);
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

function keyBytesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// Return a push subscription bound to the server's CURRENT VAPID key, making a
// fresh one if needed. A subscription is tied to the applicationServerKey it was
// created with; if the server regenerated its VAPID keys (e.g. data/ was wiped),
// the old subscription is permanently undeliverable - the push service rejects
// it with 403 "VAPID credentials do not correspond". Reusing it (as we used to)
// meant push silently stayed broken forever. So compare the existing sub's key
// to the server's and, on mismatch, drop it and subscribe anew - reporting the
// rotated-away endpoint so the server carries this person's prefs across.
async function ensureFreshSubscription(reg, publicKey) {
    const appKey = urlBase64ToUint8Array(publicKey);
    let sub = await reg.pushManager.getSubscription();
    let oldEndpoint;
    if (sub) {
        const cur = sub.options && sub.options.applicationServerKey;
        // Only act on a positive mismatch; if the browser doesn't expose the key
        // we leave the sub alone rather than churn it needlessly.
        if (cur && !keyBytesEqual(new Uint8Array(cur), appKey)) {
            oldEndpoint = sub.endpoint;
            try { await sub.unsubscribe(); } catch (_) {}
            sub = null;
        }
    }
    if (!sub) {
        sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: appKey
        });
    }
    return { sub, oldEndpoint };
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

        const { sub, oldEndpoint } = await ensureFreshSubscription(reg, publicKey);

        await fetch('/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub, oldEndpoint, ...pushSettingsBody() })
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
        const { sub, oldEndpoint } = await ensureFreshSubscription(reg, publicKey);
        await fetch('/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub, oldEndpoint, ...pushSettingsBody() })
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

// Set the button from the REAL subscription state, not just the local flag -
// the flag can be stale (e.g. "on" while the browser has no subscription and
// the server has none). Keeps the local flag in sync with reality.
async function syncPushButton() {
    if (!pushSupported()) { renderPushButton(false); return; }
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        const on = !!sub && Notification.permission === 'granted';
        localStorage.setItem('pushEnabled', on ? '1' : '0');
        renderPushButton(on);
    } catch (e) {
        renderPushButton(false);
    }
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
            rows += `<div class="notif-group-label">${escapeText(getHouseName(houseId) || houseId)}</div>`;
        }
        rows += groups[houseId].map(sn => {
            const dev = devices[sn];
            const st = getCameraNotifStatus(sn);
            const chips = alertTypesFor(sn).map(t => {
                const on = isAlertTypeEnabled(sn, t.key);
                return `<button type="button" class="notif-type${on ? ' on' : ''}" data-sn="${sn}" data-type="${t.key}" aria-pressed="${on}">${t.label}</button>`;
            }).join('');
            return `<div class="notif-row${st.cls === 'off' ? ' disabled' : ''}" data-sn="${sn}">
                <span class="notif-name">${escapeText(dev.name || sn)}</span>
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
// Server Admin (admin only) - users, per-user camera access, admin account
// ============================================================================

// Settings: reveal the "Manage server" button only for the administrator.
let tvEnv = null;   // cached /devices/env: { lanCapable, platform, hasApk }

async function loadAdminData() {
    try {
        const [cams, access] = await Promise.all([ fetchJSON('/admin/cameras'), fetchJSON('/admin/users') ]);
        accessCatalog = (cams && cams.cameras) || [];
        renderAdminUsers(access);
        renderAdminLockouts(access);
    } catch (e) {
        const list = document.getElementById('admin-users');
        if (list) list.innerHTML = '<p class="settings-hint">Could not load users.</p>';
    }
}

function camSummary(cameras) {
    if (cameras === 'all') return 'All cameras';
    const n = (cameras || []).length;
    return n + ' camera' + (n === 1 ? '' : 's');
}
function timeAgo(ts) {
    if (!ts) return 'never';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
}

function renderAdminUsers(access) {
    const selfRow = document.getElementById('admin-admin-row');
    if (selfRow && access && access.admin) {
        selfRow.innerHTML = '<span class="admin-badge">Administrator</span>' +
            '<span class="admin-self-email">' + escapeText(access.admin.email) + '</span>' +
            '<span class="admin-self-meta">all cameras · last seen ' + timeAgo(access.admin.lastLogin) + '</span>';
    }
    const list = document.getElementById('admin-users');
    if (!list) return;
    accessUsers = (access && access.users) || [];
    if (!accessUsers.length) { list.innerHTML = '<p class="settings-hint">No users yet. Add one below.</p>'; return; }
    list.innerHTML = accessUsers.map(u => {
        let state, cls;
        if (u.hasPassword) { state = 'active'; cls = 'ok'; }
        else if (u.claimPending) { state = 'claim pending'; cls = 'warn'; }
        else { state = 'needs code'; cls = 'warn'; }
        return '<div class="admin-user" data-email="' + escapeText(u.email) + '">' +
            '<div class="admin-user-top"><span class="admin-user-email">' + escapeText(u.email) + '</span>' +
            '<span class="admin-pill ' + cls + '">' + state + '</span></div>' +
            '<div class="admin-user-meta">' + camSummary(u.cameras) + ' · last seen ' + timeAgo(u.lastLogin) +
            (u.lastIp ? ' · ' + escapeText(u.lastIp) : '') + '</div>' +
            '<div class="admin-user-actions">' +
            '<button class="admin-act" data-act="edit">Access</button>' +
            '<button class="admin-act" data-act="reset">Reset password</button>' +
            '<button class="admin-act danger" data-act="remove">Remove</button>' +
            '</div></div>';
    }).join('');
}

function renderAdminLockouts(access) {
    const box = document.getElementById('admin-lockouts');
    if (!box) return;
    const lk = (access && access.lockouts) || { emails: [], ips: [] };
    const rows = [];
    (lk.emails || []).forEach(e => rows.push('Account ' + escapeText(e.email) + ' - ' + e.retryAfterSec + 's left'));
    (lk.ips || []).forEach(i => rows.push('IP ' + escapeText(i.ip) + ' - ' + i.retryAfterSec + 's left'));
    box.innerHTML = rows.length ? rows.map(r => '<div class="admin-lock">' + r + '</div>').join('') : '<p class="settings-hint">No active lockouts.</p>';
}

// Edit / Reset / Remove buttons inside the user list (event-delegated).
function onAdminUsersClick(e) {
    const btn = e.target.closest('.admin-act');
    if (!btn) return;
    const row = e.target.closest('.admin-user');
    const email = row && row.dataset.email;
    const u = accessUsers.find(x => x.email === email);
    const act = btn.dataset.act;
    if (act === 'edit') {
        openAccessPage(email, u && u.cameras === 'all' ? 'all' : (u ? (u.cameras || []) : []));
    } else if (act === 'reset') {
        if (confirm('Reset ' + email + '’s password? Their current password stops working and they set a new one with a fresh code.')) adminResetPassword(email);
    } else if (act === 'remove') {
        if (confirm('Remove ' + email + '? They lose access immediately.')) adminRemoveUser(email);
    }
}

async function adminResetPassword(email) {
    try {
        const r = await fetchJSON('/admin/users/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        if (r.success) { showClaimCode(r.claimCode); loadAdminData(); }
    } catch (e) {}
}
async function adminRemoveUser(email) {
    try {
        const r = await fetchJSON('/admin/users', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        if (r.success) loadAdminData();
    } catch (e) {}
}

// One-time claim-code modal (shown after Add user / Reset password).
function showClaimCode(code) {
    const m = document.getElementById('claim-modal');
    document.getElementById('claim-code').textContent = code || '(none)';
    m._code = code;
    m.classList.remove('hidden');
}
function hideClaimCode() { document.getElementById('claim-modal').classList.add('hidden'); }

// Admin account: change email and/or password (requires current password).
async function saveAdminAccount() {
    const newEmail = document.getElementById('aa-email').value.trim();
    const newPassword = document.getElementById('aa-pass').value;
    const currentPassword = document.getElementById('aa-current').value;
    const msg = document.getElementById('aa-msg');
    const setMsg = (t, ok) => { msg.textContent = t; msg.className = 'admin-msg ' + (ok ? 'ok' : 'err'); };
    if (!currentPassword) return setMsg('Enter your current password.', false);
    if (!newEmail && !newPassword) return setMsg('Nothing to change.', false);
    if (newPassword && newPassword.length < 8) return setMsg('New password must be at least 8 characters.', false);
    try {
        const r = await fetchJSON('/admin/account', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newEmail: newEmail || undefined, newPassword: newPassword || undefined })
        });
        if (r.success) {
            setMsg('Saved.' + (newEmail ? ' Sign in again with your new email.' : ''), true);
            document.getElementById('aa-pass').value = '';
            document.getElementById('aa-current').value = '';
        } else setMsg(r.error || 'Could not save.', false);
    } catch (e) { setMsg('Could not save.', false); }
}

// ---- Camera-assignment pane (add / edit a user's cameras), inside the dialog ----

// Open the access pane for a new user (email = null) or to edit an existing one.
function openAccessPage(email, cameras) {
    accessEditEmail = email || null;
    accessAll = (cameras === 'all');
    accessSelected = new Set(accessAll ? accessCatalog.map(c => c.serialNumber) : (cameras || []));
    const emailEl = document.getElementById('access-email');
    emailEl.value = email || '';
    emailEl.readOnly = !!email;            // can't rename an existing person
    const btn = document.getElementById('access-save-btn');
    btn.textContent = email ? 'Save changes' : 'Create user';
    btn.disabled = false;
    setAccessMsg('');
    renderAccessCamBoxes();
    openSettingsPane('access');
    document.getElementById('settings-title').textContent = email || 'Add user';
    if (!email) { try { emailEl.focus(); } catch (e) {} }
}

// Leave the access pane (without saving) and return to the user list.
function closeAccessPage() { openSettingsPane('users'); }

// Render cameras grouped by house, with a per-house toggle and an "all" toggle.
function renderAccessCamBoxes() {
    const box = document.getElementById('access-cameras');
    if (!box) return;
    if (!accessCatalog.length) { box.innerHTML = '<p class="settings-hint">No cameras discovered yet.</p>'; return; }
    const groups = {};
    accessCatalog.forEach(c => { const h = c.houseName || 'Other'; (groups[h] = groups[h] || []).push(c); });
    let html = '<label class="access-all"><input type="checkbox" id="access-all-cb"' + (accessAll ? ' checked' : '') +
        '> All cameras <span class="access-all-note">(including any added later)</span></label>';
    Object.keys(groups).sort().forEach(house => {
        const cams = groups[house];
        const allOn = cams.every(c => accessSelected.has(c.serialNumber));
        html += '<div class="access-house"><label class="access-house-head"><input type="checkbox" class="access-house-cb" data-house="' +
            escapeText(house) + '"' + (allOn ? ' checked' : '') + '> ' + escapeText(house) + '</label><div class="access-cam-grid">';
        html += cams.map(c => {
            const on = accessSelected.has(c.serialNumber) ? ' selected' : '';
            return '<div class="access-cam-box' + on + '" data-sn="' + escapeText(c.serialNumber) + '"><span class="access-cam-name">' +
                escapeText(c.name || c.serialNumber) + '</span></div>';
        }).join('');
        html += '</div></div>';
    });
    box.innerHTML = html;
    box.classList.toggle('access-locked', accessAll);   // dim individual boxes when "all"
}

// Clicks inside the camera area: the "all" toggle, a house toggle, or a camera.
function onAccessCamClick(e) {
    if (e.target.id === 'access-all-cb') {
        accessAll = e.target.checked;
        if (accessAll) accessSelected = new Set(accessCatalog.map(c => c.serialNumber));
        renderAccessCamBoxes();
        return;
    }
    const houseCb = e.target.closest('.access-house-cb');
    if (houseCb) {
        const house = houseCb.dataset.house;
        const cams = accessCatalog.filter(c => (c.houseName || 'Other') === house).map(c => c.serialNumber);
        if (houseCb.checked) cams.forEach(sn => accessSelected.add(sn)); else cams.forEach(sn => accessSelected.delete(sn));
        accessAll = false;
        renderAccessCamBoxes();
        return;
    }
    if (accessAll) return;                 // individual boxes locked while "all" is on
    const cell = e.target.closest('.access-cam-box');
    if (!cell) return;
    const sn = cell.dataset.sn;
    if (accessSelected.has(sn)) { accessSelected.delete(sn); cell.classList.remove('selected'); }
    else { accessSelected.add(sn); cell.classList.add('selected'); }
}

// Create user / Save changes → persist, surface any claim code, return.
async function submitAccessUser() {
    const emailEl = document.getElementById('access-email');
    const email = (emailEl ? emailEl.value : '').trim();
    if (!email || email.indexOf('@') === -1) { setAccessMsg('Enter a valid email address.'); return; }
    const btn = document.getElementById('access-save-btn');
    btn.disabled = true;
    setAccessMsg('Saving…');
    const cameras = accessAll ? 'all' : Array.from(accessSelected);
    try {
        let r;
        if (accessEditEmail) {
            r = await fetchJSON('/admin/users/access', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: accessEditEmail, cameras }) });
        } else {
            r = await fetchJSON('/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, cameras }) });
        }
        if (r.success) {
            openSettingsPane('users');   // back to the user list (reloads data)
            if (r.claimCode) showClaimCode(r.claimCode);
        } else {
            setAccessMsg(r.error || 'Save failed.');
            btn.disabled = false;
        }
    } catch (e) {
        setAccessMsg('Save failed.');
        btn.disabled = false;
    }
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
        houseName: getHouseName(getDeviceHouseId(evt.serialNumber)),
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
        // House may not have been known when the event first arrived - resolve late.
        const house = evt.houseName || getHouseName(getDeviceHouseId(evt.serialNumber));
        const where = house ? house + ' - ' + evt.cameraName : evt.cameraName;
        return `<div class="timeline-entry" role="button" tabindex="0" data-sn="${escapeText(evt.serialNumber)}" data-time="${evt.time.getTime()}">
            <div class="timeline-icon" style="background:${color}">${icon}</div>
            <div class="timeline-info">
                <div class="timeline-event">${escapeText(evt.label)}</div>
                <div class="timeline-camera">${escapeText(where)}</div>
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
            html += `<div class="health-station-label">${escapeText(getHouseName(houseId) || houseId)}</div>`;
        }
        html += groups[houseId].map(sn => renderHealthCard(sn)).join('');
    });
    list.innerHTML = html;
}

function renderHealthCard(sn) {
    const dev = devices[sn];
    const battery = dev.battery;
    const rssi = dev.wifiRssi;
    const online = isDeviceReachable(dev);

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
        <div class="health-name">${statusDot} ${escapeText(dev.name || sn)}</div>
        <div class="health-model">${dev.model ? `${escapeText(modelName(dev.model))} (${escapeText(dev.model)})` : 'Unknown model'}</div>
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
let historyFilter = 'all';
let historyCoverage = null;     // { days, labels, oldest, newest, backfill } from history.coverage
let historyCalMonth = null;     // Date (1st of the month) currently shown in the calendar popover
let historyJumpBefore = null;   // epoch ms: a fresh load anchored to a picked date (vs. newest)
const HISTORY_CATS = [
    { key: 'person', label: 'Person' },
    { key: 'pet', label: 'Pet' },
    { key: 'vehicle', label: 'Vehicle' },
    { key: 'ring', label: 'Ring' },
    { key: 'package', label: 'Package' },
    { key: 'sound', label: 'Sound' },
    { key: 'motion', label: 'Motion' }
];
// Map an event's label to a filter category (labels come from the server's labelFor)
function historyCategory(label) {
    const l = String(label || '').toLowerCase();
    if (l.includes('person') || l.includes('stranger') || l.includes('face')) return 'person';
    if (l.includes('pet')) return 'pet';
    if (l.includes('vehicle')) return 'vehicle';
    if (l.includes('ring')) return 'ring';
    if (l.includes('package')) return 'package';
    if (l.includes('sound') || l.includes('crying')) return 'sound';
    return 'motion';   // Motion, Activity detected, anything else
}
// Show a chip for every category present in the loaded events OR anywhere in the
// backfilled cache (coverage.labels) - so the full filter set is there from the
// first page instead of only appearing as you load older.
function renderHistoryFilters() {
    const bar = document.getElementById('history-filters');
    if (!bar) return;
    const present = new Set();
    if (historyCoverage && historyCoverage.labels) {
        for (const lbl of Object.keys(historyCoverage.labels)) present.add(historyCategory(lbl));
    }
    for (const e of historyEvents) present.add(historyCategory(e.label));
    // Hide the bar only when there's genuinely nothing to filter by (at most one
    // category across everything we know). Do NOT key this off an empty
    // historyEvents: the list is transiently empty while a category query is in
    // flight, and a coverage response arriving in that window must not wipe the
    // user's selected chip back to "All".
    if (present.size <= 1) {
        bar.classList.add('hidden'); bar.innerHTML = ''; historyFilter = 'all'; return;
    }
    if (historyFilter !== 'all' && !present.has(historyFilter)) historyFilter = 'all';
    const cats = HISTORY_CATS.filter(c => present.has(c.key));
    const chip = (key, label) => `<button class="history-chip${historyFilter === key ? ' on' : ''}" data-cat="${key}">${label}</button>`;
    bar.innerHTML = chip('all', 'All') + cats.map(c => chip(c.key, c.label)).join('');
    bar.classList.remove('hidden');
    bar.querySelectorAll('.history-chip').forEach(b => b.addEventListener('click', () => {
        if (historyFilter === b.dataset.cat) return;
        historyFilter = b.dataset.cat;
        // Reflect the selection immediately (don't wait for the server round-trip
        // to re-render the chips).
        bar.querySelectorAll('.history-chip').forEach(c => c.classList.toggle('on', c.dataset.cat === historyFilter));
        // Re-query from the server so a category jumps to the most recent 7 days
        // that actually contain that event type (using the backfilled cache),
        // instead of only filtering whatever is currently on screen.
        loadHistory(false);
    }));
}

// ---- Coverage summary (date picker + filters + backfill progress) -----------
function requestHistoryCoverage() {
    const scr = document.getElementById('history-screen');
    if (!scr || !scr.classList.contains('active')) return;
    wsSend({ command: 'history.coverage', serialNumber: historyCamera || undefined });
}

function onHistoryCoverage(msg) {
    if (!msg.success || !msg.result) return;
    historyCoverage = msg.result;
    renderHistoryFilters();
    renderBackfillStatus();
    if (!document.getElementById('history-calpop').classList.contains('hidden')) renderCalendar();
}

// A quiet one-line note while the server is still indexing older recordings, so
// the user knows the date picker / older pages are still filling in.
function renderBackfillStatus() {
    const el = document.getElementById('history-backfill');
    if (!el) return;
    const bf = historyCoverage && historyCoverage.backfill;
    if (!bf || !bf.running) { el.classList.add('hidden'); el.textContent = ''; return; }
    const from = bf.coveredFrom ? new Date(bf.coveredFrom).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : null;
    el.textContent = from ? `Indexing older recordings… (back to ${from} so far)` : 'Indexing older recordings…';
    el.classList.remove('hidden');
}

// ---- Date picker (mini month calendar) --------------------------------------
const HISTORY_DAY_MS = 86400000;
// Day key matching the server's UTC-based grouping in coverage.days.
function histDayKey(d) { return new Date(d).toISOString().slice(0, 10); }

function toggleCalendar() {
    const pop = document.getElementById('history-calpop');
    if (pop.classList.contains('hidden')) openCalendar(); else closeCalendar();
}
function openCalendar() {
    const newest = historyCoverage && historyCoverage.newest ? new Date(historyCoverage.newest) : new Date();
    historyCalMonth = new Date(newest.getFullYear(), newest.getMonth(), 1);
    document.getElementById('history-calpop').classList.remove('hidden');
    renderCalendar();
    requestHistoryCoverage();   // refresh event-day set in case backfill advanced
}
function closeCalendar() {
    document.getElementById('history-calpop').classList.add('hidden');
}

function renderCalendar() {
    const grid = document.getElementById('history-cal-grid');
    const monthEl = document.getElementById('history-cal-month');
    const note = document.getElementById('history-cal-note');
    if (!grid || !historyCalMonth) return;
    const days = (historyCoverage && historyCoverage.days) || {};
    const oldest = historyCoverage && historyCoverage.oldest ? new Date(historyCoverage.oldest) : null;
    const newest = historyCoverage && historyCoverage.newest ? new Date(historyCoverage.newest) : null;
    const y = historyCalMonth.getFullYear(), m = historyCalMonth.getMonth();
    monthEl.textContent = historyCalMonth.toLocaleDateString([], { month: 'long', year: 'numeric' });

    // Prev/next bounded by the cached span.
    const prevBtn = document.getElementById('history-cal-prev');
    const nextBtn = document.getElementById('history-cal-next');
    prevBtn.disabled = oldest ? (new Date(y, m, 1) <= new Date(oldest.getFullYear(), oldest.getMonth(), 1)) : false;
    nextBtn.disabled = newest ? (new Date(y, m, 1) >= new Date(newest.getFullYear(), newest.getMonth(), 1)) : true;

    const first = new Date(y, m, 1);
    const startPad = first.getDay();                 // 0=Sun
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    let html = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(d => `<span class="cal-dow">${d}</span>`).join('');
    for (let i = 0; i < startPad; i++) html += '<span class="cal-cell cal-empty"></span>';
    for (let d = 1; d <= daysInMonth; d++) {
        const key = histDayKey(new Date(Date.UTC(y, m, d)));
        const count = days[key] || 0;
        const cls = count ? 'cal-cell cal-has' : 'cal-cell cal-none';
        html += `<button class="${cls}" data-day="${key}"${count ? ` title="${count} event${count === 1 ? '' : 's'}"` : ' disabled'}>${d}${count ? '<span class="cal-dot"></span>' : ''}</button>`;
    }
    grid.innerHTML = html;
    grid.querySelectorAll('.cal-has').forEach(b => b.addEventListener('click', () => {
        const [yy, mm, dd] = b.dataset.day.split('-').map(Number);
        // Anchor the load to the END of the picked day (local), so that day is the
        // newest shown and the list pages back from there.
        const before = new Date(yy, mm - 1, dd, 23, 59, 59, 999).getTime() + 1;
        closeCalendar();
        loadHistory(false, before);
    }));
    const bf = historyCoverage && historyCoverage.backfill;
    note.textContent = bf && bf.running ? 'Still indexing - more days will appear as older recordings are found.' : '';
}
function calShiftMonth(delta) {
    if (!historyCalMonth) return;
    historyCalMonth = new Date(historyCalMonth.getFullYear(), historyCalMonth.getMonth() + delta, 1);
    renderCalendar();
}
let historyAfter = null;        // oldest boundary loaded (epoch ms) → "Load older"
let historyPlayingId = null;
let historyStreaming = false;   // current clip is playing a live (in-progress) stream
let historyLoading = false;
let historyPagedOlder = false;  // user has tapped "Load older" → don't auto-refresh under them
let historyDataSaver = false;   // play events as low-fps JPEG frames (metered/blocked WiFi)
let historyPlayMode = 'video';  // 'video' | 'frames' - how the open clip is being played
let framePlay = null;           // { id, count, fps, idx, playing, timer } when in frame mode
// Recordings accordion state. By default only the newest day is expanded and every
// older day starts collapsed; `historyCollapsedDays` holds the day labels (e.g.
// "Wed, Oct 21") currently collapsed, and `historyDaysToggled` tracks the days the
// viewer has clicked this session so a manual choice isn't overridden on re-render.
let historyCollapsedDays = new Set();
let historyDaysToggled = new Set();

// Distinct day labels in the loaded events, newest first.
function historyDayLabel(ev) {
    return new Date(ev.start * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function historyDistinctDays() {
    const days = [];
    for (const ev of historyEvents) { const d = historyDayLabel(ev); if (!days.includes(d)) days.push(d); }
    return days;
}
// Apply the default collapse state: newest day open, the rest collapsed, leaving any
// day the viewer explicitly toggled this session alone. `reset` (a fresh, non-append
// load) clears those manual choices so the list opens at the default again.
function applyHistoryDayDefaults(reset) {
    if (reset) historyDaysToggled = new Set();
    const days = historyDistinctDays();
    days.forEach((d, i) => {
        if (historyDaysToggled.has(d)) return;
        if (i === 0) historyCollapsedDays.delete(d); else historyCollapsedDays.add(d);
    });
}
let historySilent = [];       // cameras whose hub didn't answer the last query
let historyHb3 = [];          // cameras on a HomeBase S380 (detections only, no clip list)

function openHistory(sn) {
    historyCamera = sn || '';
    const sel = document.getElementById('history-camera');
    sel.innerHTML = '<option value="">All cameras</option>' + Object.keys(devices)
        .map(d => `<option value="${d}">${escapeText(devices[d].name || d)}</option>`).join('');
    sel.value = historyCamera;
    historyCoverage = null;
    closeCalendar();
    closeHistoryPlayer();
    showScreen('history-screen');
    loadHistory(false);
}

function closeHistory() {
    closeHistoryPlayer();
    showScreen('cameras-screen');
}

let historyMoreTimer = null;

function loadHistory(append, jumpBefore) {
    if (historyLoading) return;
    historyLoading = true;
    historyJumpBefore = append ? historyJumpBefore : (jumpBefore || null);
    const more = document.getElementById('history-more');
    if (!append) {
        historyEvents = [];
        historyAfter = null;
        historyPagedOlder = false;
        document.getElementById('history-list').innerHTML = '<p class="settings-hint" style="padding:16px 0">Loading recordings…</p>';
        document.getElementById('history-empty').classList.add('hidden');
        more.classList.add('hidden');
    } else {
        historyPagedOlder = true;
        // Appending: keep the button in place as a live status line so the user
        // sees progress instead of it silently vanishing.
        more.classList.remove('hidden');
        more.disabled = true;
        more.classList.add('loading');
        more.textContent = 'Fetching older clips…';
    }
    wsSend({
        command: 'history.list',
        serialNumber: historyCamera || undefined,
        before: append ? historyAfter : (historyJumpBefore || undefined),
        category: historyFilter !== 'all' ? historyFilter : undefined
    });
    requestHistoryCoverage();
    // Watchdog: a station walk-back can be slow, but never leave the control stuck
    // on "Fetching…" if no result comes back at all.
    clearTimeout(historyMoreTimer);
    historyMoreTimer = setTimeout(() => {
        if (!historyLoading) return;
        historyLoading = false;
        if (append) {
            more.disabled = false;
            more.classList.remove('loading');
            more.classList.remove('hidden');
            more.textContent = 'Still searching… tap to keep trying';
        }
    }, 90000);
}

function onHistoryList(msg) {
    historyLoading = false;
    clearTimeout(historyMoreTimer);
    const more = document.getElementById('history-more');
    more.disabled = false;
    more.classList.remove('loading');
    // Whether this response is for a "Load older" tap (server echoes append).
    const appending = !!(msg.result && msg.result.append);

    if (!msg.success) {
        if (appending && historyEvents.length) {
            // Keep what's already loaded; let the user retry the older fetch.
            more.classList.remove('hidden');
            more.textContent = 'Couldn’t load older - tap to retry';
        } else {
            document.getElementById('history-list').innerHTML =
                `<p class="settings-hint" style="padding:16px 0">Couldn't load recordings: ${escapeText(msg.errorCode || 'error')}</p>`;
        }
        return;
    }
    const r = msg.result;
    const added = (r.events || []).length;
    historyEvents = r.append ? historyEvents.concat(r.events) : r.events;
    historyAfter = r.after;
    historySilent = (r.sources || []).filter(x => x.timeouts || x.error).map(x => (x.cameras || [x.station]).join(', '));
    historyHb3 = (r.sources || []).filter(x => x.hb3).map(x => (x.cameras || []).join(', '));
    applyHistoryDayDefaults(!r.append);   // newest day expanded, older days collapsed
    renderHistory();

    if (r.after) {
        // There's an older cursor → keep offering "Load older".
        more.textContent = `Load older (before ${new Date(r.after).toLocaleDateString()})`;
        more.disabled = false;
        more.classList.remove('hidden');
    } else if (r.append) {
        // A "Load older" tap that reached the end of the look-back. Leave a clear
        // terminal note instead of silently removing the button.
        more.textContent = added ? 'No older recordings' : 'No older recordings found';
        more.disabled = true;
        more.classList.remove('hidden');
    } else {
        // Initial load with no older cursor → nothing to page back through.
        more.classList.add('hidden');
    }

    // Auxiliary (must never affect the button state above): refresh the date
    // picker / filters, and jump to a notification's event if one is pending.
    try { requestHistoryCoverage(); } catch (e) { /* non-critical */ }
    try { resolveDeepLinkEvent(); } catch (e) { /* non-critical */ }
}

function renderHistory() {
    const list = document.getElementById('history-list');
    renderHistoryFilters();
    renderBackfillStatus();
    const shown = historyFilter === 'all'
        ? historyEvents
        : historyEvents.filter(e => historyCategory(e.label) === historyFilter);
    document.getElementById('history-empty').classList.toggle('hidden', historyEvents.length > 0);
    let html = '';
    if (historyHb3.length) {
        html += `<p class="settings-hint" style="padding:8px 0 0">${escapeText(historyHb3.join(', '))}: HomeBase S380 recordings can't be listed yet - showing detections EufyView has seen, with snapshots.</p>`;
    }
    if (historySilent.length) {
        html += `<p class="settings-hint" style="padding:8px 0 0">Not responding, so recordings not listed: ${escapeText(historySilent.join('; '))}</p>`;
    }
    if (shown.length === 0 && historyEvents.length > 0) {
        const lbl = (HISTORY_CATS.find(c => c.key === historyFilter) || {}).label || 'matching';
        html += `<p class="settings-hint" style="padding:16px 0">No ${escapeText(lbl)} events in this range - Load older to search further.</p>`;
    }
    // Group events by day into collapsible (accordion) sections.
    const groups = [];
    let cur = null;
    for (const ev of shown) {
        const start = new Date(ev.start * 1000);
        const day = start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        if (!cur || cur.day !== day) { cur = { day, events: [] }; groups.push(cur); }
        cur.events.push(ev);
    }
    for (const g of groups) {
        const collapsed = historyCollapsedDays.has(g.day);
        html += `<section class="history-day-group${collapsed ? ' collapsed' : ''}">`;
        html += `<button class="history-day" data-day="${escapeText(g.day)}" aria-expanded="${collapsed ? 'false' : 'true'}">
            <span class="history-day-chevron">&#9662;</span>
            <span class="history-day-label">${escapeText(g.day)}</span>
            <span class="history-day-count">${g.events.length}</span>
        </button>`;
        html += `<div class="history-day-body">`;
        for (const ev of g.events) {
            const start = new Date(ev.start * 1000);
            const secs = ev.end > ev.start ? ev.end - ev.start : 0;
            const time = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            const name = devices[ev.serialNumber]?.name || ev.deviceName;
            // Prefix the house/location so the camera reads "Candace - Back yard".
            const house = getHouseName(getDeviceHouseId(ev.serialNumber));
            const where = house ? house + ' - ' + name : name;
            // ?g is a thumbnail-generation cache-buster: bump it when server-side
            // thumbnail processing changes (g2 = HomeBase-2 v2 geometry repair), so
            // clients fetch fresh instead of serving a stale long-cached image.
            const thumbUrl = ev.snap || (ev.hasThumb ? `/history/thumb/${ev.id}.jpg?g=3` : null);
            const thumb = thumbUrl ? `<img src="${thumbUrl}" loading="lazy" alt="">` : '';
            html += `<button class="history-entry${ev.id === historyPlayingId ? ' playing' : ''}" data-id="${ev.id}"${ev.canPlay || ev.snap ? '' : ' disabled'}>
                <div class="history-thumb">${thumb || '&#127902;'}</div>
                <div class="history-info">
                    <div class="history-label">${escapeText(ev.label)}</div>
                    <div class="history-sub">${escapeText(where)} · ${time}${secs ? ` · ${secs}s` : ''}</div>
                </div>
                ${ev.cached ? '<span class="history-saved">Saved</span>' : (ev.canPlay ? '<span class="history-saved">&#9654;</span>' : '')}
            </button>`;
        }
        html += `</div></section>`;
    }
    list.innerHTML = html;
    // A thumbnail that fails to load falls back to the film icon
    list.querySelectorAll('.history-thumb img').forEach(img => {
        img.addEventListener('error', () => { img.parentElement.innerHTML = '&#127902;'; });
    });
    list.querySelectorAll('.history-entry').forEach(btn => {
        btn.addEventListener('click', () => openHistoryClip(btn.dataset.id));
    });
    // Collapse/expand a day. Toggling the class (rather than re-rendering) keeps the
    // thumbnails loaded; the choice sticks for the rest of this session.
    list.querySelectorAll('.history-day').forEach(btn => {
        btn.addEventListener('click', () => {
            const day = btn.dataset.day;
            const group = btn.closest('.history-day-group');
            const nowCollapsed = group.classList.toggle('collapsed');
            if (nowCollapsed) historyCollapsedDays.add(day); else historyCollapsedDays.delete(day);
            historyDaysToggled.add(day);
            btn.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
        });
    });
}

function openHistoryClip(id) {
    const ev = historyEvents.find(e => e.id === id);
    if (!ev) return;
    historyPlayingId = id;
    historyStreaming = false;
    const video = document.getElementById('history-video');
    video.pause();
    video.removeAttribute('src');
    video.load();
    const name = devices[ev.serialNumber]?.name || ev.deviceName;
    const house = getHouseName(getDeviceHouseId(ev.serialNumber));
    const where = house ? house + ' - ' + name : name;
    document.getElementById('history-player-title').textContent =
        `${ev.label} · ${where} · ${new Date(ev.start * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    const player = document.getElementById('history-player');
    player.classList.remove('hidden');
    // Scroll back up to the player - the list can be long and the player sits on top.
    player.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelectorAll('.history-entry').forEach(b => b.classList.toggle('playing', b.dataset.id === id));
    const img = document.getElementById('history-image');
    const dl = document.getElementById('history-download');
    stopFramePlayback();   // leaving any prior clip's frame slideshow
    // Detection-only entry: show its snapshot (no recorded clip to fetch or download)
    if (!ev.canPlay) {
        video.classList.add('hidden');
        dl.classList.add('hidden');
        img.src = ev.snap;
        img.classList.remove('hidden');
        setHistoryStatus('Snapshot - no recorded clip available for this event');
        return;
    }
    dl.classList.remove('hidden');   // download always offers the full MP4

    historyPlayMode = historyDataSaver ? 'frames' : 'video';
    if (historyPlayMode === 'frames') {
        // Data Saver: hide the video, show the frame slideshow once the clip is
        // cached server-side (same device.history_play download triggers it).
        stopFramePlayback();
        video.classList.add('hidden');
        img.classList.add('hidden');
        img.removeAttribute('src');
        setHistoryStatus(ev.cached ? 'Preparing data saver frames…' : 'Requesting clip from camera…');
        wsSend({ command: 'device.history_play', serialNumber: ev.serialNumber, id });
        return;
    }

    img.classList.add('hidden');
    img.removeAttribute('src');
    showFrameControls(false);
    video.classList.remove('hidden');
    setHistoryStatus(ev.cached ? '' : 'Requesting clip from camera…');
    wsSend({ command: 'device.history_play', serialNumber: ev.serialNumber, id });
}

function playHistoryClip(url) {
    const video = document.getElementById('history-video');
    // Clear the status once real frames are on screen; while still streaming, a stall
    // (the hub delivers a clip in bursts) shows "Buffering…" instead of looking frozen.
    video.onplaying = () => setHistoryStatus('');
    video.onwaiting = () => { if (historyStreaming && !video.ended) setHistoryStatus('Buffering…'); };
    video.src = url;
    video.play().catch(() => { /* autoplay may be blocked; controls are visible */ });
}

// Download the clip currently open in the player, with a toast (the browser's native
// three-dots "Download" can't be hooked by the page, so we expose our own button).
function downloadHistoryClip() {
    const ev = historyEvents.find(e => e.id === historyPlayingId);
    if (!ev || !ev.canPlay) return;
    const d = new Date(ev.start * 1000);
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
    const name = `${ev.label || 'clip'}-${stamp}.mp4`.replace(/[^\w.-]+/g, '_');
    const a = document.createElement('a');
    a.href = `/history/clip/${ev.id}.mp4`;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    flashMessage('Downloading video…');
}

function closeHistoryPlayer() {
    historyPlayingId = null;
    historyStreaming = false;
    stopFramePlayback();
    document.getElementById('history-download').classList.add('hidden');
    const video = document.getElementById('history-video');
    video.onplaying = null;
    video.onwaiting = null;
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

// ----------------------------------------------------------------------------
// Recordings Data Saver - play a past event as a low-fps JPEG slideshow instead
// of video. The clip still downloads to the server (hub→server hop), but the
// phone only pulls small JPEGs, so events are watchable on metered WiFi or a
// network that blocks video streaming (same idea as the live Data Saver view,
// and it honours the same FRAME_* settings).
function initHistoryDataSaver() {
    try { historyDataSaver = localStorage.getItem('histDataSaver') === '1'; } catch (e) {}
    updateDataSaverButton();
}

function updateDataSaverButton() {
    const btn = document.getElementById('history-ds');
    if (btn) btn.classList.toggle('on', historyDataSaver);
}

function toggleHistoryDataSaver() {
    historyDataSaver = !historyDataSaver;
    try { localStorage.setItem('histDataSaver', historyDataSaver ? '1' : '0'); } catch (e) {}
    updateDataSaverButton();
    flashMessage(historyDataSaver ? 'Data Saver on - events play as frames' : 'Data Saver off');
    // If a clip is open, re-open it in the newly chosen mode.
    if (historyPlayingId) {
        const id = historyPlayingId;
        stopFramePlayback();
        openHistoryClip(id);
    }
}

function showFrameControls(show) {
    const el = document.getElementById('history-frame-controls');
    if (el) el.classList.toggle('hidden', !show);
}

// Clip is cached on the server → ask it to extract frames, then play them.
async function startFramePlayback(id) {
    if (historyPlayingId !== id) return;
    setHistoryStatus('Preparing data saver frames…');
    let r;
    try {
        r = await fetch(`/history/frames/${encodeURIComponent(id)}.json`).then(x => x.json());
    } catch (e) { setHistoryStatus('Couldn’t prepare Data Saver frames'); return; }
    if (historyPlayingId !== id) return;
    if (!r || !r.ready || !r.count) { setHistoryStatus(r && r.error ? `Data Saver failed: ${r.error}` : 'No frames available for this clip'); return; }
    setHistoryStatus('');
    framePlay = { id, count: r.count, fps: Number(r.fps) || 2, idx: 1, playing: true, timer: null };
    const scrub = document.getElementById('history-frame-scrub');
    if (scrub) { scrub.max = String(r.count); scrub.value = '1'; }
    const img = document.getElementById('history-image');
    img.classList.remove('hidden');
    showFrameControls(true);
    showFrame(1);
    updateFramePlayButton();
    scheduleFrameTick();
}

function showFrame(n) {
    if (!framePlay) return;
    framePlay.idx = n;
    const img = document.getElementById('history-image');
    if (img) img.src = `/history/frame/${encodeURIComponent(framePlay.id)}/${n}.jpg`;
    const scrub = document.getElementById('history-frame-scrub');
    if (scrub && Number(scrub.value) !== n) scrub.value = String(n);
    const t = document.getElementById('history-frame-time');
    if (t) t.textContent = `${n} / ${framePlay.count}`;
}

function scheduleFrameTick() {
    if (!framePlay) return;
    clearTimeout(framePlay.timer);
    if (!framePlay.playing) return;
    framePlay.timer = setTimeout(() => {
        if (!framePlay || !framePlay.playing) return;
        const next = framePlay.idx >= framePlay.count ? 1 : framePlay.idx + 1;   // loop
        showFrame(next);
        scheduleFrameTick();
    }, 1000 / framePlay.fps);
}

function setFramePlaying(playing) {
    if (!framePlay) return;
    framePlay.playing = playing;
    updateFramePlayButton();
    if (playing) scheduleFrameTick(); else clearTimeout(framePlay.timer);
}

function toggleFramePlayback() {
    if (framePlay) setFramePlaying(!framePlay.playing);
}

function updateFramePlayButton() {
    const btn = document.getElementById('history-frame-play');
    if (btn && framePlay) btn.innerHTML = framePlay.playing ? '&#9208;' : '&#9654;';  // pause : play
}

function frameSeek(n) {
    if (!framePlay) return;
    setFramePlaying(false);   // scrubbing pauses
    showFrame(Math.min(framePlay.count, Math.max(1, n)));
}

function stopFramePlayback() {
    if (framePlay) { clearTimeout(framePlay.timer); framePlay = null; }
    showFrameControls(false);
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
