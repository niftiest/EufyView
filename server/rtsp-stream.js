/**
 * RTSP Fast Path
 *
 * Some eufy cameras (eufyCam 2C, indoor cams) can serve a local RTSP stream
 * straight off the HomeBase on the LAN. That stream is already H.264 + AAC, so
 * we can hand it to the browser (and grab thumbnails from it) with FFmpeg in
 * copy mode — no P2P, no transcode, and it doesn't occupy the station's single
 * P2P video slot. See docs/ARCHITECTURE.md "RTSP fast path".
 *
 * This module never turns RTSP on; that's an explicit per-camera choice
 * (device.set_rtsp). It only consumes an rtsp:// URL the station already gave us.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const utils = require('./utils');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const MAX_WIDTH = 1280;                         // thumbnails cap (match the P2P snapshot path)

/**
 * Live view: RTSP -> fragmented MP4, appendable to the browser's MediaSource.
 * Video and audio are copied (no re-encode). Returns the FFmpeg process; pipe
 * its stdout to the HTTP response and call stop() when the client goes away.
 * @param {string} rtspUrl
 * @returns {{ stdout: NodeJS.ReadableStream, stop: () => void }}
 */
function startRtspStream(rtspUrl) {
    const ff = spawn(FFMPEG_PATH, [
        '-hide_banner', '-loglevel', 'error',
        '-rtsp_transport', 'tcp',               // reliable over Wi-Fi (no UDP packet loss)
        '-fflags', 'nobuffer', '-flags', 'low_delay',
        '-i', rtspUrl,
        '-c', 'copy',                           // no transcode — the whole point
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-frag_duration', '500000',             // flush a fragment at least every 0.5s (low latency)
        '-flush_packets', '1',                  // push each packet to the pipe, don't buffer
        '-f', 'mp4', 'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrTail = '';
    ff.stderr.on('data', d => { stderrTail = (stderrTail + d.toString()).slice(-400); });
    ff.on('close', (code) => {
        if (code && code !== 255) utils.log(`⚠️ RTSP stream ffmpeg exited ${code}: ${stderrTail.trim()}`, 'warn');
    });
    ff.on('error', (err) => utils.log(`❌ RTSP stream failed to start: ${err.message}`, 'error'));

    return {
        stdout: ff.stdout,
        stop() { try { ff.kill('SIGKILL'); } catch (e) { /* already gone */ } }
    };
}

/**
 * Thumbnail: grab the first decodable frame off the RTSP stream as a JPEG.
 * Writes to a temp file and only replaces data/snapshots/<sn>.jpg once FFmpeg
 * actually produced an image (it can exit 0 having decoded nothing).
 * @param {string} serialNumber
 * @param {string} rtspUrl
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true once the snapshot file holds the new image
 */
function rtspSnapshot(serialNumber, rtspUrl, timeoutMs = 10000) {
    if (!fs.existsSync(utils.snapshotDir)) fs.mkdirSync(utils.snapshotDir, { recursive: true });
    const finalPath = path.join(utils.snapshotDir, `${serialNumber}.jpg`);
    const tmpPath = path.join(utils.snapshotDir, `${serialNumber}.rtsp-${process.pid}.tmp.jpg`);

    return new Promise((resolve) => {
        const ff = spawn(FFMPEG_PATH, [
            '-hide_banner', '-loglevel', 'error',
            '-rtsp_transport', 'tcp',
            '-i', rtspUrl,
            '-frames:v', '1',
            '-vf', `scale='min(${MAX_WIDTH},iw)':-2`,
            '-pix_fmt', 'yuvj420p', '-q:v', '2',
            '-update', '1', '-y', tmpPath
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        let stderrTail = '';
        let settled = false;
        const finish = (ok) => {
            if (settled) return; settled = true;
            clearTimeout(timer);
            if (!ok) { try { fs.unlinkSync(tmpPath); } catch (e) { /* not there */ } }
            resolve(ok);
        };
        const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (e) {} finish(false); }, timeoutMs);

        ff.stderr.on('data', d => { stderrTail = (stderrTail + d.toString()).slice(-300); });
        ff.on('error', (err) => { utils.log(`❌ RTSP snapshot failed to start for ${serialNumber}: ${err.message}`, 'error'); finish(false); });
        ff.on('close', (code) => {
            let size = 0;
            try { size = fs.statSync(tmpPath).size; } catch (e) { /* not written */ }
            if (code === 0 && size > 0) {
                try {
                    fs.renameSync(tmpPath, finalPath);
                    utils.saveSnapshotDatetime(serialNumber);
                    finish(true);
                    return;
                } catch (err) {
                    utils.log(`❌ RTSP snapshot rename failed for ${serialNumber}: ${err.message}`, 'error');
                }
            } else if (code !== null) {
                utils.log(`⚠️ RTSP snapshot for ${serialNumber} produced no image (code ${code}): ${stderrTail.trim()}`, 'warn');
            }
            finish(false);
        });
    });
}

module.exports = { startRtspStream, rtspSnapshot };
