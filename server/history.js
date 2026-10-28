/**
 * History Module
 *
 * Recorded-event browser, like the official app's event list:
 * - lists recorded events from the Eufy cloud index (covers HomeBase-local and
 *   on-camera SD recordings), filtered to the cameras the viewer may see
 * - serves event thumbnails (fetched + decrypted through the library)
 * - downloads a clip over P2P (the same channel as live view), muxes it with
 *   FFmpeg into a normal MP4 under data/clips, and serves it with Range support
 *
 * Only one download runs at a time (it shares the station's P2P session).
 * Requested clip ids are resolved against the server's own record cache, so a
 * client can never point the station at an arbitrary storage path.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { VideoCodec, AudioCodec, DeviceType, StorageType } = require('eufy-security-client');

const utils = require('./utils');
const auth = require('./auth');
const eventLog = require('./events');
const { fixV2Thumbnail } = require('./v2thumb');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const CLIP_DIR = path.join(utils.dataDir, 'clips');
const MAX_CACHED_CLIPS = 40;               // oldest clips beyond this are deleted
const PAGE_DAYS = 7;                       // recent window queried first = one week
const TARGET_EVENT_DAYS = 7;               // a "page" = the 7 most recent days that have events
const WALK_LOOKBACK_DAYS = 365;            // how far one walk-back batch reaches for a sparse camera
const MAX_EVENTS = 300;
const START_TIMEOUT_MS = 25000;            // station must start sending within this
const DOWNLOAD_TIMEOUT_MS = 4 * 60000;     // whole download must finish within this
const THUMB_CACHE_MAX = 200;
const EVENT_MATCH_S = 90;               // detection ↔ recording same-event window
const CACHE_FILE = path.join(utils.dataDir, 'history-cache.json');
const COVERAGE_OVERLAP_MS = 60 * 60000; // re-query this far before the last-known newest (hub indexing lag / clock skew)
const MAX_CACHE_RECORDS = Number(process.env.HISTORY_MAX_RECORDS) || 60000;  // cap the persisted event cache (metadata only, ~300 B/event → ~18 MB full)

let getClient = () => null;                // () => EufySecurity instance (set by init)
let isStationBusy = () => false;           // (stationSN) => live view running on it
let broadcast = () => {};                  // (msg) => push a WS message to open clients

const records = new Map();                 // clip id -> normalized event (incl. path/cipher)
const thumbCache = new Map();              // clip id -> Buffer (insertion-ordered LRU)
let active = null;                         // current download (see startDownload)
let loggedSample = false;

// Persistent incremental cache: which time range each station (and the cloud index) has
// already been queried, so a re-open only fetches the gap from the last check to now and
// serves everything older from `records`. Survives restarts.
const coverage = new Map();                // stationSN -> { newest: ms, oldest: ms }
let cloudCoverage = null;                  // { newest, oldest } for the cloud index
const deviceNames = new Map();             // device sn -> name (to build from cache w/o a device query)
let cacheSaveTimer = null;

function init(opts) {
    getClient = opts.getClient;
    isStationBusy = opts.isStationBusy || isStationBusy;
    broadcast = opts.broadcast || broadcast;
    try { fs.mkdirSync(CLIP_DIR, { recursive: true }); } catch (e) { /* exists */ }
    loadCache();
    if (BACKFILL_ENABLED) {
        scheduleBackfill(BACKFILL_START_DELAY_MS);
        startTipPoll();
    }
}

// ---- Persistent event cache -------------------------------------------------
function loadCache() {
    try {
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        for (const [id, rec] of Object.entries(raw.records || {})) records.set(id, rec);
        for (const [sn, cov] of Object.entries(raw.coverage || {})) coverage.set(sn, cov);
        for (const [sn, n] of Object.entries(raw.deviceNames || {})) deviceNames.set(sn, n);
        cloudCoverage = raw.cloudCoverage || null;
        utils.log(`🗂️ History cache loaded: ${records.size} events, ${coverage.size} station(s)`, 'info');
    } catch (e) { /* no cache yet */ }
}

function scheduleSaveCache() {
    if (cacheSaveTimer) return;
    cacheSaveTimer = setTimeout(() => { cacheSaveTimer = null; saveCache(); }, 1500);
    if (cacheSaveTimer.unref) cacheSaveTimer.unref();
}

function saveCache() {
    try {
        // Keep the newest MAX_CACHE_RECORDS by start time.
        let entries = [...records.entries()];
        if (entries.length > MAX_CACHE_RECORDS) {
            entries.sort((a, b) => (b[1].start_time || 0) - (a[1].start_time || 0));
            const keep = new Set(entries.slice(0, MAX_CACHE_RECORDS).map(e => e[0]));
            for (const id of records.keys()) if (!keep.has(id)) records.delete(id);
            entries = [...records.entries()];
        }
        const out = {
            records: Object.fromEntries(entries),
            coverage: Object.fromEntries(coverage),
            cloudCoverage,
            deviceNames: Object.fromEntries(deviceNames),
        };
        const tmp = CACHE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(out));
        fs.renameSync(tmp, CACHE_FILE);
    } catch (e) { utils.log(`🗂️ History cache save failed: ${e.message}`, 'warn'); }
}

// Stable, filename-safe id per recording: camera serial + start time
function clipId(rec) {
    return `${String(rec.device_sn).replace(/[^A-Za-z0-9]/g, '')}_${rec.start_time}`;
}

function serialFromId(id) {
    return String(id).split('_')[0];
}

function isValidId(id) {
    return /^[A-Za-z0-9]+_[0-9]+$/.test(String(id));
}

function clipPath(id) {
    return path.join(CLIP_DIR, `${id}.mp4`);
}

// ---- Local (on-HomeBase / on-SD) event index over P2P ----
// HomeBase-stored recordings are NOT in the cloud index - the official app
// lists them by asking the station directly (CMD_DATABASE_QUERY_BY_DATE).
// The station answers with one "station database query by date" event; we
// match it to the pending request by station serial.
// Remote hubs (e.g. a HomeBase at another house, reached only over the
// ThroughTek relay) answer much slower than a hub on the same LAN, so give the
// query a generous window. We also establish the P2P session *before* starting
// this clock (see ensureStationConnected), so this is the answer time, not the
// connect time.
const DB_QUERY_TIMEOUT_MS = Number(process.env.DB_QUERY_TIMEOUT_MS) || 12000;  // local hubs (S380/HB2/Chime) reply in <1s; generous for a slow remote-relayed hub
const CONNECT_WAIT_MS = 20000;             // how long to wait for a station's P2P session before querying
const DB_QUERY_LIMIT = 100;                // the station returns at most this many per query
const LOCAL_PRIME_RETRY_MS = Number(process.env.LOCAL_PRIME_RETRY_MS) || 900;  // HB2/Chime QUERY_LOCAL can answer empty until primed; wait this long then retry once
// The S380/HB3 only answers one day at a time, so its walk-back is a per-day scan.
// To bound latency we stop a single walk-back once it has a full page of older
// event-days, or after scanning this many days (a camera with a long blank gap),
// or after a run of empty days once some events have been found.
const HB3_WALK_MAX_DAYS = Number(process.env.HB3_WALK_MAX_DAYS) || 60;
const HB3_WALK_EMPTY_RUN = Number(process.env.HB3_WALK_EMPTY_RUN) || 45;
const dbWaiters = new Map();               // stationSN -> { resolve, timer }

// ---- Background history backfill --------------------------------------------
// After startup, walk every station's recordings back to a horizon so the event
// cache is deep enough for a date picker, pre-populated filters, and instant
// "Load older". Runs ONE small chunk per cycle (one station's chunk + one cloud
// chunk), yields between cycles so it never hogs the P2P session, checkpoints
// coverage after each chunk (so it resumes across restarts rather than restarting),
// and defers any station that's in its dead-hub cooldown or busy with live view.
const BACKFILL_ENABLED = process.env.HISTORY_BACKFILL !== '0';
const BACKFILL_HORIZON_DAYS = Number(process.env.HISTORY_BACKFILL_DAYS) || 365;
const BACKFILL_CHUNK_DAYS = Number(process.env.HISTORY_BACKFILL_CHUNK_DAYS) || 7;   // station per-day walk per cycle
const BACKFILL_CLOUD_CHUNK_DAYS = 30;      // cloud is a single range query - bigger chunks
const BACKFILL_START_DELAY_MS = 45000;     // let the app settle after boot before starting
const BACKFILL_CYCLE_MS = 2500;            // gap between chunks that did work (gentle on P2P)
const BACKFILL_RETRY_MS = 90000;           // nothing done (not connected / all in cooldown) → wait longer
const BACKFILL_MAX_FAILS = 6;              // give up on a station after this many failed attempts this run
const BACKFILL_USER_IDLE_MS = 20000;       // pause backfill while the viewer is actively using Recordings
let lastUserActivity = 0;                  // ms of the last user-initiated history request (list/coverage/thumb)
let backfillTimer = null;
let backfilling = false;
const backfillDone = new Set();            // stations (+ '__cloud__') that reached the horizon / are unsupported / given up
const backfillFails = new Map();           // stationSN -> consecutive failed backfill attempts

// Bring up the station's P2P session (connecting is often the slow part for a
// remote hub). Returns true once connected, false if it never came up in time.
async function ensureStationConnected(station, label) {
    if (station.isConnected()) return true;
    const t0 = Date.now();
    try { Promise.resolve(station.connect()).catch(() => {}); }
    catch (e) { utils.log(`🎞️ connect() threw for ${label}: ${e.message}`, 'warn'); }
    while (Date.now() - t0 < CONNECT_WAIT_MS) {
        if (station.isConnected()) {
            utils.log(`🎞️ P2P to ${label} up in ${Date.now() - t0}ms; querying recordings`, 'debug');
            return true;
        }
        await new Promise(r => setTimeout(r, 400));
    }
    utils.log(`🎞️ Could not establish P2P to ${label} within ${CONNECT_WAIT_MS / 1000}s (remote/asleep hub?)`, 'warn');
    return false;
}

function onDatabaseQueryByDate(station, returnCode, data) {
    const w = dbWaiters.get(station.getSerial());
    if (!w) return;
    clearTimeout(w.timer);
    dbWaiters.delete(station.getSerial());
    w.resolve(Array.isArray(data) ? data : []);
}

// CMD_DATABASE_QUERY_LOCAL response (HomeBase 2 / Chime). Records come nested
// under `.history`; flatten to the same flat shape queryStationRange/fromLocalRow use.
function onDatabaseQueryLocal(station, returnCode, data) {
    const w = dbWaiters.get(station.getSerial());
    if (!w) return;
    clearTimeout(w.timer);
    dbWaiters.delete(station.getSerial());
    const rows = (Array.isArray(data) ? data : []).map(r => {
        const h = r.history || {};
        return {
            device_sn: r.device_sn,
            station_sn: r.station_sn,
            record_id: r.record_id,
            start_time: h.start_time,
            end_time: h.end_time,
            storage_path: h.storage_path,
            thumb_path: h.thumb_path,
            cipher_id: h.cipher_id,
            frame_num: h.frame_num,
            trigger_type: h.trigger_type,
            video_type: h.video_type,
            folder_size: h.folder_size,
            storage_type: h.storage_type,
        };
    }).filter(r => r.device_sn && r.start_time);
    w.resolve(rows);
}

function queryStation(station, serials, start, end, useLocal) {
    return new Promise((resolve) => {
        const sn = station.getSerial();
        const t0 = Date.now();
        const day = start.toISOString().slice(0, 10);
        if (dbWaiters.has(sn)) { clearTimeout(dbWaiters.get(sn).timer); dbWaiters.get(sn).resolve([]); }
        const wrappedResolve = (rows) => {
            const ms = Date.now() - t0;
            if (rows && rows.timedOut) utils.log(`📼 ${sn} no DB answer after ${ms}ms (${day})`, 'warn');
            else utils.log(`📼 ${sn} answered ${rows.length} row(s) in ${ms}ms (${day})`, 'debug');
            resolve(rows);
        };
        const timer = setTimeout(() => {
            dbWaiters.delete(sn);
            const none = []; none.timedOut = true;      // distinguishes "no answer" from "no clips"
            wrappedResolve(none);
        }, DB_QUERY_TIMEOUT_MS);
        dbWaiters.set(sn, { resolve: wrappedResolve, timer });
        utils.log(`📼 DB ${useLocal ? 'QUERY_LOCAL' : 'query'} → ${sn} for ${day} (${serials.length} cam, ${DB_QUERY_TIMEOUT_MS / 1000}s window)`, 'debug');
        try {
            if (useLocal) station.databaseQueryLocal(serials, start, end);
            else station.databaseQueryByDate(serials, start, end);
        } catch (e) {
            clearTimeout(timer); dbWaiters.delete(sn);
            utils.log(`🎞️ Local event query failed on ${sn}: ${e.message}`, 'warn');
            resolve([]);
        }
    });
}

// Query one station for a date range. The station treats end_date as
// EXCLUSIVE (start_date == end_date returns nothing), so ask for [start, end+1d).
// If a request hits the per-request cap, split it into single days
// ([d, d+1)), and a still-full day camera by camera.
const nextDay = d => { const n = new Date(d); n.setDate(n.getDate() + 1); return n; };

// One pass over a date range for a station. HomeBase 3 / S380 only answers one
// day per whole-range QUERY_BY_DATE, and HomeBase 2 / Chime QUERY_LOCAL is
// capped per query - both must be walked day by day. (Only a hypothetical
// non-HB3 non-local hub would range-query.)
async function sweepStationRange(station, serials, start, end, useLocal, allowWide = false) {
    const out = [];
    out.timeouts = 0;
    out.coveredFrom = start.getTime();      // oldest ms actually queried (for coverage)
    const isHb3 = station.getDeviceType() === DeviceType.HB3;

    // The S380/HB3 only answers one day at a time - a whole-range query returns an
    // incomplete, inconsistent subset - so it must ALWAYS walk per-day, including
    // during the sparse-camera walk-back. Other (local) hubs may try one whole-range
    // query first and split to per-day only if it hits the row cap.
    const perDayOnly = isHb3 || (useLocal && !allowWide);
    if (!perDayOnly) {
        const rows = await queryStation(station, serials, start, nextDay(end), useLocal);
        if (rows && rows.timedOut) out.timeouts++;
        if (rows && rows.length < DB_QUERY_LIMIT) {
            out.push(...rows);
            return out;                     // whole range answered under the cap → complete
        }
        if (rows) out.push(...rows);        // cap hit → fall through and re-walk per-day
    }

    // Per-day backward scan. During a wide walk-back we stop as soon as we have a
    // full page of older event-days (so a daily camera doesn't scan a whole year),
    // and record how far back we actually reached so coverage isn't marked deeper
    // than we queried.
    const earlyStop = isHb3 && allowWide;
    const day0 = new Date(start); day0.setHours(0, 0, 0, 0);
    const eventDays = new Set();
    let emptyRun = 0, scanned = 0;
    for (let d = new Date(end); d >= day0; d.setDate(d.getDate() - 1)) {
        const day = new Date(d); day.setHours(0, 0, 0, 0);
        let dayRows = await queryStation(station, serials, day, nextDay(day), useLocal);
        if (dayRows.timedOut) out.timeouts++;
        if (dayRows.length >= DB_QUERY_LIMIT && serials.length > 1) {
            dayRows = [];
            for (const sn of serials) dayRows.push(...await queryStation(station, [sn], day, nextDay(day), useLocal));
        }
        out.push(...dayRows);
        out.coveredFrom = day.getTime();
        scanned++;
        if (dayRows.length) { eventDays.add(day.getTime()); emptyRun = 0; } else { emptyRun++; }
        if (earlyStop) {
            if (eventDays.size >= TARGET_EVENT_DAYS) break;                       // a full page of older days
            if (scanned >= HB3_WALK_MAX_DAYS) break;                             // latency cap (long blank camera)
            if (eventDays.size > 0 && emptyRun >= HB3_WALK_EMPTY_RUN) break;     // trailing blank run
        }
    }
    return out;
}

// Query one station for a date range. HomeBase 2 / Chime (QUERY_LOCAL) can come
// up in a cold state right after the P2P session (re)connects, where the hub
// answers "SUCCESSFUL" with an empty record set until the first successful
// query primes its local DB. So for local hubs, if the whole sweep comes back
// empty with no timeouts, prime-and-retry once before trusting the empty.
async function queryStationRange(station, serials, start, end, useLocal, allowWide = false) {
    let out = await sweepStationRange(station, serials, start, end, useLocal, allowWide);
    if (useLocal && out.length === 0 && out.timeouts === 0) {
        await new Promise(r => setTimeout(r, LOCAL_PRIME_RETRY_MS));
        const retry = await sweepStationRange(station, serials, start, end, useLocal, allowWide);
        if (retry.length > 0 || retry.timeouts > 0) out = retry;
    }
    const inRange = out.filter(r => {
        const t = new Date(r.start_time).getTime();
        return t >= start.getTime() && t <= end.getTime();
    });
    inRange.timeouts = out.timeouts;
    inRange.coveredFrom = out.coveredFrom;      // how far back the scan actually reached
    return inRange;
}

// Normalize a station DB row to the cloud record shape used everywhere else
// HomeBase 2 / Chime local recordings report a cipher_id with a storage-type
// flag OR'd into the high bits (e.g. 0x08000012 = 134217746 → real id 0x12 = 18).
// The cloud get_ciphers endpoint only knows the low id, and the camera library
// passes the flagged value straight through (returning no cipher → the download
// crashes on Object.keys(undefined)). Mask the flag off to get the cloud id.
// Cloud/HB3 ids are already small, so masking is a no-op for them.
function cloudCipherId(cipherId) {
    return (typeof cipherId === 'number' && cipherId > 0) ? (cipherId & 0x00FFFFFF) : cipherId;
}

function fromLocalRow(row, deviceName) {
    const toSec = d => Math.floor(new Date(d).getTime() / 1000);
    return {
        device_sn: row.device_sn,
        station_sn: row.station_sn,
        device_name: deviceName,
        start_time: toSec(row.start_time),
        end_time: toSec(row.end_time),
        storage_path: row.storage_path,
        thumb_path: row.thumb_path,
        cipher_id: row.cipher_id,
        frame_num: row.frame_num,
        trigger_type: row.trigger_type,
        video_type: row.video_type,
        local: true
    };
}

// Event label: station trigger/video type bits first, cloud AI fields second
function labelFor(rec) {
    const trig = rec.trigger_type || 0;
    const vt = rec.video_type || 0;
    if (trig & 128 || vt === 524288) return 'Answered ring';     // ANSWER_RING / RECEIVED_RING_ACK
    if (trig & 64 || vt === 1001 || vt === 1048576) return 'Missed ring';
    if (trig & 8 || vt === 1000) return 'Ring';
    if (vt === 65536) return 'Package delivered';
    if (vt === 131072) return 'Package taken';
    if (Array.isArray(rec.ai_faces) && rec.ai_faces.some(f => f && f.is_stranger)) return 'Stranger';
    if (Array.isArray(rec.ai_faces) && rec.ai_faces.length) return 'Familiar face';
    // Person only on a real person signal (video_type PERSON or a human flag).
    // NOT on `trigger_type & 4` alone: the S380/HB3 reports trigger_type=4 with a
    // generic video_type=1 on EVERY recording (no per-clip AI classification), so
    // bit 4 is not a person signal there - those are just generic motion events.
    if (vt === 1003 || rec.has_human) return 'Person';
    if (vt === 1004) return 'Pet';
    if (vt === 1005) return 'Crying';
    if (vt === 1006) return 'Sound';
    return 'Motion';
}

// Map an event label to a filter category (mirrors the client's historyCategory
// so a chip selection resolves to the same buckets on both sides).
function categoryFor(label) {
    const l = String(label || '').toLowerCase();
    if (l.includes('person') || l.includes('stranger') || l.includes('face')) return 'person';
    if (l.includes('pet')) return 'pet';
    if (l.includes('vehicle')) return 'vehicle';
    if (l.includes('ring')) return 'ring';
    if (l.includes('package')) return 'package';
    if (l.includes('sound') || l.includes('crying')) return 'sound';
    return 'motion';
}

// Hubs that repeatedly don't answer are skipped for a while, so one asleep or
// unreachable hub doesn't add a long wait to every page of the list. We only
// skip after a couple of consecutive misses (a single slow/relayed answer
// shouldn't hide a remote hub's recordings), and the cooldown is short enough
// that a manual refresh soon after retries.
const SILENT_SKIP_MS = 3 * 60000;
const FAIL_BEFORE_SKIP = 2;
const failCount = new Map();               // stationSN -> consecutive timeout count
const silentUntil = new Map();             // stationSN -> epoch ms (skip until)

function noteStationTimeout(stSN, label) {
    const n = (failCount.get(stSN) || 0) + 1;
    failCount.set(stSN, n);
    if (n >= FAIL_BEFORE_SKIP) {
        silentUntil.set(stSN, Date.now() + SILENT_SKIP_MS);
        utils.log(`🎞️ ${label} not responding (${n} tries) - skipping its recordings for ${Math.round(SILENT_SKIP_MS / 60000)}m`, 'warn');
    } else {
        utils.log(`🎞️ ${label} did not answer recordings query in time (try ${n}/${FAIL_BEFORE_SKIP})`, 'warn');
    }
}

/**
 * List Events - a "page" of the 7 most recent days that actually have events.
 *
 * Incremental + cached: each station (and the cloud index) remembers the time range it has
 * already been queried (`coverage`, persisted to disk). A call only fetches the GAP from the
 * last check to now and serves everything older from the `records` cache - so re-opening the
 * list doesn't re-query the whole window. For a camera that records rarely, when the recent
 * window has fewer than 7 event-days we extend coverage back once over a wide range.
 *
 * @param {Object} scope - viewer's camera scope (null = unrestricted)
 * @param {Object} opts - { serialNumber?, before? (epoch ms) }
 * @returns {Promise<{events: Array, before: number, after: number, sources: Array}>}
 */
async function listEvents(scope, opts = {}) {
    lastUserActivity = Date.now();
    const client = getClient();
    if (!client || !client.isConnected()) throw new Error('Not connected to Eufy');
    const now = Date.now();
    const end = opts.before ? Number(opts.before) : now;
    const recentStart = end - PAGE_DAYS * 86400000;
    const paging = !!opts.before;   // a "Load older" tap, vs. the initial open
    const dayKey = t => new Date(t * 1000).toISOString().slice(0, 10);
    const distinctDays = evs => new Set(evs.map(e => dayKey(e.start))).size;
    const wideStart = end - WALK_LOOKBACK_DAYS * 86400000;

    let sources = [];
    let events;

    if (paging) {
        // "Load older": the user is explicitly reaching further back - possibly
        // past what the backfill has cached yet - so fill the requested gap on
        // demand (a brief, expected wait shown on the button), then build. Only
        // the uncovered gap is queried; an already-backfilled range re-queries
        // nothing.
        sources = await ensureRange(scope, opts, recentStart, end, false);
        events = buildEvents(scope, opts, recentStart, end);
        if (distinctDays(events) < TARGET_EVENT_DAYS || opts.category) {
            if (wideStart < recentStart) {
                sources.push(...await ensureRange(scope, opts, wideStart, recentStart, true));
                events = buildEvents(scope, opts, wideStart, end);
            }
        }
    } else {
        // Initial open: serve straight from the cache - no blocking network. The
        // leading edge is kept current in the background (detection-driven
        // tip-freshen + a low-rate safety poll) and the backfill keeps the history
        // deep, so the cache IS the answer. This is what makes the all-cameras
        // list open as fast as a single camera's drill-down instead of waiting on
        // every hub's P2P session.
        events = buildEvents(scope, opts, recentStart, end);
        if (distinctDays(events) < TARGET_EVENT_DAYS || opts.category) {
            if (wideStart < recentStart) events = buildEvents(scope, opts, wideStart, end);
        }
        // Cold-cache bootstrap: a brand-new install (before the backfill has run)
        // would otherwise show an empty page. Only then do we pay for one blocking
        // fetch; a warm cache never hits this.
        if (!events.length && coverage.size === 0 && !cloudCoverage) {
            sources = await ensureRange(scope, opts, recentStart, end, false);
            events = buildEvents(scope, opts, recentStart, end);
            if ((distinctDays(events) < TARGET_EVENT_DAYS || opts.category) && wideStart < recentStart) {
                sources.push(...await ensureRange(scope, opts, wideStart, recentStart, true));
                events = buildEvents(scope, opts, wideStart, end);
            }
        } else {
            // Warm cache: report (network-free) which visible hubs we're currently
            // cooling down on, so the client can still show a "not responding"
            // hint. We deliberately do NOT fire a freshen here - that would fight
            // this open's own thumbnail loads for the hub's P2P session. The tip is
            // already kept current by the detection-driven freshen + safety poll.
            sources = await cacheSources(scope, opts);
        }
    }

    // Trim to the TARGET most recent event-days.
    const days = [];
    for (const e of events) { const d = dayKey(e.start); if (!days.includes(d)) days.push(d); }
    if (days.length > TARGET_EVENT_DAYS) {
        const keep = new Set(days.slice(0, TARGET_EVENT_DAYS));
        events = events.filter(e => keep.has(dayKey(e.start)));
    }

    // `after` is the cursor the next "Load older" resumes from. Anchor it to the
    // OLDEST event actually shown - never the (possibly year-wide) window start, or
    // paging would leap back a blank year at a time. When nothing was found even
    // across the wide look-back, there's nothing older: return null so the client
    // stops offering "Load older".
    const after = events.length ? events[events.length - 1].start * 1000 - 1 : null;
    scheduleSaveCache();
    return { events, before: end, after, sources, category: opts.category || null };
}

// Build the event list from the cached `records` (+ EufyView's detection log) for a time
// range, applying the viewer's scope/camera filter. No network - a pure cache read.
function buildEvents(scope, opts, fromMs, toMs) {
    const allowed = sn => (!opts.serialNumber || sn === opts.serialNumber) && (!scope || auth.isCameraAllowed(scope, sn));
    const cat = opts.category && opts.category !== 'all' ? opts.category : null;
    const events = [];
    for (const [id, rec] of records) {
        if (!rec || !rec.device_sn || !rec.start_time || !allowed(rec.device_sn)) continue;
        const startMs = rec.start_time * 1000;
        if (startMs < fromMs || startMs > toMs) continue;
        const label = labelFor(rec);
        if (cat && categoryFor(label) !== cat) continue;
        events.push({
            id,
            serialNumber: rec.device_sn,
            deviceName: rec.device_name || deviceNames.get(rec.device_sn) || rec.device_sn,
            start: rec.start_time,
            end: rec.end_time,
            label,
            hasThumb: !!rec.thumb_path,
            canPlay: !!(rec.storage_path || rec.hevc_storage_path),
            cached: fs.existsSync(clipPath(id)),
        });
    }
    const logged = eventLog.list(scope, { serialNumber: opts.serialNumber, start: fromMs, end: toMs });
    for (const ev of logged) {
        if (cat && categoryFor(ev.label) !== cat) continue;
        const t = Math.floor(ev.time / 1000);
        const snap = ev.snap ? `/history/snap/${ev.id}.jpg?g=3` : null;
        const match = events.find(r => r.serialNumber === ev.serialNumber && Math.abs(r.start - t) <= EVENT_MATCH_S);
        if (match) { if (snap && !match.snap) match.snap = snap; continue; }
        events.push({
            id: ev.id, serialNumber: ev.serialNumber,
            deviceName: deviceNames.get(ev.serialNumber) || ev.cameraName,
            start: t, end: 0, label: ev.label, event: ev.event, snap,
            hasThumb: false, canPlay: false, cached: false,
        });
    }
    events.sort((a, b) => b.start - a.start);
    return events;
}

// Ensure every in-scope station (and the cloud index) has queried [fromMs, toMs], fetching
// only the uncovered gap(s) and merging results into `records`. Returns per-source status.
async function ensureRange(scope, opts, fromMs, toMs, allowWide) {
    const client = getClient();
    const allowed = sn => (!opts.serialNumber || sn === opts.serialNumber) && (!scope || auth.isCameraAllowed(scope, sn));
    const deviceList = Object.values(await client.getDevices());
    const names = {};
    const byStation = new Map();
    for (const d of deviceList) {
        names[d.getSerial()] = d.getName();
        deviceNames.set(d.getSerial(), d.getName());
        const st = d.getStationSerial();
        if (!byStation.has(st)) byStation.set(st, []);
        byStation.get(st).push(d);
    }
    const sources = [];
    const jobs = [];
    for (const [stSN, devs] of byStation) {
        if (!devs.some(d => allowed(d.getSerial()))) continue;   // station hosts no visible camera
        jobs.push(ensureStation(client, stSN, devs, fromMs, toMs, allowWide, names, sources));
    }
    jobs.push(ensureCloud(client, fromMs, toMs, sources));
    await Promise.all(jobs);
    return sources;
}

// Ensure one station's cache covers [fromMs, toMs]; query only the top/bottom gap(s).
async function ensureStation(client, stSN, devs, fromMs, toMs, allowWide, names, sources) {
    const status = { station: names[stSN] || stSN, cameras: devs.map(d => d.getName()), rows: 0 };
    sources.push(status);
    try {
        const station = await client.getStation(stSN);
        const cov = coverage.get(stSN);
        if (!cov) {
            const r = await fetchStation(station, stSN, devs, fromMs, toMs, allowWide, names, status);
            if (r.ok) coverage.set(stSN, { newest: toMs, oldest: r.coveredFrom });
        } else {
            if (toMs > cov.newest) {
                const r = await fetchStation(station, stSN, devs, cov.newest - COVERAGE_OVERLAP_MS, toMs, allowWide, names, status);
                if (r.ok) cov.newest = toMs;
            }
            if (fromMs < cov.oldest) {
                const r = await fetchStation(station, stSN, devs, fromMs, cov.oldest, allowWide, names, status);
                if (r.ok) cov.oldest = r.coveredFrom;
            }
        }
    } catch (e) { status.error = e.message; utils.log(`\u{1F3DE}️ Local event query error (${stSN}): ${e.message}`, 'warn'); }
}

// Query one station for [fromMs, toMs] and merge rows into `records`. Returns
// { ok, coveredFrom }: ok is true only if the station answered (so the range can be
// marked covered), and coveredFrom is the oldest ms actually queried - which, for an
// S380 walk-back that stops early, can be newer than fromMs so the next "Load older"
// resumes from there instead of skipping the un-scanned gap.
async function fetchStation(station, stSN, devs, fromMs, toMs, allowWide, names, status) {
    const useLocal = station.getDeviceType() !== DeviceType.HB3;
    const cmdName = useLocal ? 'stationDatabaseQueryLocal' : 'stationDatabaseQueryByDate';
    if (!station.hasCommand(cmdName)) { status.unsupported = true; return { ok: false }; }
    const cooldown = (silentUntil.get(stSN) || 0) - Date.now();
    if (cooldown > 0) { status.timeouts = 1; status.skipped = true; return { ok: false }; }
    if (!await ensureStationConnected(station, status.station)) { status.timeouts = 1; noteStationTimeout(stSN, status.station); return { ok: false }; }
    const rows = await queryStationRange(station, devs.map(d => d.getSerial()), new Date(fromMs), new Date(toMs), useLocal, allowWide);
    if (rows.timeouts) { status.timeouts = rows.timeouts; noteStationTimeout(stSN, status.station); }
    else { failCount.delete(stSN); }
    status.rows += rows.length;
    for (const r of rows) {
        if (!r || !r.device_sn || !r.start_time) continue;
        const rec = fromLocalRow(r, names[r.device_sn]);
        records.set(clipId(rec), rec);
        if (rec.device_name) deviceNames.set(rec.device_sn, rec.device_name);
    }
    utils.log(`\u{1F4FC} ${status.station}: ${rows.length} recording(s) [${new Date(fromMs).toISOString().slice(0, 10)}..${new Date(toMs).toISOString().slice(0, 10)}]${rows.timeouts ? ' (partial)' : ''}`, 'info');
    return { ok: !rows.timeouts, coveredFrom: rows.coveredFrom != null ? rows.coveredFrom : fromMs };
}

// Cloud index (queried for all cameras; filtered on build). Same gap-only coverage.
async function ensureCloud(client, fromMs, toMs, sources) {
    const status = { station: 'cloud', rows: 0 };
    sources.push(status);
    try {
        if (!cloudCoverage) {
            if (await fetchCloud(client, fromMs, toMs, status)) cloudCoverage = { newest: toMs, oldest: fromMs };
        } else {
            if (toMs > cloudCoverage.newest) { if (await fetchCloud(client, cloudCoverage.newest - COVERAGE_OVERLAP_MS, toMs, status)) cloudCoverage.newest = toMs; }
            if (fromMs < cloudCoverage.oldest) { if (await fetchCloud(client, fromMs, cloudCoverage.oldest, status)) cloudCoverage.oldest = fromMs; }
        }
    } catch (e) { status.error = e.message; }
}

async function fetchCloud(client, fromMs, toMs, status) {
    const api = client.getApi();
    const filter = { deviceSN: '', storageType: StorageType.LOCAL_AND_CLOUD };
    const start = new Date(fromMs), end = new Date(toMs);
    const call = fn => fn.call(api, start, end, filter, MAX_EVENTS).then(r => r || []).catch(e => { utils.log(`\u{1F39E}️ Cloud query error: ${e.message}`, 'warn'); return null; });
    const parts = await Promise.all([call(api.getVideoEvents), call(api.getHistoryEvents), call(api.getAlarmEvents)]);
    if (parts.some(p => p === null)) return false;   // an endpoint errored - don't mark covered
    const rows = parts.flat();
    status.rows += rows.length;
    for (const rec of rows) {
        if (!rec || !rec.device_sn || !rec.start_time) continue;
        const id = clipId(rec);
        const existing = records.get(id);
        if (existing && existing.local) continue;    // keep the local row (has a playable path)
        records.set(id, rec);
        if (rec.device_name) deviceNames.set(rec.device_sn, rec.device_name);
    }
    return true;
}

// ---- Background backfill ----------------------------------------------------

// Mark that the user is interacting (any P2P-contending action: Recordings
// list/thumbs/clips, or live view). The background backfill checks this and holds
// off while it's recent, so foreground actions always win the station's P2P
// session, then the backfill resumes once things go idle.
function noteActivity() { lastUserActivity = Date.now(); }

// Kick off (or reschedule) a backfill cycle. Guarded so there's never more than
// one pending timer / in-flight pass.
function scheduleBackfill(delay = BACKFILL_CYCLE_MS) {
    if (!BACKFILL_ENABLED || backfillTimer || backfilling) return;
    backfillTimer = setTimeout(() => { backfillTimer = null; runBackfill(); }, delay);
    if (backfillTimer.unref) backfillTimer.unref();
}

// One pass: advance the oldest-covered edge of at most one station by a chunk and
// deepen the cloud index by a chunk, then reschedule. Repeats until every source
// has reached the horizon. Reuses fetchStation (per-day walk, no early-stop since
// allowWide=false) + fetchCloud, and the same coverage checkpointing as listEvents.
async function runBackfill() {
    if (backfilling) return;
    // Yield to the viewer: while they're actively using Recordings (listing,
    // paging, loading thumbnails), don't compete for the shared station P2P
    // session - a mid-flight backfill DB query would delay their thumbnails past
    // the fetch timeout. Re-check shortly after they go idle.
    if (Date.now() - lastUserActivity < BACKFILL_USER_IDLE_MS) { scheduleBackfill(BACKFILL_USER_IDLE_MS); return; }
    backfilling = true;
    let didWork = false, moreToDo = false;
    try {
        const client = getClient();
        if (!client || !client.isConnected()) { moreToDo = true; return; }
        const horizon = Date.now() - BACKFILL_HORIZON_DAYS * 86400000;

        const deviceList = Object.values(await client.getDevices());
        const names = {};
        const byStation = new Map();
        for (const d of deviceList) {
            names[d.getSerial()] = d.getName();
            deviceNames.set(d.getSerial(), d.getName());
            const st = d.getStationSerial();
            if (!byStation.has(st)) byStation.set(st, []);
            byStation.get(st).push(d);
        }

        // Advance the first station that still has history below its covered floor.
        // A station that's busy/in-cooldown is skipped (not broken on) so a stuck
        // hub never blocks the others; only a station we actually queried ends the
        // loop for this cycle.
        for (const [stSN, devs] of byStation) {
            if (backfillDone.has(stSN)) continue;
            const cov = coverage.get(stSN);
            const floor = cov ? cov.oldest : Date.now();
            if (floor <= horizon) { backfillDone.add(stSN); continue; }
            moreToDo = true;
            if (isStationBusy(stSN)) continue;                        // live view running - try later (doesn't count against give-up)
            // In dead-hub cooldown: can't query now. Count it toward giving up so a
            // permanently-unreachable hub (which lives in cooldown) still gets parked
            // instead of keeping the backfill - and its banner - running forever.
            if ((silentUntil.get(stSN) || 0) > Date.now()) {
                const n = (backfillFails.get(stSN) || 0) + 1;
                backfillFails.set(stSN, n);
                if (n >= BACKFILL_MAX_FAILS) {
                    backfillDone.add(stSN);
                    utils.log(`🗂️ Backfill giving up on ${names[stSN] || stSN} after ${n} attempts (unreachable) - a refresh/restart retries`, 'warn');
                }
                continue;
            }
            const toMs = floor;
            const fromMs = Math.max(horizon, toMs - BACKFILL_CHUNK_DAYS * 86400000);
            const station = await client.getStation(stSN);
            const status = { station: names[stSN] || stSN, cameras: devs.map(d => d.getName()), rows: 0 };
            const r = await fetchStation(station, stSN, devs, fromMs, toMs, false, names, status);
            if (status.unsupported) { backfillDone.add(stSN); continue; }  // hub can't be queried - done with it
            if (r.ok) {
                const c = coverage.get(stSN) || { newest: toMs, oldest: toMs };
                c.oldest = Math.min(c.oldest != null ? c.oldest : toMs, r.coveredFrom != null ? r.coveredFrom : fromMs);
                coverage.set(stSN, c);
                backfillFails.delete(stSN);
                scheduleSaveCache();
                didWork = true;
                utils.log(`🗂️ Backfill ${status.station}: ${new Date(c.oldest).toISOString().slice(0, 10)} ← (${status.rows} this chunk)`, 'info');
            } else {
                // Timed out. Retry a few times (via cooldown), then park this hub for
                // the run so one unreachable station doesn't spin the backfill forever.
                const n = (backfillFails.get(stSN) || 0) + 1;
                backfillFails.set(stSN, n);
                if (n >= BACKFILL_MAX_FAILS) {
                    backfillDone.add(stSN);
                    utils.log(`🗂️ Backfill giving up on ${status.station} after ${n} attempts (unreachable) - a refresh/restart retries`, 'warn');
                }
            }
            break;   // one station chunk per cycle
        }

        // Deepen the cloud index too (cheap range query → bigger chunks).
        if (!backfillDone.has('__cloud__')) {
            const floor = cloudCoverage ? cloudCoverage.oldest : Date.now();
            if (floor <= horizon) { backfillDone.add('__cloud__'); }
            else {
                moreToDo = true;
                const toMs = floor;
                const fromMs = Math.max(horizon, toMs - BACKFILL_CLOUD_CHUNK_DAYS * 86400000);
                const status = { station: 'cloud', rows: 0 };
                if (await fetchCloud(client, fromMs, toMs, status)) {
                    cloudCoverage = cloudCoverage || { newest: toMs, oldest: toMs };
                    cloudCoverage.oldest = Math.min(cloudCoverage.oldest, fromMs);
                    scheduleSaveCache();
                    didWork = true;
                }
            }
        }
    } catch (e) {
        utils.log(`🗂️ History backfill error: ${e.message}`, 'warn');
        moreToDo = true;   // transient - try again later
    } finally {
        backfilling = false;
        if (moreToDo) scheduleBackfill(didWork ? BACKFILL_CYCLE_MS : BACKFILL_RETRY_MS);
        else utils.log('🗂️ History backfill complete - all sources reached the horizon', 'info');
    }
}

// ---- Leading-edge freshen ---------------------------------------------------
// Recordings are detection-triggered and the eufy library has no "recording
// saved" event, so the cache's newest edge only advances when we query a hub.
// Rather than make the Recordings page block on that at load time, we keep the
// tip warm in the background two ways: (1) event-driven - a live detection
// schedules a one-shot query of that hub once the clip has had time to record and
// index; (2) a low-rate safety poll, so anything a missed/duplicate-suppressed
// detection would have skipped still gets picked up. Both reuse fetchStation and
// the same coverage checkpointing as everything else.

const RECORDING_SETTLE_MS = Number(process.env.HISTORY_RECORDING_SETTLE_MS) || 60000;   // wait after a detection before the clip is grabbable
const TIP_POLL_MS = Number(process.env.HISTORY_TIP_POLL_MS) || 5 * 60000;               // safety-net sweep interval
const TIP_POLL_FIRST_MS = Number(process.env.HISTORY_TIP_POLL_FIRST_MS) || 25000;       // first sweep soon after startup
const TIP_MIN_INTERVAL_MS = Number(process.env.HISTORY_TIP_MIN_INTERVAL_MS) || 30000;   // per-hub throttle (don't re-query more often than this)
const freshenPending = new Map();          // stationSN -> settle timer (debounced per hub)
const freshenRunning = new Set();          // stationSN currently being freshened
const lastFreshen = new Map();             // stationSN -> epoch ms of last freshen attempt
let tipPollTimer = null;

// A live detection fired on this camera - pull its hub's newest->now window once
// the recording has had time to land. Coalesces a burst into a single query.
async function noteDetection(serialNumber) {
    if (!BACKFILL_ENABLED || !serialNumber) return;
    try {
        const client = getClient();
        if (!client || !client.isConnected()) return;
        const device = await client.getDevice(serialNumber);
        const stSN = device.getStationSerial();
        if (!stSN || freshenPending.has(stSN)) return;      // already scheduled for this hub
        const timer = setTimeout(() => { freshenPending.delete(stSN); freshenStation(stSN).catch(() => {}); }, RECORDING_SETTLE_MS);
        if (timer.unref) timer.unref();
        freshenPending.set(stSN, timer);
    } catch (e) { /* device not ready - a later detection or the poll covers it */ }
}

// Query one hub's newest-covered -> now window and splice any new clips into the
// cache. Seeds coverage for a hub we've never listed. Yields to live view and the
// dead-hub cooldown so it never fights a user action, and throttles per hub. Pushes
// a `history_updated` nudge when it actually adds something.
async function freshenStation(stSN) {
    if (freshenRunning.has(stSN)) return;
    if (isStationBusy(stSN)) return;                                   // live view on this hub - skip; poll/next detection retries
    if ((silentUntil.get(stSN) || 0) > Date.now()) return;            // dead-hub cooldown
    if (Date.now() - (lastFreshen.get(stSN) || 0) < TIP_MIN_INTERVAL_MS) return;
    const client = getClient();
    if (!client || !client.isConnected()) return;
    freshenRunning.add(stSN);
    lastFreshen.set(stSN, Date.now());
    try {
        const deviceList = Object.values(await client.getDevices());
        const names = {};
        const devs = [];
        for (const d of deviceList) {
            names[d.getSerial()] = d.getName();
            deviceNames.set(d.getSerial(), d.getName());
            if (d.getStationSerial() === stSN) devs.push(d);
        }
        if (!devs.length) return;
        const now = Date.now();
        const cov = coverage.get(stSN);
        const from = cov ? cov.newest - COVERAGE_OVERLAP_MS : now - PAGE_DAYS * 86400000;   // seed a week if never listed
        if (cov && now <= cov.newest) return;                          // already current
        const before = records.size;
        const station = await client.getStation(stSN);
        const status = { station: names[stSN] || stSN, cameras: devs.map(d => d.getName()), rows: 0 };
        const r = await fetchStation(station, stSN, devs, from, now, false, names, status);
        if (r.ok) {
            const c = coverage.get(stSN) || { newest: now, oldest: r.coveredFrom != null ? r.coveredFrom : from };
            c.newest = now;
            coverage.set(stSN, c);
            scheduleSaveCache();
        }
        if (records.size !== before) {
            utils.log(`🗂️ Tip freshen ${status.station}: +${records.size - before} recent`, 'info');
            broadcast({ type: 'history_updated', stationSerial: stSN, added: records.size - before });
        }
    } catch (e) {
        utils.log(`🗂️ Tip freshen error (${stSN}): ${e.message}`, 'warn');
    } finally {
        freshenRunning.delete(stSN);
    }
}

// Freshen the tip of every hub (the safety sweep). Each freshenStation call
// self-guards busy hubs, cooldowns and the per-hub throttle.
async function freshenAllTips() {
    const client = getClient();
    if (!client || !client.isConnected()) return;
    const stations = new Set();
    for (const d of Object.values(await client.getDevices())) stations.add(d.getStationSerial());
    await Promise.all([...stations].map(stSN => freshenStation(stSN).catch(() => {})));
}

// Low-rate safety sweep: freshen every hub's tip in case a detection was missed
// or suppressed. Yields while the user is actively browsing (same P2P-contention
// courtesy as the backfill), and reschedules itself. First tick runs soon after
// startup so a restart doesn't leave the tip stale until the first full interval.
function startTipPoll() {
    if (tipPollTimer) return;
    const tick = async () => {
        let next = TIP_POLL_MS;
        if (Date.now() - lastUserActivity < BACKFILL_USER_IDLE_MS) {
            next = BACKFILL_USER_IDLE_MS;   // user is active - defer, retry shortly
        } else {
            try { await freshenAllTips(); } catch (e) {}
        }
        tipPollTimer = setTimeout(tick, next);
        if (tipPollTimer.unref) tipPollTimer.unref();
    };
    tipPollTimer = setTimeout(tick, TIP_POLL_FIRST_MS);
    if (tipPollTimer.unref) tipPollTimer.unref();
}

// Network-free per-station status for a warm-cache list response: flags the hubs
// we're currently cooling down on (so the client's "not responding" hint still
// shows) without doing any P2P query. Scope-filtered to the caller's cameras.
async function cacheSources(scope, opts) {
    const sources = [];
    try {
        const client = getClient();
        if (!client || !client.isConnected()) return sources;
        const allowed = sn => (!opts.serialNumber || sn === opts.serialNumber) && (!scope || auth.isCameraAllowed(scope, sn));
        const byStation = new Map();
        for (const d of Object.values(await client.getDevices())) {
            if (!allowed(d.getSerial())) continue;
            const st = d.getStationSerial();
            if (!byStation.has(st)) byStation.set(st, []);
            byStation.get(st).push(d.getName());
        }
        for (const [stSN, cams] of byStation) {
            if ((silentUntil.get(stSN) || 0) > Date.now()) {
                sources.push({ station: stSN, cameras: cams, timeouts: 1, skipped: true });
            }
        }
    } catch (e) { /* non-critical - just omit the hint */ }
    return sources;
}

// Summary for the date picker + filter chips + progress indicator: which days have
// events (UTC-keyed, matching listEvents' day grouping), the label set present, the
// cached span, and backfill progress. Pure cache read, scope-filtered. No network.
function coverageSummary(scope, opts = {}) {
    lastUserActivity = Date.now();
    const allowed = sn => (!opts.serialNumber || sn === opts.serialNumber) && (!scope || auth.isCameraAllowed(scope, sn));
    const days = {};       // 'YYYY-MM-DD' -> event count
    const labels = {};     // label -> event count
    let oldest = null, newest = null;
    for (const [, rec] of records) {
        if (!rec || !rec.device_sn || !rec.start_time || !allowed(rec.device_sn)) continue;
        const ms = rec.start_time * 1000;
        const day = new Date(ms).toISOString().slice(0, 10);
        days[day] = (days[day] || 0) + 1;
        const lbl = labelFor(rec);
        labels[lbl] = (labels[lbl] || 0) + 1;
        if (oldest === null || ms < oldest) oldest = ms;
        if (newest === null || ms > newest) newest = ms;
    }
    // Backfill progress across the in-scope stations only.
    let covOldest = null, pending = false;
    const deviceSN = opts.serialNumber;
    for (const [sn, cov] of coverage) {
        if (covOldest === null || cov.oldest < covOldest) covOldest = cov.oldest;
        if (!backfillDone.has(sn)) pending = true;
    }
    if (!backfillDone.has('__cloud__') && cloudCoverage) pending = true;
    return {
        days, labels, oldest, newest,
        backfill: {
            enabled: BACKFILL_ENABLED,
            running: BACKFILL_ENABLED && pending,
            coveredFrom: covOldest,
            horizon: Date.now() - BACKFILL_HORIZON_DAYS * 86400000,
        },
    };
}

// ---- Thumbnails ----
// Cloud thumbnails are URLs (fetched + decrypted via the API). Local ones are
// paths on the station, fetched over P2P one at a time (each answer arrives as
// a "station image download" event keyed by the file path).
const imageWaiters = new Map();            // file path -> resolve
let p2pThumbQueue = Promise.resolve();

function onImageDownload(station, file, image) {
    const w = imageWaiters.get(file);
    if (!w) return false;
    imageWaiters.delete(file);
    w(image && image.data);
    return true;
}

// True while history is waiting for this file (eufy-client skips its WS broadcast)
function isPendingThumb(file) {
    return imageWaiters.has(file);
}

function downloadStationImage(station, file) {
    const job = p2pThumbQueue.then(() => new Promise((resolve) => {
        const timer = setTimeout(() => { imageWaiters.delete(file); resolve(null); }, 8000);
        imageWaiters.set(file, (buf) => { clearTimeout(timer); resolve(buf); });
        try { station.downloadImage(file); } catch (e) { clearTimeout(timer); imageWaiters.delete(file); resolve(null); }
    }));
    p2pThumbQueue = job.catch(() => {});
    return job;
}


/**
 * Get Event Thumbnail (cached in memory)
 * @returns {Promise<Buffer|null>}
 */
async function getThumbnail(id) {
    lastUserActivity = Date.now();
    if (thumbCache.has(id)) {
        const buf = thumbCache.get(id);
        thumbCache.delete(id); thumbCache.set(id, buf);   // LRU touch
        return buf;
    }
    const rec = records.get(id);
    const client = getClient();
    if (!rec || !rec.thumb_path || !client) return null;
    let buf = null;
    if (/^https?:/i.test(rec.thumb_path)) {
        const img = await client.getApi().getImage(rec.device_sn, rec.thumb_path);
        buf = img && (img.data || img);
    } else {
        const device = await client.getDevice(rec.device_sn);
        const station = await client.getStation(device.getStationSerial());
        if (station.hasCommand('stationDownloadImage')) buf = await downloadStationImage(station, rec.thumb_path);
    }
    if (!buf || !buf.length) return null;
    buf = await fixV2Thumbnail(buf, `${rec.device_sn}:thumb`);   // repair HB2 v2 thumbnails (geometry cached per camera)
    thumbCache.set(id, buf);
    while (thumbCache.size > THUMB_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value);
    return buf;
}

// ---- Data Saver playback (low-fps JPEG frames) ------------------------------
// Turn a downloaded clip into a handful of JPEG frames, at the SAME FRAME_*
// settings the live Data Saver view uses, so a past event can be watched as a
// low-bandwidth slideshow that gets through stream-blocking / metered WiFi (e.g.
// a cruise ship without the streaming package) - the clip itself only travels the
// hub→server hop; the phone only ever pulls small JPEGs.
const FRAME_DIR = path.join(CLIP_DIR, 'frames');
const frameDir = id => path.join(FRAME_DIR, id);
const extractingFrames = new Map();     // id -> in-flight extraction promise (dedupe)

async function extractFrames(id) {
    if (!isValidId(id)) throw new Error('Invalid clip id');
    const clip = clipPath(id);
    if (!fs.existsSync(clip)) return { ready: false };     // clip not downloaded yet
    const cfg = utils.loadConfig();
    const fps = Number(cfg.FRAME_FPS) || 2;
    const dir = frameDir(id);
    try {
        const have = fs.readdirSync(dir).filter(f => f.endsWith('.jpg'));
        if (have.length) return { ready: true, count: have.length, fps };
    } catch (e) { /* not extracted yet */ }
    if (extractingFrames.has(id)) return extractingFrames.get(id);
    const job = (async () => {
        fs.mkdirSync(dir, { recursive: true });
        const scale = cfg.FRAME_SCALE || '640:-2';
        const quality = String(cfg.FRAME_QUALITY || '7');
        const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', clip,
            '-vf', `fps=${fps},scale=${scale}`, '-q:v', quality, path.join(dir, '%04d.jpg')];
        await new Promise((resolve, reject) => {
            const ff = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
            let err = '';
            ff.stderr.on('data', d => { err += d; if (err.length > 4096) err = err.slice(-4096); });
            ff.on('error', reject);
            ff.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg ${code}`)));
        });
        const count = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).length;
        utils.log(`🖼️ Extracted ${count} data-saver frame(s) for clip ${id} @ ${fps}fps`, 'info');
        return { ready: true, count, fps };
    })().finally(() => extractingFrames.delete(id));
    extractingFrames.set(id, job);
    return job;
}

// Serve frame N (1-based, matching ffmpeg's %04d output) of a clip, if extracted.
function getFrameFile(id, n) {
    if (!isValidId(id)) return null;
    const idx = Number(n);
    if (!Number.isInteger(idx) || idx < 1 || idx > 99999) return null;
    const f = path.join(frameDir(id), String(idx).padStart(4, '0') + '.jpg');
    return fs.existsSync(f) ? f : null;
}

// Keep the clip cache bounded (oldest first)
function pruneClips() {
    try {
        const files = fs.readdirSync(CLIP_DIR)
            .filter(f => f.endsWith('.mp4'))
            .map(f => ({ f, t: fs.statSync(path.join(CLIP_DIR, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t);
        for (const { f } of files.slice(MAX_CACHED_CLIPS)) fs.unlinkSync(path.join(CLIP_DIR, f));
    } catch (e) { /* best effort */ }
    // Drop extracted frames for any clip that's no longer cached.
    try {
        for (const d of fs.readdirSync(FRAME_DIR)) {
            if (!fs.existsSync(clipPath(d))) fs.rmSync(path.join(FRAME_DIR, d), { recursive: true, force: true });
        }
    } catch (e) { /* best effort */ }
}

// Empty the clip cache. Called when the viewer leaves the Recordings screen:
// clips are only cached so you can jump around and re-watch while browsing; a
// permanent copy is the explicit per-clip Download. Skips the clip currently
// downloading/streaming (and its .part) so an in-flight playback isn't yanked.
function clearCache() {
    let removed = 0;
    const keepId = active && active.id;
    try {
        for (const f of fs.readdirSync(CLIP_DIR)) {
            if (!f.endsWith('.mp4') && !f.endsWith('.part')) continue;
            if (keepId && f.startsWith(keepId + '.')) continue;   // active download's files
            try { fs.unlinkSync(path.join(CLIP_DIR, f)); removed++; } catch (e) { /* locked - skip */ }
        }
    } catch (e) { /* best effort */ }
    // Also drop extracted data-saver frames (except the active clip's).
    try {
        for (const d of fs.readdirSync(FRAME_DIR)) {
            if (keepId && d === keepId) continue;
            try { fs.rmSync(path.join(FRAME_DIR, d), { recursive: true, force: true }); } catch (e) {}
        }
    } catch (e) { /* best effort */ }
    if (removed) utils.log(`🧹 Cleared ${removed} cached clip(s) on leaving Recordings`, 'debug');
    return removed;
}

function send(ws, event) {
    if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'event', event })); } catch (e) { /* closed */ }
    }
}

function cleanupActive() {
    if (!active) return;
    clearTimeout(active.timer);
    try { active.ffmpeg && active.ffmpeg.kill('SIGKILL'); } catch (e) {}
    try { active.fileOut && active.fileOut.destroy(); } catch (e) {}
    active = null;
}

function fail(msg) {
    if (!active) return;
    const { id, ws, tmpBase, streamClients } = active;
    utils.log(`🎞️ Clip ${id} failed: ${msg}`, 'warn');
    // Tear down any open HTTP stream so the <video> element reports an error.
    for (const res of streamClients) { try { res.headersSent ? res.destroy() : res.status(502).end(); } catch (e) {} }
    cleanupActive();
    try { fs.unlinkSync(tmpBase); } catch (e) {}
    send(ws, { event: 'history_error', id, message: msg });
}

/**
 * Play: start streaming a clip (or report it ready if already cached).
 *
 * New clips are transcoded live: the P2P video/audio streams are piped straight
 * into FFmpeg producing fragmented MP4, whose bytes are (a) broadcast to the HTTP
 * response as they're produced - so playback starts at the first keyframe instead
 * of after the whole download finishes - and (b) written to the cache file for an
 * instant, seekable replay. The client opens the clip URL right away on `streaming`.
 *
 * @param {string} id - clip id from listEvents
 * @param {WebSocket} ws - requester (ready/error events go only to it)
 * @returns {Promise<{ready: boolean, streaming?: boolean, url?: string}>}
 */
async function play(id, ws) {
    lastUserActivity = Date.now();
    if (!isValidId(id)) throw new Error('Invalid clip id');
    const url = `/history/clip/${id}.mp4`;
    if (fs.existsSync(clipPath(id))) return { ready: true, url };

    const rec = records.get(id);
    if (!rec) throw new Error('Unknown recording - refresh the list');
    const client = getClient();
    if (!client || !client.isConnected()) throw new Error('Not connected to Eufy');

    // HomeBase 2 / Chime clips are stored on the hub's own card and the per-frame
    // media key is sealed to the cloud cipher's EC key (ECIES → AES-256-GCM). The
    // camera library is patched (patches/eufy-security-client+*.patch) to unwrap it
    // using the cipher's ecc_private_key, so these clips now download and play.
    // See the README (Credits & References) for the source of this scheme.

    if (active) {
        if (active.id === id) { active.ws = ws; return { ready: false, streaming: true, url }; }   // re-attach
        // The viewer moved on to another clip: cancel the old download.
        try { await client.cancelStationDownload(active.serialNumber); } catch (e) {}
        fail('Cancelled');
    }
    if (isStationBusy(rec.station_sn)) {
        throw new Error('Live view on this camera’s HomeBase is still active - try again in a few seconds');
    }

    const tmpBase = path.join(CLIP_DIR, `${id}.part`);
    active = {
        id, ws, tmpBase,
        serialNumber: rec.device_sn,
        meta: null,
        ffmpeg: null,
        fileOut: null,
        buf: Buffer.alloc(0),       // all fMP4 bytes so far - replayed to late-joining HTTP clients
        streamClients: [],          // open HTTP responses currently streaming this clip
        finished: false,
        timer: setTimeout(() => fail(String(rec.station_sn).startsWith('T8030')
            // eufy-security-client can't download from HomeBase 3 / S380 yet
            // (returns ERROR_INVALID_ACCOUNT; its fix was reverted in 3.7.2).
            ? 'Playback from HomeBase S380 isn’t supported by the camera library yet'
            : 'The camera didn’t start sending the clip'), START_TIMEOUT_MS)
    };
    utils.log(`🎞️ Streaming clip ${id} (${rec.device_name || rec.device_sn})`, 'info');
    // Resolve the clip's cipher up front. A Chime-paired doorbell reports a cipher_id
    // (seen: 1) that isn't a real cloud cipher - fetching it makes the library crash on
    // Object.keys(undefined), and without its key the hub won't stream the clip. Detect
    // that case so we can fail with a clear message instead of a crash / 25s timeout.
    // (HomeBase 2 / Chime-on-hub clips have a real cloud cipher and are unaffected.)
    let cipherArg = cloudCipherId(rec.cipher_id);
    if (cipherArg !== undefined && cipherArg !== null) {
        let cipherMissing = false;
        try {
            const st = await client.getStation(rec.station_sn);
            const raw = st.getRawStation ? st.getRawStation() : st.rawStation;
            const adminId = raw && raw.member && raw.member.admin_user_id;
            const ciphers = await client.getApi().getCiphers([cipherArg], adminId);
            const c = ciphers && ciphers[cipherArg];
            cipherMissing = !c || Object.keys(c).length === 0;
        } catch (e) {
            utils.log(`🎞️ Clip ${id}: cipher precheck error (${e.message})`, 'warn');
        }
        if (cipherMissing) {
            // Chime-paired doorbell: no cloud cipher. These clips are AES-128-ECB under a
            // key derived from station serial + p2p_did + a per-clip rand the hub sends in
            // the download result - decoded in the patched session.js Chime path. Proceed
            // with a keyless download (cipherArg=undefined) and let that path decrypt it.
            utils.log(`🎞️ Clip ${id}: no cloud cipher - Chime local-key decrypt path`, 'info');
            cipherArg = undefined;
        }
    }
    try {
        await client.startStationDownload(rec.device_sn, rec.storage_path || rec.hevc_storage_path, cipherArg);
    } catch (e) {
        fail(e.message);
        throw e;
    }
    return { ready: false, streaming: true, url };
}

// Library event: the station started streaming the requested recording. Spin up a
// live FFmpeg (video → pipe:0, audio → pipe:3) emitting fragmented MP4 on stdout,
// and fan those bytes out to the HTTP stream + the cache file as they arrive.
function onDownloadStart(station, device, metadata, videostream, audiostream) {
    if (!active || device.getSerial() !== active.serialNumber || active.ffmpeg) return;
    clearTimeout(active.timer);
    active.timer = setTimeout(() => fail('Download took too long'), DOWNLOAD_TIMEOUT_MS);
    const a = active;
    a.meta = {
        videoCodec: VideoCodec[metadata.videoCodec],
        audioCodec: AudioCodec[metadata.audioCodec],
        fps: metadata.videoFPS || 15
    };
    const h264 = a.meta.videoCodec === 'H264';
    const hasAudio = a.meta.audioCodec === 'AAC';
    const args = [
        '-loglevel', 'error',
        '-fflags', '+genpts',
        '-r', String(a.meta.fps),
        '-f', h264 ? 'h264' : 'hevc', '-i', 'pipe:0',
        ...(hasAudio ? ['-thread_queue_size', '512', '-f', 'aac', '-i', 'pipe:3'] : []),
        '-map', '0:v', ...(hasAudio ? ['-map', '1:a?'] : []),   // '?' tolerates a silent clip
        // Browsers play H.264 everywhere; H.265 gets transcoded on the fly.
        ...(h264 ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']),
        ...(hasAudio ? ['-c:a', 'aac', '-ac', '1'] : []),
        // Fragmented MP4 so the browser can start playing before the clip finishes.
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4', 'pipe:1'
    ];
    const ff = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'pipe', 'pipe', hasAudio ? 'pipe' : 'ignore'] });
    a.ffmpeg = ff;
    a.fileOut = fs.createWriteStream(a.tmpBase);
    let err = '';
    ff.stderr.on('data', d => { err += d; if (err.length > 4096) err = err.slice(-4096); });
    ff.on('error', e => { if (active === a) fail(`FFmpeg failed to start: ${e.message}`); });

    // Fan fragmented-MP4 output out to the cache file and every open HTTP client.
    ff.stdout.on('data', (chunk) => {
        if (active !== a) return;
        a.buf = Buffer.concat([a.buf, chunk]);
        try { a.fileOut.write(chunk); } catch (e) {}
        for (const res of a.streamClients) { try { res.write(chunk); } catch (e) {} }
    });

    ff.on('close', (code) => {
        if (active !== a) return;   // superseded/cancelled - fail() already cleaned up
        const ok = code === 0 && a.buf.length > 0;
        const finalize = () => {
            if (!ok) {
                try { fs.unlinkSync(a.tmpBase); } catch (e) {}
                fail(`Couldn't convert the clip (${err.trim().split('\n').pop() || 'ffmpeg ' + code})`);
                return;
            }
            try { fs.renameSync(a.tmpBase, clipPath(a.id)); } catch (e) {}
            utils.log(`🎞️ Clip ${a.id} ready (${a.buf.length} bytes${hasAudio ? ', audio' : ''})`, 'info');
            a.finished = true;
            clearTimeout(a.timer);
            for (const res of a.streamClients) { try { res.end(); } catch (e) {} }
            active = null;
            pruneClips();
            send(a.ws, { event: 'history_ready', id: a.id, url: `/history/clip/${a.id}.mp4` });
        };
        try { a.fileOut.end(finalize); } catch (e) { finalize(); }
    });

    // Feed the raw elementary streams into FFmpeg (ignore EPIPE if it exits first).
    if (ff.stdin) ff.stdin.on('error', () => {});
    if (ff.stdio[3]) ff.stdio[3].on('error', () => {});
    videostream.pipe(ff.stdin);
    if (hasAudio && ff.stdio[3]) audiostream.pipe(ff.stdio[3]);
}

// Library event: the station finished sending the recording → close FFmpeg's inputs
// so it flushes the trailing fragments and exits (finalized in ff.on('close')).
function onDownloadFinish(station, device) {
    if (!active || device.getSerial() !== active.serialNumber || !active.ffmpeg) return;
    try { active.ffmpeg.stdin.end(); } catch (e) {}
    try { active.ffmpeg.stdio[3] && active.ffmpeg.stdio[3].end(); } catch (e) {}
}

/**
 * Attach an HTTP response to the in-progress clip stream, if one is running for
 * this id. Writes the fMP4 bytes buffered so far, then live fragments as produced.
 * @returns {boolean} true if attached (the response is now owned here)
 */
function attachStream(id, res) {
    const a = active;
    if (!a || a.id !== id || a.finished) return false;
    res.status(200);
    res.set('Content-Type', 'video/mp4');
    res.set('Cache-Control', 'no-store');
    if (a.buf.length) { try { res.write(a.buf); } catch (e) {} }
    a.streamClients.push(res);
    res.on('close', () => {
        const i = a.streamClients.indexOf(res);
        if (i >= 0) a.streamClients.splice(i, 1);
    });
    return true;
}

/**
 * Resolve a cached clip file for HTTP serving
 * @returns {string|null} absolute path
 */
function getClipFile(id) {
    if (!isValidId(id)) return null;
    const p = clipPath(id);
    return fs.existsSync(p) ? p : null;
}

module.exports = {
    init,
    listEvents,
    coverageSummary,
    getThumbnail,
    play,
    onDownloadStart,
    onDownloadFinish,
    onDatabaseQueryByDate,
    onDatabaseQueryLocal,
    onImageDownload,
    isPendingThumb,
    getClipFile,
    attachStream,
    serialFromId,
    isValidId,
    clearCache,
    extractFrames,
    getFrameFile,
    noteActivity,
    noteDetection
};
