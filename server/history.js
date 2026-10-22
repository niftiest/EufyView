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
const { VideoCodec, AudioCodec, DeviceType } = require('eufy-security-client');

const utils = require('./utils');
const auth = require('./auth');
const eventLog = require('./events');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const CLIP_DIR = path.join(utils.dataDir, 'clips');
const MAX_CACHED_CLIPS = 40;               // oldest clips beyond this are deleted
const PAGE_DAYS = 7;                       // events per "page" = one week
const MAX_EVENTS = 300;
const START_TIMEOUT_MS = 25000;            // station must start sending within this
const DOWNLOAD_TIMEOUT_MS = 4 * 60000;     // whole download must finish within this
const THUMB_CACHE_MAX = 200;
const EVENT_MATCH_S = 90;               // detection ↔ recording same-event window

let getClient = () => null;                // () => EufySecurity instance (set by init)
let isStationBusy = () => false;           // (stationSN) => live view running on it

const records = new Map();                 // clip id -> normalized event (incl. path/cipher)
const thumbCache = new Map();              // clip id -> Buffer (insertion-ordered LRU)
let active = null;                         // current download (see startDownload)
let loggedSample = false;

function init(opts) {
    getClient = opts.getClient;
    isStationBusy = opts.isStationBusy || isStationBusy;
    try { fs.mkdirSync(CLIP_DIR, { recursive: true }); } catch (e) { /* exists */ }
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
// HomeBase-stored recordings are NOT in the cloud index — the official app
// lists them by asking the station directly (CMD_DATABASE_QUERY_BY_DATE).
// The station answers with one "station database query by date" event; we
// match it to the pending request by station serial.
const DB_QUERY_TIMEOUT_MS = 10000;
const DB_QUERY_LIMIT = 100;                // the station returns at most this many per query
const dbWaiters = new Map();               // stationSN -> { resolve, timer }

function onDatabaseQueryByDate(station, returnCode, data) {
    const w = dbWaiters.get(station.getSerial());
    if (!w) return;
    clearTimeout(w.timer);
    dbWaiters.delete(station.getSerial());
    w.resolve(Array.isArray(data) ? data : []);
}

function queryStation(station, serials, start, end) {
    return new Promise((resolve) => {
        const sn = station.getSerial();
        if (dbWaiters.has(sn)) { clearTimeout(dbWaiters.get(sn).timer); dbWaiters.get(sn).resolve([]); }
        const timer = setTimeout(() => {
            dbWaiters.delete(sn);
            const none = []; none.timedOut = true;      // distinguishes "no answer" from "no clips"
            resolve(none);
        }, DB_QUERY_TIMEOUT_MS);
        dbWaiters.set(sn, { resolve, timer });
        try {
            station.databaseQueryByDate(serials, start, end);
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
async function queryStationRange(station, serials, start, end) {
    const out = [];
    out.timeouts = 0;
    const nextDay = d => { const n = new Date(d); n.setDate(n.getDate() + 1); return n; };
    // HomeBase 3 / S380 only answers one day per whole-range query — a single
    // range query silently returns an incomplete subset (and stays under the
    // cap, so the split below never triggers). For HB3, always walk day by day.
    const perDayOnly = station.getDeviceType() === DeviceType.HB3;
    const rows = perDayOnly ? null : await queryStation(station, serials, start, nextDay(end));
    if (rows && rows.timedOut) out.timeouts++;
    if (rows && rows.length < DB_QUERY_LIMIT) {
        out.push(...rows);
    } else {
        const day0 = new Date(start); day0.setHours(0, 0, 0, 0);
        for (let d = new Date(end); d >= day0; d.setDate(d.getDate() - 1)) {
            const day = new Date(d); day.setHours(0, 0, 0, 0);
            let dayRows = await queryStation(station, serials, day, nextDay(day));
            if (dayRows.timedOut) out.timeouts++;
            if (dayRows.length >= DB_QUERY_LIMIT && serials.length > 1) {
                dayRows = [];
                for (const sn of serials) dayRows.push(...await queryStation(station, [sn], day, nextDay(day)));
            }
            out.push(...dayRows);
        }
    }
    const inRange = out.filter(r => {
        const t = new Date(r.start_time).getTime();
        return t >= start.getTime() && t <= end.getTime();
    });
    inRange.timeouts = out.timeouts;
    return inRange;
}

// Normalize a station DB row to the cloud record shape used everywhere else
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
    if (trig & 4 || rec.has_human || vt === 1003) return 'Person';
    if (vt === 1004) return 'Pet';
    if (vt === 1005) return 'Crying';
    if (vt === 1006) return 'Sound';
    return 'Motion';
}

// Hubs that didn't answer recently are skipped for a while, so one asleep or
// unreachable hub doesn't add a 10s wait to every page of the list.
const SILENT_SKIP_MS = 10 * 60000;
const silentUntil = new Map();           // stationSN -> epoch ms

/**
 * List Events
 * Merges EufyView's own event log (every detection + snapshot) with each
 * station's local recording index (P2P) and the cloud index. A detection and a
 * recording from the same camera within EVENT_MATCH_S become one entry.
 * @param {Object} scope - viewer's camera scope (null = unrestricted)
 * @param {Object} opts - { serialNumber?, before? (epoch ms) }
 * @returns {Promise<{events: Array, before: number, after: number}>}
 */
async function listEvents(scope, opts = {}) {
    const client = getClient();
    if (!client || !client.isConnected()) throw new Error('Not connected to Eufy');
    const end = opts.before ? new Date(Number(opts.before)) : new Date();
    const start = new Date(end.getTime() - PAGE_DAYS * 86400000);
    const allowed = sn => (!opts.serialNumber || sn === opts.serialNumber) && (!scope || auth.isCameraAllowed(scope, sn));

    // Local: group the viewer's cameras by station and ask each station once
    const byStation = new Map();             // stationSN -> [device]
    const deviceList = Object.values(await client.getDevices());
    for (const d of deviceList) {
        if (!allowed(d.getSerial())) continue;
        const st = d.getStationSerial();
        if (!byStation.has(st)) byStation.set(st, []);
        byStation.get(st).push(d);
    }
    const names = Object.fromEntries(deviceList.map(d => [d.getSerial(), d.getName()]));
    const sources = [];                      // per-station status, returned for diagnostics
    const localJobs = [...byStation.entries()].map(async ([stSN, devs]) => {
        const status = { station: names[stSN] || stSN, cameras: devs.map(d => d.getName()), rows: 0 };
        sources.push(status);
        try {
            const station = await client.getStation(stSN);
            if (!station.hasCommand('stationDatabaseQueryByDate')) { status.unsupported = true; return []; }
            if ((silentUntil.get(stSN) || 0) > Date.now()) { status.timeouts = 1; status.skipped = true; return []; }
            const rows = await queryStationRange(station, devs.map(d => d.getSerial()), start, end);
            status.rows = rows.length;
            if (rows.timeouts) { status.timeouts = rows.timeouts; silentUntil.set(stSN, Date.now() + SILENT_SKIP_MS); }
            return rows.filter(r => r && r.device_sn && allowed(r.device_sn)).map(r => fromLocalRow(r, names[r.device_sn]));
        } catch (e) {
            status.error = e.message;
            utils.log(`🎞️ Local event query error (${stSN}): ${e.message}`, 'warn');
            return [];
        }
    });

    // Cloud: cloud-stored clips (and anything the cloud indexes)
    const cloudJob = client.getApi()
        .getVideoEvents(start, end, opts.serialNumber ? { deviceSN: opts.serialNumber } : undefined, MAX_EVENTS)
        .catch(e => { utils.log(`🎞️ Cloud event list error: ${e.message}`, 'warn'); return []; });

    const [cloud, ...local] = await Promise.all([cloudJob, ...localJobs]);
    const localRows = local.flat();
    if (!loggedSample) {
        const sample = localRows[0] || cloud[0];
        if (sample) {
            const { p2p_license, push_license, ndt_license, wipn_enc_dec_key, wipn_ndt_aes128key, wakeup_key, ...safe } = sample;
            utils.log(`🎞️ History: ${localRows.length} local + ${cloud.length} cloud; sample ${JSON.stringify(safe).slice(0, 800)}`, 'info');
            loggedSample = true;
        }
    }

    const merged = new Map();
    for (const rec of [...cloud, ...localRows]) {      // local wins on duplicates (has a playable path)
        if (!rec || !rec.device_sn || !rec.start_time || !allowed(rec.device_sn)) continue;
        merged.set(clipId(rec), rec);
    }

    const events = [];
    for (const [id, rec] of merged) {
        records.set(id, rec);
        events.push({
            id,
            serialNumber: rec.device_sn,
            deviceName: rec.device_name || names[rec.device_sn] || rec.device_sn,
            start: rec.start_time,
            end: rec.end_time,
            label: labelFor(rec),
            hasThumb: !!rec.thumb_path,
            canPlay: !!(rec.storage_path || rec.hevc_storage_path),
            cached: fs.existsSync(clipPath(id))
        });
    }
    // EufyView's own detections: attach to a matching recording, else stand alone
    const logged = eventLog.list(scope, { serialNumber: opts.serialNumber, start: start.getTime(), end: end.getTime() });
    for (const ev of logged) {
        const t = Math.floor(ev.time / 1000);
        const snap = ev.snap ? `/history/snap/${ev.id}.jpg` : null;
        const match = events.find(r => r.serialNumber === ev.serialNumber && Math.abs(r.start - t) <= EVENT_MATCH_S);
        if (match) {
            if (snap && !match.snap) match.snap = snap;
            continue;
        }
        events.push({
            id: ev.id,
            serialNumber: ev.serialNumber,
            deviceName: names[ev.serialNumber] || ev.cameraName,
            start: t,
            end: 0,
            label: ev.label,
            event: ev.event,
            snap,
            hasThumb: false,
            canPlay: false,
            cached: false
        });
    }
    events.sort((a, b) => b.start - a.start);
    sources.push({ station: 'cloud', rows: cloud.length });
    sources.push({ station: 'eventlog', rows: logged.length });
    return { events, before: end.getTime(), after: start.getTime(), sources };
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
    thumbCache.set(id, buf);
    while (thumbCache.size > THUMB_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value);
    return buf;
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
}

function send(ws, event) {
    if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'event', event })); } catch (e) { /* closed */ }
    }
}

function cleanupActive() {
    if (!active) return;
    clearTimeout(active.timer);
    for (const s of [active.videoOut, active.audioOut]) { try { s && s.end(); } catch (e) {} }
    active = null;
}

function fail(msg) {
    if (!active) return;
    const { id, ws, tmpBase } = active;
    utils.log(`🎞️ Clip ${id} failed: ${msg}`, 'warn');
    cleanupActive();
    for (const ext of ['.video', '.audio']) { try { fs.unlinkSync(tmpBase + ext); } catch (e) {} }
    send(ws, { event: 'history_error', id, message: msg });
}

/**
 * Play: start downloading a clip (or report it ready if cached)
 * @param {string} id - clip id from listEvents
 * @param {WebSocket} ws - requester (progress/ready/error events go only to it)
 * @returns {Promise<{ready: boolean, url?: string}>}
 */
async function play(id, ws) {
    if (!isValidId(id)) throw new Error('Invalid clip id');
    const url = `/history/clip/${id}.mp4`;
    if (fs.existsSync(clipPath(id))) return { ready: true, url };

    const rec = records.get(id);
    if (!rec) throw new Error('Unknown recording — refresh the list');
    const client = getClient();
    if (!client || !client.isConnected()) throw new Error('Not connected to Eufy');

    if (active) {
        if (active.id === id) { active.ws = ws; return { ready: false }; }   // re-attach
        // The viewer moved on to another clip: cancel the old download.
        try { await client.cancelStationDownload(active.serialNumber); } catch (e) {}
        fail('Cancelled');
    }
    if (isStationBusy(rec.station_sn)) {
        throw new Error('Live view on this camera’s HomeBase is still active — try again in a few seconds');
    }

    const tmpBase = path.join(CLIP_DIR, `${id}.part`);
    active = {
        id, ws, tmpBase,
        serialNumber: rec.device_sn,
        frames: 0,
        totalFrames: rec.frame_num || 0,
        lastPct: -1,
        videoOut: null, audioOut: null, meta: null,
        timer: setTimeout(() => fail(String(rec.station_sn).startsWith('T8030')
            // eufy-security-client can't download from HomeBase 3 / S380 yet
            // (returns ERROR_INVALID_ACCOUNT; its fix was reverted in 3.7.2).
            ? 'Playback from HomeBase S380 isn’t supported by the camera library yet'
            : 'The camera didn’t start sending the clip'), START_TIMEOUT_MS)
    };
    utils.log(`🎞️ Downloading clip ${id} (${rec.device_name || rec.device_sn})`, 'info');
    try {
        await client.startStationDownload(rec.device_sn, rec.storage_path || rec.hevc_storage_path, rec.cipher_id);
    } catch (e) {
        fail(e.message);
        throw e;
    }
    return { ready: false };
}

// Library event: the station started streaming the requested recording
function onDownloadStart(station, device, metadata, videostream, audiostream) {
    if (!active || device.getSerial() !== active.serialNumber || active.videoOut) return;
    clearTimeout(active.timer);
    active.timer = setTimeout(() => fail('Download took too long'), DOWNLOAD_TIMEOUT_MS);
    active.meta = {
        videoCodec: VideoCodec[metadata.videoCodec],
        audioCodec: AudioCodec[metadata.audioCodec],
        fps: metadata.videoFPS || 15
    };
    active.videoOut = fs.createWriteStream(active.tmpBase + '.video');
    active.audioOut = fs.createWriteStream(active.tmpBase + '.audio');
    const a = active;
    videostream.on('data', (chunk) => {
        if (active !== a) return;
        a.videoOut.write(chunk);
        a.frames++;
        if (a.totalFrames > 0) {
            const pct = Math.min(99, Math.floor((a.frames / a.totalFrames) * 100));
            if (pct >= a.lastPct + 5) { a.lastPct = pct; send(a.ws, { event: 'history_progress', id: a.id, pct }); }
        }
    });
    audiostream.on('data', (chunk) => { if (active === a) a.audioOut.write(chunk); });
}

// Library event: the station finished sending the recording → mux to MP4
function onDownloadFinish(station, device) {
    if (!active || device.getSerial() !== active.serialNumber || !active.videoOut) return;
    const a = active;
    clearTimeout(a.timer);
    send(a.ws, { event: 'history_progress', id: a.id, pct: 99 });
    let pending = 2;
    const done = () => { if (--pending === 0) mux(a); };
    a.videoOut.end(done);
    a.audioOut.end(done);
}

function mux(a) {
    const videoFile = a.tmpBase + '.video';
    const audioFile = a.tmpBase + '.audio';
    const outFile = a.tmpBase + '.mp4';
    const hasAudio = a.meta.audioCodec === 'AAC' && fs.existsSync(audioFile) && fs.statSync(audioFile).size > 0;
    const h264 = a.meta.videoCodec === 'H264';
    const args = [
        '-loglevel', 'error', '-y',
        '-fflags', '+genpts',
        '-r', String(a.meta.fps),
        '-f', h264 ? 'h264' : 'hevc', '-i', videoFile,
        ...(hasAudio ? ['-f', 'aac', '-i', audioFile] : []),
        '-map', '0:v', ...(hasAudio ? ['-map', '1:a'] : []),
        // Browsers play H.264 everywhere; H.265 gets transcoded.
        ...(h264 ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']),
        ...(hasAudio ? ['-c:a', 'aac', '-ac', '1'] : []),
        '-movflags', '+faststart',
        '-f', 'mp4', outFile
    ];
    const ff = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', d => { err += d; });
    ff.on('error', e => fail(`FFmpeg failed to start: ${e.message}`));
    ff.on('close', (code) => {
        for (const f of [videoFile, audioFile]) { try { fs.unlinkSync(f); } catch (e) {} }
        if (active !== a) { try { fs.unlinkSync(outFile); } catch (e) {} return; }
        if (code !== 0 || !fs.existsSync(outFile)) {
            try { fs.unlinkSync(outFile); } catch (e) {}
            fail(`Couldn't convert the clip (${err.trim().split('\n').pop() || 'ffmpeg ' + code})`);
            return;
        }
        fs.renameSync(outFile, clipPath(a.id));
        utils.log(`🎞️ Clip ${a.id} ready (${a.frames} frames${hasAudio ? ', audio' : ''})`, 'info');
        cleanupActive();
        pruneClips();
        send(a.ws, { event: 'history_ready', id: a.id, url: `/history/clip/${a.id}.mp4` });
    });
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
    getThumbnail,
    play,
    onDownloadStart,
    onDownloadFinish,
    onDatabaseQueryByDate,
    onImageDownload,
    isPendingThumb,
    getClipFile,
    serialFromId,
    isValidId
};
