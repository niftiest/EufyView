/**
 * Snapshot Grabber
 *
 * Turns one camera's raw livestream (H.264/H.265 straight from P2P) into a
 * thumbnail JPEG, independently of the live-view pipeline in transcode.js.
 * Each grabber owns a small FFmpeg process that decodes until the first
 * complete frame, writes it, and exits — no re-encoding, and several can run
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
const MAX_WIDTH = 1280;                 // thumbnails travel over WS as JSON byte arrays — keep them modest

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
    const tmpPath = path.join(utils.snapshotDir, `${serialNumber}.${process.pid}-${++tempSeq}.tmp.jpg`);

    const ffmpeg = spawn(FFMPEG_PATH, [
        '-hide_banner', '-loglevel', 'error',
        '-f', videoCodec === 'H264' ? 'h264' : 'hevc',
        '-i', 'pipe:0',
        '-frames:v', '1',               // first decodable frame (FFmpeg skips until a keyframe)
        '-vf', `scale='min(${MAX_WIDTH},iw)':-2`,   // live-view width cap, never upscale
        '-pix_fmt', 'yuvj420p',         // Full-range YUV for JPEG
        '-q:v', '2',                    // High quality JPEG
        '-update', '1',                 // Single image, not a sequence
        '-y', tmpPath
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
            let size = 0;
            try { size = fs.statSync(tmpPath).size; } catch (e) { /* not written */ }
            if (code === 0 && size > 0) {
                try {
                    fs.renameSync(tmpPath, finalPath);
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
