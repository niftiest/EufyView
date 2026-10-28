/**
 * Snapshot Grabber
 *
 * Turns one camera's raw livestream (H.264/H.265 straight from P2P) into a
 * thumbnail JPEG, independently of the live-view pipeline in transcode.js.
 * Each grabber owns a small FFmpeg process that decodes until the first
 * complete frame, writes it, and exits - no re-encoding, and several can run
 * at once (one per station, since a station streams one camera at a time).
 *
 * The JPEG goes to a temp file first and only replaces data/snapshots/<sn>.jpg
 * once FFmpeg has actually produced an image (it exits 0 even when it decoded
 * nothing).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const utils = require('./utils');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const MAX_WIDTH = 1280;                 // master width cap - thumbnails travel over WS as JSON byte arrays, keep modest
// Small derivative: must match transcode.js's live-view output so the sweep and
// a live-view session write interchangeable <sn>.sm.jpg files. This is the one
// broadcastSnapshot / Web Push / the TV grid actually read (loadSnapshotFromDisk
// { small:true }); if the grabber skips it they get the STALE small left over
// from the last live view and the thumbnail never updates.
const SMALL_WIDTH = parseInt(process.env.SNAPSHOT_WIDTH, 10) || 640;
const SMALL_QUALITY = parseInt(process.env.SNAPSHOT_QUALITY, 10) || 4;
// Sensor warm-up: the very first decoded frame is captured before the camera's
// auto-exposure / auto-white-balance converge - on a cold battery camera it
// comes back blown-out and pink (measured: frame 0 washed out, fully settled by
// ~frame 3). Drop the first N decoded frames so the thumbnail is a settled
// image. 15 frames ≈ 1s at 15fps: comfortable margin over the ~3-frame settle,
// and well under SNAPSHOT_KEYFRAME_TIMEOUT_MS. Override with SNAPSHOT_WARMUP_FRAMES.
const _warmup = parseInt(process.env.SNAPSHOT_WARMUP_FRAMES, 10);
const WARMUP_FRAMES = Number.isFinite(_warmup) ? Math.max(0, _warmup) : 15;

let tempSeq = 0;

/**
 * Start a grabber for one camera
 * @param {string} serialNumber - Device serial number
 * @param {string} videoCodec - 'H264' or 'H265'
 * @returns {{ write: (chunk: Buffer) => void, abort: () => void, done: Promise<boolean> }}
 *          done resolves true once data/snapshots/<sn>.jpg holds the new image
 */
function startGrabber(serialNumber, videoCodec) {
    if (!fs.existsSync(utils.snapshotDir)) fs.mkdirSync(utils.snapshotDir, { recursive: true });
    const finalPath = path.join(utils.snapshotDir, `${serialNumber}.jpg`);
    const smallPath = path.join(utils.snapshotDir, `${serialNumber}.sm.jpg`);
    const seq = `${process.pid}-${++tempSeq}`;
    const tmpPath = path.join(utils.snapshotDir, `${serialNumber}.${seq}.tmp.jpg`);
    const smallTmp = path.join(utils.snapshotDir, `${serialNumber}.${seq}.sm.tmp.jpg`);

    // One decode, two JPEGs: the master (<=MAX_WIDTH) and the small PWA/push/TV
    // derivative (<=SMALL_WIDTH). select skips the sensor warm-up frames, then
    // split=2 branches the scaled frame so both sizes come from the same settled
    // frame. (FFmpeg decodes from the first keyframe, discarding until frame N.)
    const warmup = WARMUP_FRAMES > 0 ? `select='gte(n,${WARMUP_FRAMES})',` : '';
    const ffmpeg = spawn(FFMPEG_PATH, [
        '-hide_banner', '-loglevel', 'error',
        '-f', videoCodec === 'H264' ? 'h264' : 'hevc',
        '-i', 'pipe:0',
        '-filter_complex',
            `[0:v]${warmup}scale='min(${MAX_WIDTH},iw)':-2,split=2[full][tmp];` +
            `[tmp]scale='min(${SMALL_WIDTH},iw)':-2[sm]`,
        '-map', '[full]', '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', '2', '-update', '1', '-y', tmpPath,
        '-map', '[sm]',   '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', String(SMALL_QUALITY), '-update', '1', '-y', smallTmp
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    let closed = false;
    let stderrTail = '';
    ffmpeg.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-300); });
    // FFmpeg exits after its one frame; later writes would hit a closed pipe
    ffmpeg.stdin.on('error', () => { /* EPIPE once FFmpeg is done */ });

    const done = new Promise((resolve) => {
        ffmpeg.on('error', (err) => {
            closed = true;
            utils.log(`❌ Snapshot grabber failed to start for ${serialNumber}: ${err.message}`, 'error');
            resolve(false);
        });
        ffmpeg.on('close', (code) => {
            closed = true;
            let size = 0, smallSize = 0;
            try { size = fs.statSync(tmpPath).size; } catch (e) { /* not written */ }
            try { smallSize = fs.statSync(smallTmp).size; } catch (e) { /* not written */ }
            if (code === 0 && size > 0) {
                try {
                    fs.renameSync(tmpPath, finalPath);
                    // Refresh the small derivative too. If it didn't come through,
                    // drop any stale <sn>.sm.jpg so loadSnapshotFromDisk falls back
                    // to the fresh master instead of serving the old thumbnail.
                    if (smallSize > 0) fs.renameSync(smallTmp, smallPath);
                    else { try { fs.unlinkSync(smallPath); } catch (e) { /* not there */ } }
                    utils.saveSnapshotDatetime(serialNumber);
                    resolve(true);
                    return;
                } catch (err) {
                    utils.log(`❌ Snapshot rename failed for ${serialNumber}: ${err.message}`, 'error');
                }
            } else if (code !== null) {
                utils.log(`⚠️ Snapshot grabber for ${serialNumber} produced no image (code ${code}): ${stderrTail.trim()}`, 'warn');
            }
            try { fs.unlinkSync(tmpPath); } catch (e) { /* not there */ }
            try { fs.unlinkSync(smallTmp); } catch (e) { /* not there */ }
            resolve(false);
        });
    });

    return {
        write(chunk) {
            if (closed || !chunk) return;
            try { ffmpeg.stdin.write(chunk); } catch (e) { /* pipe closed */ }
        },
        abort() {
            if (closed) return;
            try { ffmpeg.kill('SIGKILL'); } catch (e) { /* already gone */ }
        },
        done
    };
}

module.exports = { startGrabber };
